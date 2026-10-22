import { useEffect, useRef, useState } from 'react'
import type { AgentId } from '../../engine/types'
import { todoCounts } from '../state/attention'
import { getStore, type UiState } from '../state/store'
import { announceAsk, announceMessage, askNotice, badgeText, finishedNotice, windowTitle } from './attentionText'

type NotifyFn = (title: string, o: { body: string; tag: string; onClick: () => void }) => void

export interface AttentionOpts {
  hasFocus?: () => boolean
  notify?: NotifyFn
  drawBadge?: (text: string) => string | null
}

const defaultHasFocus = () => typeof document !== 'undefined' && typeof document.hasFocus === 'function' && document.hasFocus()

/** Windows 알림 — 같은 tag 의 새 알림은 옛 것을 바꾼다. Notification 이 없는 환경에선 아무것도 안 한다 */
const defaultNotify: NotifyFn = (title, { body, tag, onClick }) => {
  try {
    if (typeof Notification === 'undefined') return
    const n = new Notification(title, { body, tag })
    n.onclick = onClick
  } catch {
    // 알림을 못 띄워도 앱은 그대로
  }
}

/** 작업표시줄 배지 그림 — 위험 색 원 + 흰 굵은 글. 캔버스가 없으면(jsdom 등) null */
function defaultDrawBadge(text: string): string | null {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 32
    canvas.height = 32
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--danger-solid').trim() || '#DC2626'
    ctx.beginPath()
    ctx.arc(16, 16, 16, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.font = 'bold 20px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, 16, 17)
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}

/** window.dure 호출 — 가짜·옛 preload 에 없어도 앱이 멈추지 않게 */
function call(fn: () => unknown) {
  try {
    void Promise.resolve(fn()).catch(() => {})
  } catch {
    // 없는 호출은 건너뛴다
  }
}

/**
 * 흘끗 보기 신호 — 창 제목 (N) · 작업표시줄 배지 · 깜박임 · Windows 알림 · 읽어 줄 글.
 * 스토어를 구독해 바뀐 것만 본다(그릴 때마다 돌지 않는다). 마지막 읽어 줄 글을 돌려준다.
 */
export function useAttention(opts: AttentionOpts = {}): string {
  const [announced, setAnnounced] = useState('')
  const optsRef = useRef(opts)
  optsRef.current = opts

  useEffect(() => {
    const store = getStore()
    const hasFocus = () => (optsRef.current.hasFocus ?? defaultHasFocus)()
    // 처음 스냅샷은 비동기로 온다 — 방이나 에이전트가 생긴 첫 상태가 그 스냅샷이다. 그 안의 요청·메시지·끝남은 이미 본 것으로 친다
    // (스토어에 '받았다' 표시가 없어 이 신호로 가른다. 안 그러면 앱을 켤 때 밀린 요청마다 깜박임·알림이 터진다)
    let baselined = false
    let seenRequests = new Set<string>()
    let seenMessages = new Set<string>()
    let seenFresh: Record<AgentId, number> = {}
    let lastTotal = -1
    let lastTitle = ''

    const syncTitle = (s: UiState, total: number) => {
      const title = windowTitle(total, s.rooms.find(r => r.id === s.roomId)?.name ?? null)
      if (title !== lastTitle) {
        lastTitle = title
        document.title = title
      }
      if (total !== lastTotal) {
        lastTotal = total
        const text = badgeText(total)
        const png = text ? (optsRef.current.drawBadge ?? defaultDrawBadge)(text) : null
        call(() => window.dure.setTaskbar(total, png))
      }
    }

    const open = (id: AgentId) => {
      call(() => window.dure.focusWindow())
      store.focusAgent(id)
    }

    const remember = (s: UiState) => {
      seenRequests = new Set(s.requests.map(r => r.id))
      seenMessages = new Set(s.messages.filter(m => m.state === 'pending').map(m => m.id))
      seenFresh = s.fresh
    }

    const run = () => {
      const s = store.getState()
      if (!baselined) {
        if (s.rooms.length === 0 && s.agents.length === 0) return
        baselined = true
        remember(s)
        syncTitle(s, todoCounts(s).total)
        return
      }
      syncTitle(s, todoCounts(s).total)

      const focused = hasFocus()
      const notify = optsRef.current.notify ?? defaultNotify
      const nameOf = (id: AgentId) => s.agents.find(a => a.id === id)?.name ?? id

      for (const r of s.requests) {
        if (seenRequests.has(r.id)) continue
        const agent = s.agents.find(a => a.id === r.agentId)
        if (!agent) continue // 에이전트가 없으면 누를 곳이 없다 — 세지도 않는다(todoCounts 와 같게)
        setAnnounced(announceAsk(r, agent.name))
        if (focused) continue
        call(() => window.dure.flashWindow())
        if (s.notify.asks) {
          const n = askNotice(r, agent)
          notify(n.title, { body: n.body, tag: `dure-${agent.id}`, onClick: () => open(agent.id) })
        }
      }
      for (const m of s.messages) {
        if (m.state === 'pending' && !seenMessages.has(m.id)) setAnnounced(announceMessage(nameOf(m.to)))
      }
      if (!focused && s.notify.asks && s.notify.finished) {
        for (const [id, t] of Object.entries(s.fresh)) {
          if (seenFresh[id] === t) continue
          const n = finishedNotice(nameOf(id), s.lastText[id]?.text ?? null)
          notify(n.title, { body: n.body, tag: `dure-${id}`, onClick: () => open(id) })
        }
      }
      remember(s)
    }

    run() // 이미 스냅샷이 온 뒤에 붙은 경우
    return store.subscribe(run)
  }, [])

  return announced
}
