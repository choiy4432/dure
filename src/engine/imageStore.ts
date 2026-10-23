import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentId } from './types';

// 사람이 보낸 그림 — 다시 볼 수 있게 에이전트마다 한 칸(images/<에이전트>/)에 둔다. 기록에는 파일 이름만 남는다

/** 형식 ↔ 확장자 — 입력창이 받는 넷(renderer lib/image IMAGE_TYPES)과 같다 */
const EXT_OF: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const TYPE_OF: Record<string, string> = Object.fromEntries(Object.entries(EXT_OF).map(([t, e]) => [e, t]));

/** 저장한 이름의 모양 — 내용 해시 32자 + 아는 확장자. 이 모양이 아니면 읽지 않는다(경로를 타고 칸 밖으로 못 나간다) */
const FILE_RE = /^[0-9a-f]{32}\.(png|jpg|webp|gif)$/;
/** 에이전트 칸 이름 — 가게(store)가 만든 id 모양만 */
const AGENT_RE = /^[A-Za-z0-9-]+$/;

export interface ImageStore {
  /** 그림을 그 에이전트 칸에 저장하고 파일 이름을 돌려준다 — 같은 그림은 한 파일. 모르는 형식이면 null */
  save(agentId: AgentId, mediaType: string, base64: string): string | null;
  /** 저장한 그림 — 이름 모양이 틀리거나 없으면 null */
  read(agentId: AgentId, file: string): { mediaType: string; base64: string } | null;
  /** 그 에이전트의 그림 칸을 통째로 지운다 */
  remove(agentId: AgentId): void;
}

export function openImageStore(dataDir: string): ImageStore {
  const root = path.join(dataDir, 'images');
  const dirOf = (id: AgentId) => (AGENT_RE.test(id) ? path.join(root, id) : null);

  return {
    save(agentId, mediaType, base64) {
      const ext = EXT_OF[mediaType];
      const dir = dirOf(agentId);
      if (!ext || !dir) return null;
      const bytes = Buffer.from(base64, 'base64');
      const file = `${crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.${ext}`;
      const full = path.join(dir, file);
      if (!fs.existsSync(full)) {
        fs.mkdirSync(dir, { recursive: true });
        // 쓰다 끊겨도 반쪽 파일이 그 이름으로 남지 않게 — 다 쓴 뒤 이름을 바꾼다
        const tmp = `${full}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, bytes);
        fs.renameSync(tmp, full);
      }
      return file;
    },
    read(agentId, file) {
      const dir = dirOf(agentId);
      if (!dir || !FILE_RE.test(file)) return null;
      const full = path.join(dir, file);
      if (!fs.existsSync(full)) return null;
      return { mediaType: TYPE_OF[file.slice(file.lastIndexOf('.') + 1)], base64: fs.readFileSync(full).toString('base64') };
    },
    remove(agentId) {
      const dir = dirOf(agentId);
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
