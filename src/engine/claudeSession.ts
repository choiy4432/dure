import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { parseLine, encodeUser, encodeControl } from './streamProtocol.js';
import { killTree } from './killTree.js';
import type { ControlRequest, SessionStatus, UserPart } from './types.js';

export interface SessionOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** 띄운 직후 다른 무엇보다 먼저 stdin 에 쓴다 — 서버 방의 머리말(MCP 설정·방 안내문, 명령 인자에 싣지 않으려고) */
  stdinPreamble?: string;
  /** stderr 조각을 받는 대로 — 서버 방이 DURE_PID 를 읽는다. 꼬리(errorText)는 그대로 모은다 */
  onStderr?: (chunk: string) => void;
  /**
   * 이 일이 끝난 뒤에 띄운다(서버 방 — 옛 claude 정리가 끝나야 같은 에이전트를 다시 띄운다). 그동안 실행 중으로 치고 쓴 줄은 모아 두었다가
   * 띄운 뒤 머리말 다음에 그대로. 그새 stop 하면 띄우지 않는다. 실패해도 띄운다
   */
  startAfter?: Promise<unknown>;
}

const STDERR_KEEP = 2048;
const STOP_TIMEOUT_MS = 3000;

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class ClaudeSession extends EventEmitter {
  private _status: SessionStatus = 'idle';
  private _errorText: string | null = null;
  private child: ChildProcess | null = null;
  private running = false;
  private stopping = false;
  private quietTurn = false; // send(quiet) 로 연 차례 — 그 result 까지 init 이 와도 작업 중으로 바꾸지 않는다
  private buf = '';
  private stderrTail = '';
  private pending = new Map<string, Pending>();
  private exited: Promise<void> = Promise.resolve();
  private queued: string[] | null = null; // 띄우기 전(startAfter)에 쓴 줄 — 띄운 뒤 머리말 다음에
  private dropGate: (() => void) | null = null; // 띄우기 전에 접는다(stop) — 띄우지 않고 끝낸다

  constructor(private opts: SessionOptions) {
    super();
  }

  get status(): SessionStatus {
    return this._status;
  }
  get errorText(): string | null {
    return this._errorText;
  }
  get pid(): number | undefined {
    return this.child?.pid;
  }

  private setStatus(s: SessionStatus): void {
    if (this._status === s) return;
    this._status = s;
    this.emit('status', s);
  }

  start(): void {
    if (!fs.existsSync(this.opts.cwd)) {
      this._errorText = `폴더를 찾을 수 없습니다: ${this.opts.cwd}`;
      this.setStatus('error');
      return;
    }
    if (this.opts.startAfter) return this.startAfter(this.opts.startAfter);
    this.spawnChild();
    this.setStatus('idle');
  }

  /** startAfter 가 끝날 때까지 띄우지 않는다 — 실행 중으로 치고 쓴 줄을 모은다. exited 는 띄운 claude 가 끝날 때(접으면 그때) */
  private startAfter(gate: Promise<unknown>): void {
    this.running = true;
    this.stopping = false;
    this._errorText = null;
    this.queued = [];
    this.exited = new Promise<void>((resolve) => {
      this.dropGate = () => {
        this.dropGate = null;
        this.queued = null;
        this.onExit(null);
        resolve();
      };
      const open = () => {
        if (!this.dropGate) return; // 그새 stop — 띄우지 않는다
        this.dropGate = null;
        try {
          this.spawnChild();
        } catch (e) {
          // 띄우지 못함 — 띄운 뒤 곧 죽은 것과 같게(예기치 않은 종료)
          this.queued = null;
          this.stderrTail += String(e instanceof Error ? e.message : e);
          this.onExit(null);
          resolve();
          return;
        }
        void this.exited.then(resolve);
      };
      gate.then(open, open);
    });
    this.setStatus('idle');
  }

  private spawnChild(): void {
    const child = spawn(this.opts.command, this.opts.args, {
      cwd: this.opts.cwd,
      env: this.opts.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.running = true;
    this.stopping = false;
    this._errorText = null;
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => this.onStdout(d));
    child.stderr!.on('data', (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-STDERR_KEEP);
      this.opts.onStderr?.(d);
    });
    child.stdin!.on('error', () => {});
    if (this.opts.stdinPreamble) child.stdin!.write(this.opts.stdinPreamble);
    const queued = this.queued;
    this.queued = null;
    for (const line of queued ?? []) child.stdin!.write(line);
    this.exited = new Promise<void>((resolve) => {
      let done = false;
      const finish = (code: number | null) => {
        if (done) return;
        done = true;
        this.onExit(code);
        resolve();
      };
      child.on('error', (e) => {
        this.stderrTail += String(e.message);
        finish(null);
      });
      child.on('close', (code) => finish(code));
    });
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      const ev = parseLine(line);
      if (!ev || ev.kind === 'ignored') continue;
      if (ev.kind === 'control-response') {
        const p = this.pending.get(ev.requestId);
        if (p) {
          this.pending.delete(ev.requestId);
          clearTimeout(p.timer);
          if (ev.ok) p.resolve(ev.payload);
          else p.reject(new Error('요청이 거부되었습니다'));
        }
      }
      // 쉬는 중에 온 init — 보낸 줄 없이 Claude 가 스스로 시작한 차례(서브에이전트가 끝난 뒤, probe13)도 작업 중이다.
      // 몰래 보낸 줄(send quiet)의 차례는 그 result 까지 상태를 바꾸지 않는다
      if (ev.kind === 'init' && this._status === 'idle' && !this.quietTurn) this.setStatus('working');
      if (ev.kind === 'result') {
        const quiet = this.quietTurn;
        this.quietTurn = false;
        if (!quiet && this._status === 'working') this.setStatus('idle');
      }
      this.emit('event', ev);
    }
  }

  private onExit(code: number | null): void {
    this.running = false;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('프로세스가 종료되었습니다'));
    }
    this.pending.clear();
    const expected = this.stopping;
    if (!expected) {
      this._errorText = this.stderrTail.trim() || `Claude 가 예기치 않게 종료됨(code ${code})`;
      this.setStatus('error');
    } else {
      this.setStatus('stopped');
    }
    this.emit('exit', { code, expected, stderrTail: this.stderrTail });
  }

  private write(line: string): void {
    if (this.queued) this.queued.push(line);
    else this.child?.stdin?.write(line);
  }

  /** quiet: 그 차례의 result 까지 상태를 working 으로 바꾸지 않는다 — 모델을 부르지 않는 로컬 명령(/effort)을 엔진이 몰래 보낼 때 */
  send(parts: UserPart[], o: { quiet?: boolean } = {}): void {
    if (!this.running) throw new Error('세션이 실행 중이 아닙니다');
    if (o.quiet) this.quietTurn = true;
    else this.setStatus('working');
    this.write(encodeUser(parts));
  }

  request(req: ControlRequest, timeoutMs = 15000): Promise<any> {
    if (!this.running) return Promise.reject(new Error('세션이 실행 중이 아닙니다'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('요청 시간이 초과되었습니다'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write(encodeControl(id, req));
    });
  }

  async interrupt(): Promise<void> {
    await this.request({ subtype: 'interrupt' });
  }

  /**
   * 끝낸다 — 입력을 닫고 STOP_TIMEOUT_MS 기다린 뒤에도 살아 있으면 프로세스 트리를 끈다.
   * now: 기다리지 않고 바로 끈다 — 입력을 닫으면 Claude 는 이미 써 둔 줄을 마저 읽고 끝나므로, 그 줄을 읽히지 않으려면(끼운 말 돌려받기, probe20)
   */
  async stop(o: { now?: boolean } = {}): Promise<void> {
    if (this.dropGate) {
      // 띄우기 전 — 띄우지 않고 멈춤으로 끝낸다
      this.stopping = true;
      this.dropGate();
      return;
    }
    if (!this.child || !this.running) {
      if (this._status !== 'error') this.setStatus('stopped');
      return;
    }
    this.stopping = true;
    if (!o.now) {
      this.child.stdin?.end();
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<'timeout'>((r) => {
        timer = setTimeout(() => r('timeout'), STOP_TIMEOUT_MS);
      });
      const r = await Promise.race([this.exited.then(() => 'exited' as const), timedOut]);
      clearTimeout(timer);
      if (r === 'exited') {
        this.setStatus('stopped');
        return;
      }
    }
    if (this.child.pid !== undefined) {
      await killTree(this.child.pid);
      await this.exited;
    }
    this.setStatus('stopped');
  }

  /**
   * 앱을 닫는데 stop() 이 상한 안에 못 끝났다(바쁜 PC 에서 taskkill 이 늦음) — 직접 끝내고 waitMs 까지만 기다린다.
   * 손자 프로세스는 stop() 이 시작한 taskkill /T 가 계속 정리한다.
   */
  async forceKill(waitMs: number): Promise<void> {
    if (!this.child || !this.running) return;
    try {
      this.child.kill();
    } catch {
      /* 이미 끝남 */
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.exited, new Promise<void>((r) => (timer = setTimeout(r, waitMs)))]);
    clearTimeout(timer);
  }
}
