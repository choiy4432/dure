import { describe, it, expect, vi } from 'vitest'
import { checkMe, meInfo, pairWith, subscribePush, PAIR_OFFLINE } from '../../src/renderer/mobile/phoneHttp'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const BASE = 'https://pc.tail.ts.net'

describe('phoneHttp — 짝 맺기·짝 여부·알림 구독(HTTP 길)', () => {
  it('checkMe — 200 짝 맺음 · 401 안 맺음 · 그 밖(끊김·503) 모름', async () => {
    const f = vi.fn(async () => json(200, { ok: true, device: { id: 'd' } }))
    expect(await checkMe({ base: BASE, fetch: f as unknown as typeof fetch })).toBe('paired')
    expect(f).toHaveBeenCalledWith(`${BASE}/api/me`, expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }))
    expect(await checkMe({ base: BASE, fetch: (async () => json(401, { ok: false, error: '짝을 맺어 주세요' })) as unknown as typeof fetch })).toBe('unpaired')
    expect(await checkMe({ base: BASE, fetch: (async () => json(503, { ok: false, error: 'x' })) as unknown as typeof fetch })).toBe('unknown')
    expect(await checkMe({ base: BASE, fetch: (async () => { throw new TypeError('x') }) as unknown as typeof fetch })).toBe('unknown')
  })

  it('pairWith — POST { secret, name } · 400 틀림 · 410 지남 · 429 막힘 · 끊김', async () => {
    const f = vi.fn(async (_u: unknown, _o?: RequestInit) => json(200, { ok: true, device: { id: 'd' } }))
    expect(await pairWith('482017', '내 휴대폰', { base: BASE, fetch: f as unknown as typeof fetch })).toEqual({ ok: true })
    const [u, init] = f.mock.calls[0]
    expect(u).toBe(`${BASE}/api/pair`)
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin' })
    expect(JSON.parse(String(init!.body))).toEqual({ secret: '482017', name: '내 휴대폰' })

    const as = (status: number, error: string) => pairWith('1', 'x', { base: BASE, fetch: (async () => json(status, { ok: false, error })) as unknown as typeof fetch })
    expect(await as(400, '짝 코드나 숫자가 맞지 않아요')).toEqual({ ok: false, kind: 'wrong', error: '짝 코드나 숫자가 맞지 않아요' })
    expect(await as(410, '짝 코드가 지났어요')).toMatchObject({ ok: false, kind: 'expired' })
    expect(await as(429, '여러 번 틀려서 잠깐 막았어요 — 1분 뒤에 다시 해 주세요')).toEqual({ ok: false, kind: 'locked', error: '여러 번 틀려서 잠깐 막았어요 — 1분 뒤에 다시 해 주세요' })
    expect(await as(500, '짝을 맺지 못했어요 — 다시 해 주세요')).toEqual({ ok: false, kind: 'other', error: '짝을 맺지 못했어요 — 다시 해 주세요' })
    const off = await pairWith('1', 'x', { base: BASE, fetch: (async () => { throw new TypeError('Failed to fetch') }) as unknown as typeof fetch })
    expect(off).toEqual({ ok: false, kind: 'offline', error: PAIR_OFFLINE })
  })

  it('subscribePush — 열쇠가 다른 옛 구독은 지우고 다시 · /api/subscribe 로 올림', async () => {
    // 'BAEC' = base64url [4, 1, 2]
    const unsubscribe = vi.fn(async () => true)
    const old = { options: { applicationServerKey: new Uint8Array([9, 9]).buffer }, unsubscribe, toJSON: () => ({ endpoint: 'old' }) }
    const fresh = { options: { applicationServerKey: new Uint8Array([4, 1, 2]).buffer }, unsubscribe: vi.fn(), toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'p', auth: 'a' } }) }
    const subscribe = vi.fn(async (o: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
      expect(o.userVisibleOnly).toBe(true)
      expect([...o.applicationServerKey]).toEqual([4, 1, 2])
      return fresh
    })
    const reg = { pushManager: { getSubscription: vi.fn(async () => old), subscribe } }
    const requestPermission = vi.fn(async () => 'granted' as NotificationPermission)
    const f = vi.fn(async (u: unknown, _o?: RequestInit) => (String(u).endsWith('/api/vapid') ? json(200, { ok: true, publicKey: 'BAEC' }) : json(200, { ok: true })))
    const r = await subscribePush({ base: BASE, fetch: f as unknown as typeof fetch, notification: { permission: 'default', requestPermission }, registration: async () => reg as unknown as ServiceWorkerRegistration })
    expect(r).toBe('on')
    expect(requestPermission).toHaveBeenCalledTimes(1)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    const post = f.mock.calls.find(c => String(c[0]).endsWith('/api/subscribe'))!
    expect(post[1]).toMatchObject({ method: 'POST', credentials: 'same-origin' })
    expect(JSON.parse(String(post[1]!.body))).toEqual({ subscription: fresh.toJSON() })
  })

  it('subscribePush — 같은 열쇠의 구독은 그대로 다시 올림 · 막혔으면 denied · 못 쓰면 unsupported · 실패 failed', async () => {
    const same = { options: { applicationServerKey: new Uint8Array([4, 1, 2]).buffer }, unsubscribe: vi.fn(), toJSON: () => ({ endpoint: 'e' }) }
    const subscribe = vi.fn()
    const reg = { pushManager: { getSubscription: async () => same, subscribe } }
    const f = vi.fn(async (u: unknown) => (String(u).endsWith('/api/vapid') ? json(200, { ok: true, publicKey: 'BAEC' }) : json(200, { ok: true })))
    const granted = { permission: 'granted' as NotificationPermission, requestPermission: vi.fn() }
    expect(await subscribePush({ base: BASE, fetch: f as unknown as typeof fetch, notification: granted, registration: async () => reg as unknown as ServiceWorkerRegistration })).toBe('on')
    expect(subscribe).not.toHaveBeenCalled()
    expect(same.unsubscribe).not.toHaveBeenCalled()
    expect(granted.requestPermission).not.toHaveBeenCalled()

    const denied = { permission: 'default' as NotificationPermission, requestPermission: async () => 'denied' as NotificationPermission }
    expect(await subscribePush({ base: BASE, fetch: f as unknown as typeof fetch, notification: denied, registration: async () => reg as unknown as ServiceWorkerRegistration })).toBe('denied')
    expect(await subscribePush({ base: BASE, fetch: f as unknown as typeof fetch, notification: null, registration: async () => reg as unknown as ServiceWorkerRegistration })).toBe('unsupported')
    const badPost = vi.fn(async (u: unknown) => (String(u).endsWith('/api/vapid') ? json(200, { ok: true, publicKey: 'BAEC' }) : json(400, { ok: false, error: 'x' })))
    expect(await subscribePush({ base: BASE, fetch: badPost as unknown as typeof fetch, notification: granted, registration: async () => reg as unknown as ServiceWorkerRegistration })).toBe('failed')
    expect(await subscribePush({ base: BASE, fetch: f as unknown as typeof fetch, notification: granted, registration: async () => { throw new Error('no sw') } })).toBe('failed')
  })

  it('subscribePush fresh — 열쇠가 같아도 옛 구독(크롬 탭·웹앱이 만든 것)을 지우고 새로 구독해 올림', async () => {
    const same = { options: { applicationServerKey: new Uint8Array([4, 1, 2]).buffer }, unsubscribe: vi.fn(async () => true), toJSON: () => ({ endpoint: 'old' }) }
    const made = { options: { applicationServerKey: new Uint8Array([4, 1, 2]).buffer }, unsubscribe: vi.fn(), toJSON: () => ({ endpoint: 'new' }) }
    const subscribe = vi.fn(async () => made)
    const reg = { pushManager: { getSubscription: async () => same, subscribe } }
    const f = vi.fn(async (u: unknown, _o?: RequestInit) => (String(u).endsWith('/api/vapid') ? json(200, { ok: true, publicKey: 'BAEC' }) : json(200, { ok: true })))
    const granted = { permission: 'granted' as NotificationPermission, requestPermission: vi.fn() }
    expect(await subscribePush({ base: BASE, fetch: f as unknown as typeof fetch, notification: granted, registration: async () => reg as unknown as ServiceWorkerRegistration, fresh: true })).toBe('on')
    expect(same.unsubscribe).toHaveBeenCalledTimes(1)
    expect(subscribe).toHaveBeenCalledTimes(1)
    const post = f.mock.calls.find(c => String(c[0]).endsWith('/api/subscribe'))!
    expect(JSON.parse(String(post[1]!.body))).toEqual({ subscription: { endpoint: 'new' } })
    // 구독이 없으면 그냥 새로
    const none = { pushManager: { getSubscription: async () => null, subscribe: vi.fn(async () => made) } }
    expect(await subscribePush({ base: BASE, fetch: f as unknown as typeof fetch, notification: granted, registration: async () => none as unknown as ServiceWorkerRegistration, fresh: true })).toBe('on')
    expect(none.pushManager.subscribe).toHaveBeenCalledTimes(1)
  })

  it('meInfo — 이 휴대폰과 PC 가 내어 줄 안드로이드 앱(판·패키지) · 없으면 null · 짝 안 맺음·끊김은 null', async () => {
    const device = { id: 'd', name: '내 휴대폰', createdAt: 1, lastSeen: 1, push: false }
    const androidApp = { versionCode: 3, packageName: 'io.github.choiy4432.dure' }
    expect(await meInfo({ base: BASE, fetch: (async () => json(200, { ok: true, device, androidApp })) as unknown as typeof fetch })).toEqual({ device, androidApp })
    expect(await meInfo({ base: BASE, fetch: (async () => json(200, { ok: true, device, androidApp: null })) as unknown as typeof fetch })).toEqual({ device, androidApp: null })
    // 옛 PC 두레(androidApp 칸 없음) · 꼴이 틀린 칸은 앱 없음으로
    expect(await meInfo({ base: BASE, fetch: (async () => json(200, { ok: true, device })) as unknown as typeof fetch })).toEqual({ device, androidApp: null })
    expect(await meInfo({ base: BASE, fetch: (async () => json(200, { ok: true, device, androidApp: { versionCode: '3', packageName: 'x' } })) as unknown as typeof fetch })).toEqual({ device, androidApp: null })
    expect(await meInfo({ base: BASE, fetch: (async () => json(401, { ok: false, error: 'x' })) as unknown as typeof fetch })).toBeNull()
    expect(await meInfo({ base: BASE, fetch: (async () => { throw new TypeError('x') }) as unknown as typeof fetch })).toBeNull()
  })
})
