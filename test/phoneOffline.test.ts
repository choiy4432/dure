// 휴대폰의 PC 에 연결하는 동안·닿지 않을 때 화면 스크립트(src/renderer/public/offline.js) — 가짜 문서·시계 위에서 돌린다
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const CODE = fs.readFileSync(path.join(__dirname, '../src/renderer/public/offline.js'), 'utf8')

type FetchFn = (u: string, init: RequestInit) => Promise<Response>
const never: FetchFn = (_u, init) =>
  new Promise((_res, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))))
const status = (s: number): FetchFn => async () => new Response(null, { status: s })
const down: FetchFn = async () => { throw new TypeError('Failed to fetch') }

function load(o: { fetch: FetchFn; hidden?: boolean; controller?: boolean; referrer?: string; session?: Record<string, string>; search?: string }) {
  let answer = o.fetch
  const attrs = new Map<string, string>([['data-state', 'offline']])
  const root = { getAttribute: (k: string) => attrs.get(k) ?? null, setAttribute: (k: string, v: string) => void attrs.set(k, v) }
  const live = { textContent: '' }
  const btnAttrs = new Map<string, string>([['aria-busy', 'false']])
  const btnClicks: (() => void)[] = []
  const btn = {
    getAttribute: (k: string) => btnAttrs.get(k) ?? null,
    setAttribute: (k: string, v: string) => void btnAttrs.set(k, v),
    addEventListener: (_n: string, f: () => void) => void btnClicks.push(f),
  }
  let domReady = false
  const docOn: Record<string, (() => void)[]> = {}
  const winOn: Record<string, (() => void)[]> = {}
  const document = {
    documentElement: root,
    title: '두레 — PC 에 닿지 않아요',
    visibilityState: o.hidden ? 'hidden' : 'visible',
    referrer: o.referrer ?? '',
    // head 에서 돌 때는 아직 body 가 없다
    getElementById: (id: string) => (!domReady ? null : id === 'status' ? live : id === 'retry' ? btn : null),
    addEventListener: (n: string, f: () => void) => void (docOn[n] ??= []).push(f),
  }
  const reload = vi.fn()
  const postMessage = vi.fn()
  const fetchFn = vi.fn((u: string, init: RequestInit) => answer(u, init))
  const ctx = {
    document,
    window: { addEventListener: (n: string, f: () => void) => void (winOn[n] ??= []).push(f) },
    location: { reload, search: o.search ?? '' },
    navigator: { serviceWorker: { controller: o.controller === false ? null : { postMessage } } },
    fetch: fetchFn,
    AbortController,
    Promise,
    Date,
    setTimeout: (f: () => void, ms: number) => setTimeout(f, ms),
    clearTimeout: (t: ReturnType<typeof setTimeout>) => clearTimeout(t),
    // 없으면(옛 브라우저·막힘) 이름 자체가 없다 — 스크립트가 던지지 않아야 한다
    ...(o.session ? { sessionStorage: { getItem: (k: string) => o.session![k] ?? null } } : {}),
  }
  vm.runInNewContext(CODE, ctx)
  return {
    state: () => attrs.get('data-state'),
    attr: (k: string) => attrs.get(k) ?? null,
    document,
    live,
    busy: () => btnAttrs.get('aria-busy'),
    reload,
    postMessage,
    fetch: fetchFn,
    answer: (f: FetchFn) => { answer = f },
    ready: () => { domReady = true; for (const f of docOn.DOMContentLoaded ?? []) f() },
    visibility: (v: 'visible' | 'hidden') => { document.visibilityState = v; for (const f of docOn.visibilitychange ?? []) f() },
    online: () => { for (const f of winOn.online ?? []) f() },
    click: () => { for (const f of btnClicks) f() },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe("offline.js — 두레 앱 안이면 '주소가 바뀌었으면…' 줄(html 의 data-app)", () => {
  it('referrer 가 android-app://<두레 패키지>(시험 패키지도) 면 그리기 전에 data-app', () => {
    for (const referrer of ['android-app://io.github.choiy4432.dure/', 'android-app://io.github.choiy4432.dure', 'android-app://io.github.choiy4432.dure.test/']) {
      expect(load({ fetch: never, referrer }).attr('data-app'), referrer).toBe('1')
    }
  })

  it('크롬 탭 · 웹앱 · 다른 앱 · 이름만 비슷한 패키지 → 없음', () => {
    for (const referrer of ['', 'https://pc.tail0000.ts.net/', 'android-app://com.android.chrome/', 'android-app://io.github.choiy4432.durex/']) {
      expect(load({ fetch: never, referrer }).attr('data-app'), referrer).toBeNull()
    }
  })

  it('referrer 가 없어도 이 세션에 앱이 판을 알렸으면(dure:app) 앱 안 · sessionStorage 가 없어도 던지지 않는다', () => {
    expect(load({ fetch: never, session: { 'dure:app': '3' } }).attr('data-app')).toBe('1')
    expect(load({ fetch: never, session: {} }).attr('data-app')).toBeNull()
    const a = load({ fetch: never })
    expect(a.attr('data-app')).toBeNull()
    expect(a.state()).toBe('connecting') // 나머지는 그대로 돈다
  })

  it('referrer·세션이 없어도 주소에 ?app=<판>(앱이 연 첫 주소)이 남아 있으면 앱 안 · 0·빈 값·다른 이름은 아님', () => {
    for (const search of ['?app=3', '?x=1&app=12']) {
      expect(load({ fetch: never, search }).attr('data-app'), search).toBe('1')
    }
    for (const search of ['', '?app=0', '?app=', '?xapp=3', '?myapp=3']) {
      expect(load({ fetch: never, search }).attr('data-app'), search).toBeNull()
    }
  })
})

describe('offline.js — PC 에 연결하는 동안·닿지 않을 때', () => {
  it("그리기 전에 'PC 에 연결하고 있어요'로 바꾸고 바로 PC 에 묻는다(/api/me · 캐시 안 씀 · 쿠키 실음)", async () => {
    const a = load({ fetch: never })
    expect(a.state()).toBe('connecting')
    expect(a.document.title).toBe('두레 — PC 에 연결하고 있어요')
    expect(a.fetch).toHaveBeenCalledTimes(1)
    expect(a.fetch.mock.calls[0][0]).toBe('/api/me')
    expect(a.fetch.mock.calls[0][1]).toMatchObject({ cache: 'no-store', credentials: 'same-origin' })
    a.ready()
    expect(a.live.textContent).toBe('PC 에 연결하고 있어요')
  })

  it('닿으면(200 짝 맺음 · 401 짝 끊김) 서비스 워커에 알리고 같은 주소를 다시 연다', async () => {
    for (const s of [200, 401]) {
      const a = load({ fetch: status(s) })
      await vi.advanceTimersByTimeAsync(0)
      expect(a.postMessage).toHaveBeenCalledWith({ type: 'dure:reconnect' })
      expect(a.reload).not.toHaveBeenCalled() // 알림이 먼저 닿게 잠깐
      await vi.advanceTimersByTimeAsync(100)
      expect(a.reload).toHaveBeenCalledTimes(1)
    }
    // 서비스 워커가 안 맡고 있어도 다시 연다
    const b = load({ fetch: status(200), controller: false })
    await vi.advanceTimersByTimeAsync(100)
    expect(b.reload).toHaveBeenCalledTimes(1)
  })

  it('502·503·504(Tailscale 은 닿았는데 두레가 안 뜸) · 403 · 못 닿음은 닿지 않은 것 — 3초 쉬고 다시', async () => {
    for (const f of [status(502), status(503), status(504), status(403), down]) {
      const a = load({ fetch: f })
      await vi.advanceTimersByTimeAsync(0)
      expect(a.reload).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(2_999)
      expect(a.fetch).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(a.fetch).toHaveBeenCalledTimes(2)
    }
  })

  it('답이 없으면(PC 가 잠듦) 4초에 그만두고(abort) 3초 쉬고 다시', async () => {
    const a = load({ fetch: never })
    const signal = a.fetch.mock.calls[0][1].signal!
    await vi.advanceTimersByTimeAsync(3_999)
    expect(signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(2_999)
    expect(a.fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(a.fetch).toHaveBeenCalledTimes(2)
  })

  it("8초 안에 못 닿으면 'PC 에 닿지 않아요'(제목·읽어 주기) — 그 뒤에도 계속 시도해 닿으면 저절로 들어간다", async () => {
    const a = load({ fetch: down })
    a.ready()
    await vi.advanceTimersByTimeAsync(7_999)
    expect(a.state()).toBe('connecting')
    await vi.advanceTimersByTimeAsync(1)
    expect(a.state()).toBe('offline')
    expect(a.document.title).toBe('두레 — PC 에 닿지 않아요')
    expect(a.live.textContent).toBe('PC 에 닿지 않아요')
    a.answer(status(200))
    await vi.advanceTimersByTimeAsync(3_100)
    expect(a.reload).toHaveBeenCalledTimes(1)
  })

  it('화면이 숨은 동안은 묻지 않고, 다시 보이면 바로 · 망이 돌아오면(online) 바로', async () => {
    const a = load({ fetch: down })
    await vi.advanceTimersByTimeAsync(0)
    a.visibility('hidden')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(a.fetch).toHaveBeenCalledTimes(1)
    a.visibility('visible')
    expect(a.fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(0)
    a.online()
    expect(a.fetch).toHaveBeenCalledTimes(3)
  })

  it('[다시 시도] — 다시 잇는 중… → 못 닿으면 적어도 0.6초 뒤 돌아오고 알린다 · 닿으면 다시 열기(단추는 그대로)', async () => {
    const a = load({ fetch: down })
    a.ready()
    await vi.advanceTimersByTimeAsync(8_000)
    a.click()
    expect(a.busy()).toBe('true')
    expect(a.live.textContent).toBe('다시 잇는 중…')
    a.click() // 잇는 중에 또 눌러도 한 번
    await vi.advanceTimersByTimeAsync(599)
    expect(a.busy()).toBe('true')
    await vi.advanceTimersByTimeAsync(1)
    expect(a.busy()).toBe('false')
    expect(a.live.textContent).toBe('아직 PC 에 닿지 않아요')

    a.answer(status(200))
    a.click()
    await vi.advanceTimersByTimeAsync(700)
    expect(a.reload).toHaveBeenCalledTimes(1)
    expect(a.busy()).toBe('true')
  })

  it('묻는 중에 [다시 시도]·online 이 와도 겹쳐 묻지 않는다 · 다시 여는 중이면 더 묻지 않는다', async () => {
    const a = load({ fetch: never })
    a.ready()
    a.click()
    a.online()
    expect(a.fetch).toHaveBeenCalledTimes(1)

    const b = load({ fetch: status(200) })
    await vi.advanceTimersByTimeAsync(0)
    b.online()
    b.visibility('visible')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(b.fetch).toHaveBeenCalledTimes(1)
    expect(b.reload).toHaveBeenCalledTimes(1)
  })
})
