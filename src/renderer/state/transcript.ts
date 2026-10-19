import type { HistoryItem } from '../../engine/types'
import { DENY_TEXTS } from '../../shared/denyTexts'
import { toolSummary, type ToolIcon } from '../lib/toolSummary'

export interface ActionLine {
  id: string
  verb: string
  target: string | null
  icon: ToolIcon
  allowed: boolean
  denied: boolean
  output: string
  pending?: boolean
}

export type ChatLine =
  | { kind: 'me'; text: string; images: number; at: number }
  | { kind: 'relay'; from: string; text: string; at: number }
  | { kind: 'claude'; text: string; actions: ActionLine[]; at: number }
  | { kind: 'notice'; text: string; at: number }
  | { kind: 'local'; text: string; at: number }
  | { kind: 'streaming'; text: string }

const OUTPUT_MAX = 2000
const RELAY_PREFIX = '[두레 메시지 — 보낸 쪽: '

// 첫 줄이 '[두레 메시지 — 보낸 쪽: 이름(역할)]' 이어야 한다. 이름 = 첫 '(' 앞이라 역할 안 괄호는 상관없다.
// 읽지 못하면 이름 없이 통째로 — 전달된 글이 '내 말'로 둔갑하지 않게.
function stripRelay(text: string): { from: string; body: string } {
  const nl = text.indexOf('\n')
  const first = nl === -1 ? text : text.slice(0, nl)
  if (first.startsWith(RELAY_PREFIX) && first.endsWith(')]')) {
    const inner = first.slice(RELAY_PREFIX.length, -1)
    const paren = inner.indexOf('(')
    if (paren !== -1) return { from: inner.slice(0, paren).trim(), body: nl === -1 ? '' : text.slice(nl + 1) }
  }
  return { from: '', body: text }
}

export function buildTranscript(
  items: HistoryItem[],
  streaming: string | undefined,
  limit = 300,
): { lines: ChatLine[]; hiddenBefore: number } {
  const results = new Map<string, Extract<HistoryItem, { kind: 'tool-result' }>>()
  for (const it of items) if (it.kind === 'tool-result') results.set(it.toolUseId, it)

  const all: ChatLine[] = []
  let cur: Extract<ChatLine, { kind: 'claude' }> | null = null
  const texts: string[] = []
  const flush = () => {
    if (cur) {
      cur.text = texts.join('\n\n')
      if (cur.text !== '' || cur.actions.length > 0) all.push(cur)
    }
    cur = null
    texts.length = 0
  }

  for (const it of items) {
    switch (it.kind) {
      case 'assistant': {
        if (!cur) cur = { kind: 'claude', text: '', actions: [], at: it.t }
        for (const b of it.blocks) {
          if (b.type === 'text') {
            if (b.text !== '') texts.push(b.text)
          } else {
            const s = toolSummary(b.name, b.input)
            const r = results.get(b.id)
            if (!r) {
              cur.actions.push({ id: b.id, ...s, allowed: false, denied: false, output: '', pending: true })
            } else {
              cur.actions.push({
                id: b.id,
                ...s,
                allowed: !r.viaApproval && !r.isError,
                denied: r.isError && DENY_TEXTS.includes(r.text),
                output: r.text.slice(0, OUTPUT_MAX),
              })
            }
          }
        }
        break
      }
      case 'tool-result':
        break
      case 'user': {
        flush()
        const text = it.parts
          .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
          .map((p) => p.text)
          .join('\n\n')
        const images = it.parts.filter((p) => p.type === 'image').length
        const relay = it.source === 'relay' ? stripRelay(text) : null
        if (relay) all.push({ kind: 'relay', from: relay.from, text: relay.body, at: it.t })
        else all.push({ kind: 'me', text, images, at: it.t })
        break
      }
      case 'notice':
        flush()
        all.push({ kind: 'notice', text: it.text, at: it.t })
        break
      case 'local-output':
        flush()
        all.push({ kind: 'local', text: it.text, at: it.t })
        break
      case 'result':
      case 'boundary':
        flush()
        break
    }
  }
  flush()

  const hiddenBefore = Math.max(0, all.length - limit)
  const lines = hiddenBefore > 0 ? all.slice(hiddenBefore) : all
  if (streaming) lines.push({ kind: 'streaming', text: streaming })
  return { lines, hiddenBefore }
}
