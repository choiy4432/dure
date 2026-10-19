import type { HistoryItem } from '../../engine/types'
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
// 엔진이 거절·취소·중단 때 도구 결과로 돌려주는 문구 (permissions.ts · engine.ts)
const DENY_TEXTS = new Set([
  '사용자가 거절했습니다.',
  '요청이 취소되었습니다.',
  '차례가 끝났습니다.',
  '사용자가 멈췄습니다.',
  'Claude 가 종료되었습니다.',
])
const RELAY_HEAD = /^\[두레 메시지 — 보낸 쪽: ([^\n]*?)\([^()\n]*\)\]\n?/

function stripRelay(text: string): { from: string; body: string } | null {
  const m = RELAY_HEAD.exec(text)
  if (!m) return null
  return { from: m[1], body: text.slice(m[0].length) }
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
                denied: r.isError && DENY_TEXTS.has(r.text),
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
