import fs from 'node:fs';
import path from 'node:path';
import type { AgentId, HistoryItem } from './types';

export interface History {
  append(agentId: AgentId, item: HistoryItem): void;
  /** 오래된 것부터. sinceBoundary(기본 true)면 마지막 boundary 뒤만, limit(기본 500)은 그 가운데 마지막 N 개 */
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
        if (fs.existsSync(file)) {
          const text = fs.readFileSync(file, 'utf8');
          if (text.length > 0 && !text.endsWith('\n')) fs.appendFileSync(file, '\n');
        }
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
      return limit < items.length ? items.slice(items.length - limit) : items;
    },
    remove(agentId) {
      closed.delete(agentId);
      fs.rmSync(fileOf(agentId), { force: true });
    },
  };
}
