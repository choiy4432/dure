import fs from 'node:fs';
import path from 'node:path';
import type { AgentId, DiffHunk, HistoryItem } from './types';

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

/** 기록에 남기는 바뀐 줄 — 모두 합쳐 이만큼, 줄마다 이만큼(앞 기호 포함) */
const PATCH_LINES_MAX = 400;
const PATCH_LINE_MAX = 500;

/** 바뀐 줄을 기록용으로 줄인다 — 모두 합쳐 앞 400줄, 줄마다 500자. 넘친 묶음은 앞만, 그 뒤 묶음·빈 묶음은 버린다. 잘랐으면 cut */
export function capPatch(hunks: DiffHunk[]): { patch: DiffHunk[]; cut: boolean } {
  const patch: DiffHunk[] = [];
  let left = PATCH_LINES_MAX;
  let cut = false;
  for (const h of hunks) {
    if (h.lines.length === 0) continue;
    if (left === 0) {
      cut = true;
      break;
    }
    if (h.lines.length > left) cut = true;
    const lines = h.lines.slice(0, left).map((l) => {
      if (l.length <= PATCH_LINE_MAX) return l;
      cut = true;
      return l.slice(0, PATCH_LINE_MAX);
    });
    left -= lines.length;
    patch.push({ oldStart: h.oldStart, newStart: h.newStart, lines });
  }
  return { patch, cut };
}

/** 글을 줄로 — 빈 글은 줄이 없고, 끝 줄바꿈 하나는 빈 줄이 아니다 */
function linesOf(s: string): string[] {
  return s === '' ? [] : s.replace(/\r?\n$/, '').split(/\r?\n/);
}

/** old_string·new_string 한 쌍 → 옛 줄 전부 '-', 새 줄 전부 '+' 한 묶음(줄 번호 모름). 글이 아니거나 바뀐 줄이 없으면 null */
function hunkOf(e: unknown): DiffHunk | null {
  if (!e || typeof e !== 'object') return null;
  const { old_string: o, new_string: n } = e as Record<string, unknown>;
  if (typeof o !== 'string' || typeof n !== 'string') return null;
  const lines = [...linesOf(o).map((l) => `-${l}`), ...linesOf(n).map((l) => `+${l}`)];
  return lines.length > 0 ? { oldStart: null, newStart: null, lines } : null;
}

/**
 * 결과에 바뀐 줄이 없을 때(서브에이전트 줄 등) 하는 일 입력으로 만든 바뀐 줄 — Edit 은 old_string·new_string 한 묶음,
 * MultiEdit 은 edits 마다 한 묶음(못 읽는 것은 건너뛴다). 만들 수 없으면 null
 */
export function patchFromInput(name: string, input: unknown): DiffHunk[] | null {
  if (!input || typeof input !== 'object') return null;
  let hunks: (DiffHunk | null)[];
  if (name === 'Edit') hunks = [hunkOf(input)];
  else if (name === 'MultiEdit') {
    const edits = (input as Record<string, unknown>).edits;
    hunks = Array.isArray(edits) ? edits.map(hunkOf) : [];
  } else return null;
  const kept = hunks.filter((h): h is DiffHunk => h !== null);
  return kept.length > 0 ? kept : null;
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
