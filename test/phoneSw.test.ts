// 휴대폰 서비스 워커(src/renderer/public/sw.js) — 가짜 self 위에서 돌려 처리기만 본다
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const CODE = fs.readFileSync(path.join(__dirname, '../src/renderer/public/sw.js'), 'utf8')
const ORIGIN = 'https://pc.tail.ts.net'

type Handler = (e: Record<string, unknown>) => void
type Win = { url: string; focus: () => Promise<unknown>; postMessage: (m: unknown) => void }
type FakeReq = { url: string; method: string; mode: string }

/** 가짜 Cache Storage — 이름마다 경로 → Response */
function fakeCaches(fetchFn: (u: string) => Promise<Response>) {
  const store = new Map<string, Map<string, Response>>()
  const pathOf = (u: string | FakeReq) => new URL(typeof u === 'string' ? u : u.url, ORIGIN).pathname
  const open = vi.fn(async (name: string) => {
    if (!store.has(name)) store.set(name, new Map())
    const c = store.get(name)!
    return {
      addAll: vi.fn(async (urls: string[]) => {
        const got: [string, Response][] = []
        for (const u of urls) {
          const r = await fetchFn(u)
          if (!r.ok) throw new TypeError('bad status')
          got.push([pathOf(u), r])
        }
        for (const [k, r] of got) c.set(k, r)
      }),
      match: vi.fn(async (u: string | FakeReq) => c.get(pathOf(u))?.clone()),
    }
  })
  return {
    store,
    open,
    keys: vi.fn(async () => [...store.keys()]),
    delete: vi.fn(async (name: string) => store.delete(name)),
  }
}

