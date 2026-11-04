import type { HistoryItem } from './types';

/** 세션 id — 세션을 모르는 구간은 `seg:<구간 번호(0부터)>` */
export type ConversationKey = string;

export interface Conversation {
  key: ConversationKey;
  sessionId: string | null;
  /** 시간순, 경계 줄 없음 */
  items: HistoryItem[];
}

/**
 * 기록(경계 포함)을 대화별로 나눈다 — 처음 나타난 순서.
 * 구간 k 의 세션 = 마지막 구간이면 지금 세션 · 아니면 구간을 닫은 경계의 ended ?? 구간을 연 경계의 resumed ?? 모름.
 * (돌아간 대화를 Claude 가 다른 세션 id 로 이어 가면 그 구간은 resumed 가 아니라 지금·닫은 세션이다 — engine noteInit 이 init 의 id 를 저장한다)
 * 세션이 같은 구간은 처음 나타난 대화에 이어 붙인다(지난 대화로 돌아갔다 온 경우)
 */
export function splitConversations(items: HistoryItem[], currentSessionId: string): Conversation[] {
  const segs: { items: HistoryItem[]; opened?: string; closed?: string }[] = [{ items: [] }];
  for (const it of items) {
    if (it.kind === 'boundary') {
      segs[segs.length - 1].closed = it.ended;
      segs.push({ items: [], opened: it.resumed });
    } else segs[segs.length - 1].items.push(it);
  }
  const out: Conversation[] = [];
  const byKey = new Map<ConversationKey, Conversation>();
  segs.forEach((seg, k) => {
    if (!seg.items.length) return;
    const last = k === segs.length - 1;
    const sessionId = last ? currentSessionId : (seg.closed ?? seg.opened ?? null);
    const key = sessionId ?? `seg:${k}`;
    const had = byKey.get(key);
    if (had) had.items.push(...seg.items);
    else {
      const c: Conversation = { key, sessionId, items: [...seg.items] };
      byKey.set(key, c);
      out.push(c);
    }
  });
  return out;
}

export interface ConversationFacts {
  title: string;
  at: number;
  turns: number;
  lastReply: string;
}

/** 글 있는 첫 줄(앞뒤 공백 뺀) — 없으면 '' */
const firstLine = (s: string) => s.split('\n').map((l) => l.trim()).find((l) => l) ?? '';
const textOf = (parts: { type: string; text?: string }[]) =>
  parts.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('');

/** 목록에 보일 사실 — 사람 말·넘겨받은 말(user)이 없으면 null(목록에 안 나온다) */
export function conversationFacts(c: Conversation, senderName: (messageId: string) => string | null): ConversationFacts | null {
  const users = c.items.filter((i): i is Extract<HistoryItem, { kind: 'user' }> => i.kind === 'user');
  if (!users.length) return null;
  const first = users[0];
  const line = firstLine(textOf(first.parts));
  let title: string;
  if (!line) {
    // 글이 없으면 그림·첨부 수 — 둘 다면 '그림 1장 · 첨부 2개'
    const images = first.parts.filter((p) => p.type === 'image').length;
    const files = first.parts.filter((p) => p.type === 'file').length;
    title = [images > 0 ? `그림 ${images}장` : '', files > 0 ? `첨부 ${files}개` : ''].filter(Boolean).join(' · ');
  } else if (first.source === 'relay') {
    const from = first.messageId ? senderName(first.messageId) : null;
    title = from ? `${from}에게서 온 메시지: ${line}` : `받은 메시지: ${line}`;
  } else title = line;
  let lastReply = '';
  for (let i = c.items.length - 1; i >= 0; i--) {
    const it = c.items[i];
    if (it.kind === 'assistant' && !it.parent) {
      const line = firstLine(it.blocks.map((b) => (b.type === 'text' ? b.text : '')).join(''));
      if (line) { lastReply = line; break; } // 도구만 있는 답은 건너뛴다
    }
  }
  return { title, at: c.items[c.items.length - 1].t, turns: users.length, lastReply };
}
