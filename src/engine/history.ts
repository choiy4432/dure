import fs from 'node:fs';
import path from 'node:path';
import type { AgentId, HistoryItem } from './types';

/**
 * 기록에 남기는 하는 일 입력의 칸 — 화면(renderer lib/toolSummary.ts)이 읽는 것만. 거기서 새 칸을 읽으면 여기도 더한다.
 * 파일 본문·고칠 글·넘김 본문 같은 큰 값은 기록 파일을 키우기만 하고 화면엔 안 쓰인다.
 */
const KEPT_INPUT = ['file_path', 'notebook_path', 'command', 'pattern', 'url', 'query', 'description', 'to', 'skill'] as const;
/** 경로 칸 — 넘치면 끝(파일 이름)을 남긴다. 화면은 마지막 조각만 보인다 */
const PATH_INPUT = new Set<string>(['file_path', 'notebook_path']);
const INPUT_TEXT_MAX = 500;

/** 하는 일 입력을 기록용으로 줄인다 — 위 칸의 글 값만, 500자까지 */
export function trimToolInput(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input || typeof input !== 'object') return out;
  for (const key of KEPT_INPUT) {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v !== 'string') continue;
    out[key] = v.length <= INPUT_TEXT_MAX ? v : PATH_INPUT.has(key) ? v.slice(-INPUT_TEXT_MAX) : v.slice(0, INPUT_TEXT_MAX);
  }
  return out;
}

/** 파일이 줄바꿈으로 끝나지 않는가 — 크기와 마지막 한 바이트만 본다(없으면 false) */
function endsOpen(file: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
  try {
    const { size } = fs.fstatSync(fd);
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    fs.closeSync(fd);
  }
}

/** 서브에이전트 줄 — 부모의 Agent 하는 일 아래에서 온 assistant·tool-result */
const fromSubagent = (x: HistoryItem): boolean => (x.kind === 'assistant' || x.kind === 'tool-result') && typeof x.parent === 'string';

/**
 * 마지막 limit 개를 남길 때 자를 자리 — 서브에이전트 줄은 세지 않는다(서브에이전트가 많이 일해도 부모 대화가 잘리지 않게).
 * 남긴 첫 부모 기록 뒤의 서브에이전트 줄은 함께 남는다
 */
function cutFor(items: HistoryItem[], limit: number): number {
  if (limit <= 0) return items.length;
  let n = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    if (fromSubagent(items[i])) continue;
    if (++n >= limit) return i;
  }
  return 0;
}

export interface History {
  append(agentId: AgentId, item: HistoryItem): void;
  /**
   * 오래된 것부터. sinceBoundary(기본 true)면 마지막 boundary 뒤만, limit(기본 500)은 그 가운데 마지막 N 개 —
   * 서브에이전트 줄(parent)은 세지 않고 그 사이에 있으면 함께 돌려준다
   */
  read(agentId: AgentId, o?: { sinceBoundary?: boolean; limit?: number }): HistoryItem[];
  remove(agentId: AgentId): void;
}

export function openHistory(dataDir: string): History {
  const dir = path.join(dataDir, 'history');
  fs.mkdirSync(dir, { recursive: true });
  const fileOf = (id: AgentId) => path.join(dir, `${id}.jsonl`);
  const closed = new Set<AgentId>(); // 끊긴 마지막 줄을 줄바꿈으로 닫아 둔 파일

  return {
    append(agentId, item) {
      const file = fileOf(agentId);
      if (!closed.has(agentId)) {
        // 마지막 줄이 끊겨 있으면 새 기록이 그 줄에 붙지 않게 닫는다
        if (endsOpen(file)) fs.appendFileSync(file, '\n');
        closed.add(agentId);
      }
      fs.appendFileSync(file, `${JSON.stringify(item)}\n`);
    },
    read(agentId, { sinceBoundary = true, limit = 500 } = {}) {
      const file = fileOf(agentId);
      if (!fs.existsSync(file)) return [];
      let items: HistoryItem[] = [];
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          if (rec && typeof rec.kind === 'string' && typeof rec.t === 'number') items.push(rec as HistoryItem);
        } catch {
          // 깨진 줄은 건너뛴다
        }
      }
      if (sinceBoundary) {
        const i = items.map((x) => x.kind).lastIndexOf('boundary');
        if (i >= 0) items = items.slice(i + 1);
      }
      return items.slice(cutFor(items, limit));
    },
    remove(agentId) {
      closed.delete(agentId);
      fs.rmSync(fileOf(agentId), { force: true });
    },
  };
}