function load(o: { windows?: Win[]; fetch?: (u: string | FakeReq, init?: RequestInit) => Promise<Response> } = {}) {
  const handlers: Record<string, Handler> = {}
  const fetchFn = vi.fn(o.fetch ?? (async () => new Response('ok', { status: 200 })))
  const caches = fakeCaches(u => fetchFn(u))
  const subscribe = vi.fn(async (_o: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => ({ toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/new' }) }))
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (name: string, fn: Handler) => { handlers[name] = fn },
    skipWaiting: vi.fn(async () => {}),
    clients: {
      claim: vi.fn(async () => {}),
      matchAll: vi.fn(async () => o.windows ?? []),
      openWindow: vi.fn(async () => null),
    },
    registration: { showNotification: vi.fn(async () => {}), pushManager: { subscribe } },
  }
  // 시계는 바깥 것을 그대로 — 시험이 가짜 시계로 바꾸면 sw 의 기다림도 따라간다
  const ctx = { self, URL, JSON, Promise, Response, Date, atob, fetch: fetchFn, caches, setTimeout: (f: () => void, ms: number) => setTimeout(f, ms), clearTimeout: (t: ReturnType<typeof setTimeout>) => clearTimeout(t) }
  vm.runInNewContext(CODE, ctx)
  /** 사건을 보내고 waitUntil 에 맡긴 일을 기다린다 */
  const fire = async (name: string, e: Record<string, unknown> = {}) => {
    const waits: Promise<unknown>[] = []
    handlers[name]({ ...e, waitUntil: (p: Promise<unknown>) => waits.push(p) })
    await Promise.all(waits)
  }
  /** fetch 사건이 waitUntil 에 맡긴 뒷일(오프라인 화면 새로 받기) — 시험이 기다린다 */
  const background: Promise<unknown>[] = []
  /** fetch 사건 — respondWith 로 준 답(안 주면 null: 브라우저가 늘 하던 대로 받는다) */
  const request = (url: string, init: Partial<FakeReq> = {}): Promise<Response> | null => {
    let responded: Promise<Response> | null = null
    const req: FakeReq = { url: new URL(url, ORIGIN).href, method: 'GET', mode: 'cors', ...init }
    handlers.fetch({
      request: req,
      respondWith: (p: Promise<Response>) => { responded = Promise.resolve(p) },
      waitUntil: (p: Promise<unknown>) => { background.push(p) },
    })
    return responded
  }
  return { self, fire, handlers, fetch: fetchFn, caches, subscribe, request, background }
}
afterEach(() => {
  vi.useRealTimers()
})
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

  it('notificationclick — 창을 앞으로 꺼내지 못하면(focus 가 거절) 그 주소로 새로 연다', async () => {
    const focus = vi.fn(async () => {
      throw new Error('InvalidAccessError')
    })
    const postMessage = vi.fn()
    const { self, fire } = load({ windows: [{ url: `${ORIGIN}/mobile.html`, focus, postMessage }] })
    await fire('notificationclick', { notification: { close: vi.fn(), data: { url: '/#agent=a1' } } })
    expect(focus).toHaveBeenCalled()
    expect(postMessage).not.toHaveBeenCalled()
    expect(self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/#agent=a1`)
  })

  it('pushsubscriptionchange — 공개 열쇠를 다시 받아(/api/vapid) 새로 구독하고 PC 에 올린다(/api/subscribe)', async () => {
    // 'BAEC' = base64url [4, 1, 2]
    const fetchFn = vi.fn(async (u: string | FakeReq, _init?: RequestInit) =>
      String(u).endsWith('/api/vapid') ? Response.json({ ok: true, publicKey: 'BAEC' }) : Response.json({ ok: true }))
    const { fire, subscribe, fetch } = load({ fetch: fetchFn })
    await fire('pushsubscriptionchange', {})
    expect(subscribe).toHaveBeenCalledTimes(1)
    const opts = subscribe.mock.calls[0][0]
    expect(opts.userVisibleOnly).toBe(true)
    expect([...opts.applicationServerKey]).toEqual([4, 1, 2])
    const post = fetch.mock.calls.find(c => String(c[0]).endsWith('/api/subscribe'))!
    expect(post[1]).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' } })
    expect(JSON.parse(String(post[1]!.body))).toEqual({ subscription: { endpoint: 'https://fcm.googleapis.com/new' } })
    expect(String(fetch.mock.calls[0][0])).toBe('/api/vapid')
    expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: 'same-origin', cache: 'no-store' })
  })

  it('pushsubscriptionchange — 브라우저가 새 구독을 주면 그것을 올린다 · 열쇠를 못 받으면 조용히 그만', async () => {
    const fetchFn = vi.fn(async (_u: string | FakeReq, _init?: RequestInit) => Response.json({ ok: true }))
    const a = load({ fetch: fetchFn })
    await a.fire('pushsubscriptionchange', { newSubscription: { toJSON: () => ({ endpoint: 'given' }) } })
    expect(a.subscribe).not.toHaveBeenCalled()
    const post = a.fetch.mock.calls.find(c => String(c[0]).endsWith('/api/subscribe'))!
    expect(JSON.parse(String(post[1]!.body))).toEqual({ subscription: { endpoint: 'given' } })

    const b = load({ fetch: async () => { throw new TypeError('Failed to fetch') } })
    await expect(b.fire('pushsubscriptionchange', {})).resolves.toBeUndefined()
    expect(b.subscribe).not.toHaveBeenCalled()
    const c = load({ fetch: async () => Response.json({ ok: false, error: '짝을 맺어 주세요' }, { status: 401 }) })
    await c.fire('pushsubscriptionchange', {})
    expect(c.subscribe).not.toHaveBeenCalled()
  })
})

