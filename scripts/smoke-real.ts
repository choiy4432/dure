// 실제 claude 로 엔진을 점검한다. 사용: npm run smoke  (사용량을 아끼려 모든 에이전트는 haiku)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createEngine, locateClaude, authStatus } from '../src/engine';
import type { Engine, AgentId, StreamEvent } from '../src/engine';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let failures = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failures++;
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`FAIL ${name}: ${msg.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
}

/** 조건이 참이 될 때까지 기다린다 */
async function until(what: string, ms: number, cond: () => boolean): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(200);
  }
  throw new Error(`${Math.round(ms / 1000)}초 안에 ${what} 없음`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-smoke-'));
const dataDir = path.join(root, 'data');
const folder = (n: string) => {
  const p = path.join(root, n);
  fs.mkdirSync(p, { recursive: true });
  return p;
};
const folderA = folder('a');
const folderB = folder('b');
const folderC = folder('c');

type Seen = { agentId: AgentId; event: StreamEvent };
let seen: Seen[] = [];
let engine!: Engine;
const attach = (e: Engine) => {
  e.on('agent-event', (x: Seen) => seen.push(x));
};
const results = (id: AgentId) => seen.filter((s) => s.agentId === id && s.event.kind === 'result');
const resultText = (id: AgentId) => results(id).map((s) => (s.event as any).text as string).join('\n');

function listChildren(): Promise<{ pid: number; name: string }[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell',
      ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${process.pid}' | Select-Object ProcessId,Name | ConvertTo-Json`],
      { windowsHide: true, timeout: 30000 },
      (err, stdout) => {
        if (err) return reject(err);
        const t = String(stdout).trim();
        if (!t) return resolve([]);
        const j = JSON.parse(t);
        const arr = Array.isArray(j) ? j : [j];
        resolve(arr.map((x: any) => ({ pid: Number(x.ProcessId), name: String(x.Name) })));
      },
    );
  });
}

async function main() {
  const claudePath = locateClaude();
  let A!: AgentId, B!: AgentId;

  await step('locate', async () => {
    if (!claudePath) throw new Error('claude.exe 를 찾지 못함');
    const a = await authStatus(claudePath);
    if (!a.loggedIn) throw new Error('로그인되어 있지 않음');
  });
  if (!claudePath) return;

  engine = await createEngine({ dataDir, claude: { command: claudePath } });
  attach(engine);
  const room = engine.addRoom('smoke');
  A = engine.addAgent({ roomId: room.id, name: 'A', role: '기획', folder: folderA }).id;
  B = engine.addAgent({ roomId: room.id, name: 'B', role: '웹 화면', folder: folderB }).id;
  engine.updateAgent(A, { auto: false });
  engine.updateAgent(B, { auto: true });
  await engine.setModel(A, 'haiku');
  await engine.setModel(B, 'haiku');

  await step('handoff', async () => {
    await engine.sendUser(A, [{ type: 'text', text: "B 에게 '안녕 두레' 라고 전해 줘. mcp__dure__send_message 를 써. 다른 일은 하지 마." }]);
    await until('B 로 delivered 메시지', 120000, () => engine.messages().some((m) => m.to === B && m.state === 'delivered'));
    await until('B 의 result', 120000, () => results(B).length > 0);
  });

  await step('no-builtin', async () => {
    const used = seen
      .filter((s) => s.agentId === A && s.event.kind === 'assistant')
      .flatMap((s) => (s.event as any).blocks as { type: string; name?: string }[])
      .filter((b) => b.type === 'tool_use');
    if (used.some((b) => b.name === 'SendMessage')) throw new Error('A 가 내장 SendMessage 를 썼다');
    if (used.length === 0) throw new Error('A 의 tool_use 가 하나도 없음(점검 불가)');
  });

  await step('long-approve', async () => {
    const before = results(B).length;
    await engine.sendUser(B, [{ type: 'text', text: "note.txt 파일에 '두레' 라고 써 줘." }]);
    await until('B 의 승인 요청', 90000, () => engine.pendingRequests(B).length > 0);
    await sleep(150000);
    const req = engine.pendingRequests(B)[0];
    if (!req) throw new Error('150초 기다리는 사이 승인 요청이 사라짐(끊김)');
    engine.answerRequest(req.id, { type: 'allow' });
    await until('B 의 result', 90000, () => results(B).length > before);
    const f = path.join(folderB, 'note.txt');
    if (!fs.existsSync(f)) throw new Error('note.txt 가 만들어지지 않음');
    if (!fs.readFileSync(f, 'utf8').includes('두레')) throw new Error('note.txt 에 "두레" 가 없음');
  });

  await step('resume', async () => {
    await engine.shutdown();
    engine = await createEngine({ dataDir, claude: { command: claudePath } });
    attach(engine);
    const before = results(A).length;
    await engine.sendUser(A, [{ type: 'text', text: '방금 B 에게 보낸 말을 그대로 한 줄로 말해 줘.' }]);
    await until('A 의 result', 90000, () => results(A).length > before);
    const t = results(A).slice(before).map((s) => (s.event as any).text as string).join('\n');
    if (!t.includes('안녕 두레')) throw new Error('result 에 "안녕 두레" 가 없음');
  });

  await step('describe-then-send', async () => {
    const C = engine.addAgent({ roomId: room.id, name: '점검', role: '점검용', folder: folderC }).id;
    await engine.setModel(C, 'haiku');
    const d = await engine.describe(C);
    if (!(d.commands.length > 0)) throw new Error('commands 가 비어 있음');
    if (!(d.models.length > 0)) throw new Error('models 가 비어 있음');
    if ('account' in (d as object)) throw new Error('describe 결과에 account 키가 있음');
    await engine.sendUser(C, [{ type: 'text', text: '한 단어로 대답해: 안녕' }]);
    await until('C 의 result', 60000, () => results(C).length > 0);
  });

  const pids: number[] = [];
  await step('cleanup', async () => {
    const kids = await listChildren();
    const others = kids.filter((k) => !/^claude(\.exe)?$/i.test(k.name)).map((k) => k.name);
    if (others.length) console.log(`INFO other children: ${[...new Set(others)].join(',')}`);
    for (const k of kids) if (/^claude(\.exe)?$/i.test(k.name)) pids.push(k.pid);
    if (pids.length === 0) throw new Error('claude.exe 자식 프로세스를 찾지 못함(목록이 안 됨)');
    await engine.shutdown();
    await sleep(2000);
    const alive = pids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (alive.length) throw new Error(`아직 살아 있는 프로세스 ${alive.length}개`);
  });
}

main()
  .catch((e) => {
    failures++;
    console.log(`FAIL main: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`);
  })
  .finally(async () => {
    try {
      await engine?.shutdown();
    } catch {
      /* 무시 */
    }
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    process.exit(failures);
  });
