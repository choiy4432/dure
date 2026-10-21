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
  private buf = '';
  private stderrTail = '';
  private pending = new Map<string, Pending>();
  private exited: Promise<void> = Promise.resolve();

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
    });
    child.stdin!.on('error', () => {});
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
    this.setStatus('idle');
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
      if (ev.kind === 'result' && this._status === 'working') this.setStatus('idle');
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
    this.child?.stdin?.write(line);
  }

  /** quiet: 상태를 working 으로 바꾸지 않는다 — 모델을 부르지 않는 로컬 명령(/effort)을 엔진이 몰래 보낼 때 */
  send(parts: UserPart[], o: { quiet?: boolean } = {}): void {
    if (!this.running) throw new Error('세션이 실행 중이 아닙니다');
    if (!o.quiet) this.setStatus('working');
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

  async stop(): Promise<void> {
    if (!this.child || !this.running) {
      if (this._status !== 'error') this.setStatus('stopped');
      return;
    }
    this.stopping = true;
    this.child.stdin?.end();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((r) => {
      timer = setTimeout(() => r('timeout'), STOP_TIMEOUT_MS);
    });
    const r = await Promise.race([this.exited.then(() => 'exited' as const), timedOut]);
    clearTimeout(timer);
    if (r === 'timeout' && this.child.pid !== undefined) {
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