describe('sw.js — PC 에 닿지 않을 때 화면(오프라인)', () => {
  const OFFLINE_HTML = '<!doctype html><title>PC 에 닿지 않아요</title>'
  const serve = (over: (u: string) => Promise<Response> | null = () => null) => async (u: string | FakeReq) => {
    const url = typeof u === 'string' ? u : u.url
    const hit = over(url)
    if (hit) return hit
    const p = new URL(url, ORIGIN).pathname
    if (p === '/offline.html') return new Response(OFFLINE_HTML, { status: 200, headers: { 'content-type': 'text/html' } })
    if (p === '/offline.js') return new Response('/* retry */', { status: 200 })
    return new Response(`page ${p}`, { status: 200 })
  }
  let down = false
  const offlineWhenDown = () => serve(u => (down && !u.startsWith('/') ? Promise.reject(new TypeError('Failed to fetch')) : null))

  it('install — 오프라인 화면(offline.html · offline.js · 연결 화면의 로고)을 미리 받아 둔다 · 못 받아도 설치는 된다(알림이 먼저)', async () => {
    const a = load({ fetch: serve() })
    await a.fire('install')
    expect(a.self.skipWaiting).toHaveBeenCalledTimes(1)
    const [name] = [...a.caches.store.keys()]
    expect(name).toMatch(/^dure-offline/)
    expect([...a.caches.store.get(name)!.keys()].sort()).toEqual(['/icons/dure-512.png', '/offline.html', '/offline.js'])

    const b = load({ fetch: async () => { throw new TypeError('Failed to fetch') } })
    await expect(b.fire('install')).resolves.toBeUndefined()
    expect(b.self.skipWaiting).toHaveBeenCalledTimes(1)
  })

  it('activate — 옛 판의 두레 캐시만 지운다', async () => {
    const a = load({ fetch: serve() })
    await a.fire('install')
    const [current] = [...a.caches.store.keys()]
    expect(current).not.toBe('dure-offline-0')
    await (await a.caches.open('dure-offline-0')).addAll([])
    await (await a.caches.open('someone-else')).addAll([])
    await a.fire('activate')
    expect([...a.caches.store.keys()].sort()).toEqual([current, 'someone-else'].sort())
    expect(a.self.clients.claim).toHaveBeenCalledTimes(1)
  })

  it('화면 열기(navigate) — 망이 먼저: 닿으면 그 답 그대로, 못 닿거나 502·503·504 면 미리 받아 둔 오프라인 화면', async () => {
    down = false
    let status = 200
    const a = load({ fetch: serve(u => (u.startsWith('/') ? null : down ? Promise.reject(new TypeError('Failed to fetch')) : new URL(u).pathname === '/mobile.html' ? Promise.resolve(new Response('app', { status })) : null)) })
    await a.fire('install')
    expect(await (await a.request('/mobile.html', { mode: 'navigate' }))!.text()).toBe('app')
    status = 404
    const nf = await a.request('/mobile.html', { mode: 'navigate' })!
    expect(nf.status).toBe(404)
    for (const s of [502, 503, 504]) {
      status = s
      expect(await (await a.request('/mobile.html#agent=a1', { mode: 'navigate' }))!.text()).toBe(OFFLINE_HTML)
    }
    status = 200
    down = true
    expect(await (await a.request('/', { mode: 'navigate' }))!.text()).toBe(OFFLINE_HTML)
    // 오프라인 화면의 스크립트도 미리 받아 둔 것으로
    expect(await (await a.request('/offline.js', { mode: 'no-cors' }))!.text()).toBe('/* retry */')
  })

  it('화면 열기 — 2초 넘게 답이 없으면(PC 가 잠듦) 오프라인 화면(연결하고 있어요) — 시작 화면에 멈춘 것처럼 두지 않는다', async () => {
    vi.useFakeTimers()
    const a = load({ fetch: serve(u => (u.startsWith('/') ? null : new Promise<Response>(() => {}))) })
    await a.fire('install')
    const r = a.request('/mobile.html', { mode: 'navigate' })!
    let got: string | null = null
    void r.then(async x => { got = await x.text() })
    await vi.advanceTimersByTimeAsync(1_999)
    expect(got).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(got).toBe(OFFLINE_HTML))
  })

  it("화면 열기 — 연결 화면이 'dure:reconnect' 를 보낸 뒤 그 한 번은 10초까지 기다린다(느린 망에서 연결 화면 ↔ 다시 열기가 돌지 않게) · 다음은 다시 2초", async () => {
    vi.useFakeTimers()
    let answerAt = Infinity
    const a = load({
      fetch: serve(u => (u.startsWith('/') ? null : new Promise<Response>(res => {
        const ms = answerAt - Date.now()
        if (Number.isFinite(ms)) setTimeout(() => res(new Response('app', { status: 200 })), ms)
      }))),
    })
    await a.fire('install')
    // 알림 뒤 첫 화면 열기 — 5초 걸려도 앱
    await a.fire('message', { data: { type: 'dure:reconnect' } })
    answerAt = Date.now() + 5_000
    const r1 = a.request('/mobile.html', { mode: 'navigate' })!
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await (await r1).text()).toBe('app')
    // 다음 화면 열기는 다시 2초
    answerAt = Date.now() + 5_000
    const r2 = a.request('/mobile.html', { mode: 'navigate' })!
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await (await r2).text()).toBe(OFFLINE_HTML)
    // 알림이 오래전이면(15초 넘음) 2초
    await a.fire('message', { data: { type: 'dure:reconnect' } })
    await vi.advanceTimersByTimeAsync(15_001)
    answerAt = Date.now() + 5_000
    const r3 = a.request('/mobile.html', { mode: 'navigate' })!
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await (await r3).text()).toBe(OFFLINE_HTML)
    // 모르는 메시지는 무시
    await a.fire('message', { data: { type: 'other' } })
    answerAt = Date.now() + 5_000
    const r4 = a.request('/mobile.html', { mode: 'navigate' })!
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await (await r4).text()).toBe(OFFLINE_HTML)
  })

  it('오프라인 화면 파일(스크립트·로고) — 캐시가 먼저(망을 또 기다리지 않음) · 없으면 망', async () => {
    let netCalls = 0
    const a = load({ fetch: serve(u => (u.startsWith('/') ? null : (netCalls++, new Promise<Response>(() => {})))) })
    await a.fire('install')
    expect(await (await a.request('/offline.js', { mode: 'no-cors' }))!.text()).toBe('/* retry */')
    expect(await (await a.request('/icons/dure-512.png', { mode: 'no-cors' }))!.text()).toBe('page /icons/dure-512.png')
    expect(netCalls).toBe(0)

    const b = load({ fetch: serve() })
    const r = await b.request('/offline.js', { mode: 'no-cors' })!
    expect(await r.text()).toBe('/* retry */') // 받아 둔 것이 없다 — 망에서
  })

  it('화면이 PC 에서 잘 열리면 오프라인 화면 파일을 뒤에서 새로 받아 둔다 — 깨어 있는 동안 한 번 · 실패하면 다음에 다시', async () => {
    let failRefresh = true
    const a = load({ fetch: serve(u => (u.startsWith('/') && failRefresh ? Promise.reject(new TypeError('Failed to fetch')) : null)) })
    // 설치 때 못 받았다
    await a.fire('install')
    const name = [...a.caches.store.keys()][0] ?? null
    expect(name === null || a.caches.store.get(name)!.size === 0).toBe(true)
    // 첫 화면 열기 — 앱은 그대로, 뒤에서 받기는 실패
    expect(await (await a.request('/mobile.html', { mode: 'navigate' }))!.text()).toBe('page /mobile.html')
    await Promise.all(a.background)
    // 다음 화면 열기 — 이번엔 받아 둔다
    failRefresh = false
    await a.request('/mobile.html', { mode: 'navigate' })
    await Promise.all(a.background)
    const [cacheName] = [...a.caches.store.keys()]
    expect([...a.caches.store.get(cacheName)!.keys()].sort()).toEqual(['/icons/dure-512.png', '/offline.html', '/offline.js'])
    // 그 뒤로는 받지 않는다(깨어 있는 동안 한 번)
    const before = a.fetch.mock.calls.length
    await a.request('/mobile.html', { mode: 'navigate' })
    await Promise.all(a.background)
    expect(a.fetch.mock.calls.length - before).toBe(1) // 화면 하나만
  })

  it('API · WebSocket 길 · GET 이 아닌 것 · 다른 곳 · 보통 파일은 손대지 않는다(캐시하지 않음)', async () => {
    const a = load({ fetch: offlineWhenDown() })
    await a.fire('install')
    expect(a.request('/api/me')).toBeNull()
    expect(a.request('/api/ws', { mode: 'navigate' })).toBeNull()
    expect(a.request('/api/upload?name=a.png', { method: 'POST' })).toBeNull()
    expect(a.request('/mobile.html', { method: 'POST', mode: 'navigate' })).toBeNull()
    expect(a.request('https://evil.example/', { mode: 'navigate' })).toBeNull()
    expect(a.request('/assets/mobile-abc.js')).toBeNull()
    expect(a.request('/icons/dure-192.png')).toBeNull()
    expect(a.caches.open).toHaveBeenCalledTimes(1) // install 때만
  })

  it('오프라인 화면 파일 — 글 · [다시 시도] · 스크립트는 같은 곳 파일로만(CSP script-src self)', () => {
    const pub = path.join(__dirname, '../src/renderer/public')
    const html = fs.readFileSync(path.join(pub, 'offline.html'), 'utf8')
    expect(html).toContain('PC 에 닿지 않아요')
    expect(html.replace(/<[^>]+>/g, '')).toContain('PC 가 켜져 있고 두레가 떠 있는지, 휴대폰의 Tailscale 이 켜져 있는지 봐 주세요.')
    expect(html).toContain('다시 시도')
    expect(html).toContain('<main>')
    // 연결하고 있어요(시안 A) — 로고(받아 두는 그 파일) + 글. 기본 모습은 '닿지 않아요'(스크립트를 못 읽어도 할 일이 보이게)
    expect(html).toContain('<html lang="ko" data-state="offline">')
    expect(html.replace(/<[^>]+>/g, '')).toContain('PC 에 연결하고 있어요')
    expect(html).toContain('src="/icons/dure-512.png"')
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    expect(scripts.map(m => [m[1].trim(), m[2].trim()])).toEqual([['src="/offline.js"', '']])
    // 그리기 전에 돈다 — head 안
    expect(html.indexOf('<script src="/offline.js">')).toBeLessThan(html.indexOf('</head>'))
    const js = fs.readFileSync(path.join(pub, 'offline.js'), 'utf8')
    expect(js).toContain('location.reload()')
  })

  it("오프라인 화면 — 두레 앱 안(html data-app)일 때만 보이는 '주소가 바뀌었으면…' 줄이 'PC 에 닿지 않아요' 안내 바로 아래", () => {
    const pub = path.join(__dirname, '../src/renderer/public')
    const html = fs.readFileSync(path.join(pub, 'offline.html'), 'utf8')
    const LINE = 'PC 주소가 바뀌었으면 PC 두레 → 설정 → 휴대폰의 QR 로 크롬에서 열고 [두레 앱으로 열기]를 다시 눌러 주세요.'
    const text = html.replace(/<[^>]+>/g, '')
    expect(text).toContain(LINE)
    // 안내(Tailscale) 다음, [다시 시도] 앞
    expect(text.indexOf('Tailscale 이 켜져 있는지 봐 주세요.')).toBeLessThan(text.indexOf(LINE))
    expect(text.indexOf(LINE)).toBeLessThan(text.indexOf('다시 시도'))
    // 그 줄은 class="app-only" — 기본은 숨고 html[data-app] 일 때만
    const line = html.match(/<p class="([^"]*)"[^>]*>[^<]*PC 주소가 바뀌었으면/)
    expect(line?.[1].split(' ')).toContain('app-only')
    expect(html).toMatch(/\.app-only\s*\{\s*display:\s*none;?\s*\}/)
    expect(html).toMatch(/html\[data-app\]\s+\.app-only\s*\{\s*display:\s*block;?\s*\}/)
  })

  it('오프라인 화면이 바뀌면 캐시 이름도 바뀐다 — 받아 둔 옛 화면에 머물지 않게(dure-offline-4)', async () => {
    const a = load({ fetch: serve() })
    await a.fire('install')
    expect([...a.caches.store.keys()]).toContain('dure-offline-4')
  })

  it('미리 받아 둔 것이 없고 망도 안 되면 — 브라우저 오류 화면(Response.error)', async () => {
    const a = load({ fetch: async () => { throw new TypeError('Failed to fetch') } })
    await a.fire('install')
    const r = await a.request('/mobile.html', { mode: 'navigate' })!
    expect(r.type).toBe('error')
  })
})
