// 휴대폰 서비스 워커(src/renderer/public/sw.js) — 가짜 self 위에서 돌려 처리기만 본다
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const CODE = fs.readFileSync(path.join(__dirname, '../src/renderer/public/sw.js'), 'utf8')

type Handler = (e: Record<string, unknown>) => void
function load(o: { windows?: { url: string; focus: () => Promise<unknown>; postMessage: (m: unknown) => void }[] } = {}) {
  const handlers: Record<string, Handler> = {}
  const self = {
    location: { origin: 'https://pc.tail.ts.net' },
    addEventListener: (name: string, fn: Handler) => { handlers[name] = fn },
    skipWaiting: vi.fn(async () => {}),
    clients: {
      claim: vi.fn(async () => {}),
      matchAll: vi.fn(async () => o.windows ?? []),
      openWindow: vi.fn(async () => null),
    },
    registration: { showNotification: vi.fn(async () => {}) },
  }
  vm.runInNewContext(CODE, { self, URL, JSON, Promise })
  /** 사건을 보내고 waitUntil 에 맡긴 일을 기다린다 */
  const fire = async (name: string, e: Record<string, unknown> = {}) => {
    const waits: Promise<unknown>[] = []
    handlers[name]({ ...e, waitUntil: (p: Promise<unknown>) => waits.push(p) })
    await Promise.all(waits)
  }
  return { self, fire, handlers }
}
const data = (v: unknown) => ({ json: () => (typeof v === 'string' ? JSON.parse(v) : v), text: () => JSON.stringify(v) })

describe('sw.js — 휴대폰 알림 서비스 워커', () => {
  it('install → skipWaiting · activate → clients.claim(새 판이 바로 알림을 맡는다)', async () => {
    const { self, fire } = load()
    await fire('install')
    expect(self.skipWaiting).toHaveBeenCalledTimes(1)
    await fire('activate')
    expect(self.clients.claim).toHaveBeenCalledTimes(1)
  })

  it('push → showNotification(제목·본문·tag·renotify·아이콘·badge·진동·누르면 열 곳)', async () => {
    const { self, fire } = load()
    await fire('push', { data: data({ title: '두레', body: '백엔드 · 승인을 기다려요', tag: 'dure-a1-ask-3', url: '/#agent=a1' }) })
    expect(self.registration.showNotification).toHaveBeenCalledWith('두레', {
      body: '백엔드 · 승인을 기다려요',
      tag: 'dure-a1-ask-3',
      renotify: true,
      icon: '/icons/dure-192.png',
      badge: '/icons/dure-badge-96.png',
      vibrate: [120, 60, 120],
      data: { url: '/#agent=a1' },
    })
  })

  it('push — 글이 깨졌거나 없어도 알림은 띄운다(크롬은 조용한 푸시를 막는다) · 다른 곳 주소는 안 받음', async () => {
    const { self, fire } = load()
    await fire('push', { data: { json: () => { throw new Error('bad') } } })
    await fire('push', {})
    await fire('push', { data: data({ title: '두레', body: 'x', tag: 't', url: 'https://evil.example/' }) })
    const calls = self.registration.showNotification.mock.calls as unknown as [string, { body: string; tag: string; data: { url: string } }][]
    expect(calls).toHaveLength(3)
    expect(calls[0][0]).toBe('두레')
    expect(calls[0][1].body).toBe('확인할 일이 있어요')
    expect(calls[0][1].data.url).toBe('/mobile.html')
    expect(calls[2][1].data.url).toBe('/mobile.html')
  })

  it('notificationclick — 열린 두레 창이 있으면 앞으로 + 그 대화로(다시 읽지 않음), 없으면 새로 열기', async () => {
    const focus = vi.fn(async () => {})
    const postMessage = vi.fn()
    const close = vi.fn()
    const { self, fire } = load({ windows: [{ url: 'https://pc.tail.ts.net/mobile.html', focus, postMessage }] })
    await fire('notificationclick', { notification: { close, data: { url: '/#agent=a1' } } })
    expect(close).toHaveBeenCalled()
    expect(focus).toHaveBeenCalled()
    expect(postMessage).toHaveBeenCalledWith({ type: 'dure:open', url: 'https://pc.tail.ts.net/#agent=a1' })
    expect(self.clients.openWindow).not.toHaveBeenCalled()

    const none = load({ windows: [] })
    await none.fire('notificationclick', { notification: { close, data: { url: '/#agent=a2' } } })
    expect(none.self.clients.openWindow).toHaveBeenCalledWith('https://pc.tail.ts.net/#agent=a2')
  })
})
