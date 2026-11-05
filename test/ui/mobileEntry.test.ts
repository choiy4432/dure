// 휴대폰 진입점의 주소·서비스 워커 일(src/renderer/mobile/entry.ts) — jsdom 주소 위에서
import { describe, it, expect, vi, afterEach } from 'vitest'
import { openFromWorker, resubscribeIfGranted, takePairCode } from '../../src/renderer/mobile/entry'

afterEach(() => {
  history.replaceState(null, '', '/')
})

describe('takePairCode — QR 의 #pair= 를 읽고 그 조각만 지운다', () => {
  it('짝 코드가 주소에 남지 않는다 · 방문 기록 칸이 늘지 않는다', () => {
    history.replaceState(null, '', '/mobile.html#pair=c0de-Secret_1')
    const before = history.length
    expect(takePairCode()).toBe('c0de-Secret_1')
    expect(location.href).not.toContain('c0de')
    expect(location.hash).toBe('')
    expect(location.pathname).toBe('/mobile.html')
    expect(history.length).toBe(before)
  })

  it('#agent= 같은 다른 조각은 그대로 · 쿼리도 그대로 · history.state 도 그대로', () => {
    history.replaceState({ keep: 1 }, '', '/mobile.html?x=1#agent=a1&pair=c0de')
    expect(takePairCode()).toBe('c0de')
    expect(location.search).toBe('?x=1')
    expect(location.hash).toBe('#agent=a1')
    expect(history.state).toEqual({ keep: 1 })
    history.replaceState(null, '', '/mobile.html#pair=c0de&agent=a%20b')
    expect(takePairCode()).toBe('c0de')
    expect(location.hash).toBe('#agent=a%20b')
  })

  it('짝 코드가 없으면 주소를 건드리지 않는다 · 빈 코드는 null(조각은 지운다)', () => {
    history.replaceState(null, '', '/mobile.html#agent=a1')
    const spy = vi.spyOn(history, 'replaceState')
    expect(takePairCode()).toBeNull()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
    history.replaceState(null, '', '/mobile.html#pair=%20')
    expect(takePairCode()).toBeNull()
    expect(location.hash).toBe('')
  })
})

describe('openFromWorker — 알림을 누름(서비스 워커의 dure:open)', () => {
  it('같은 곳 주소면 그 조각(#agent=)으로 — 다시 읽지 않는다', () => {
    history.replaceState(null, '', '/mobile.html')
    const changes = vi.fn()
    window.addEventListener('hashchange', changes)
    expect(openFromWorker({ type: 'dure:open', url: `${location.origin}/#agent=a1` })).toBe(true)
    expect(location.pathname).toBe('/mobile.html')
    expect(location.hash).toBe('#agent=a1')
    window.removeEventListener('hashchange', changes)
  })

  it('이미 그 조각이면 hashchange 를 직접 쏜다(화면이 그 대화로 다시 가게)', () => {
    history.replaceState(null, '', '/mobile.html#agent=a1')
    const changes = vi.fn()
    window.addEventListener('hashchange', changes)
    expect(openFromWorker({ type: 'dure:open', url: '/#agent=a1' })).toBe(true)
    expect(changes).toHaveBeenCalledTimes(1)
    window.removeEventListener('hashchange', changes)
  })

  it('다른 곳 주소 · 꼴이 틀린 글은 버린다', () => {
    history.replaceState(null, '', '/mobile.html#agent=a1')
    const changes = vi.fn()
    window.addEventListener('hashchange', changes)
    expect(openFromWorker({ type: 'dure:open', url: 'https://evil.example/#agent=x' })).toBe(false)
    expect(openFromWorker({ type: 'dure:open', url: 'javascript:alert(1)' })).toBe(false)
    expect(openFromWorker({ type: 'other', url: '/#agent=x' })).toBe(false)
    expect(openFromWorker({ type: 'dure:open', url: 3 })).toBe(false)
    expect(openFromWorker(null)).toBe(false)
    expect(openFromWorker('dure:open')).toBe(false)
    expect(location.hash).toBe('#agent=a1')
    expect(changes).not.toHaveBeenCalled()
    window.removeEventListener('hashchange', changes)
  })
})

describe('resubscribeIfGranted — 이미 허락한 알림은 켤 때마다 조용히 다시 구독', () => {
  it('허락했으면 subscribePush 를 부른다(묻지 않음) · 아니면 부르지 않는다', async () => {
    const subscribe = vi.fn(async () => 'on' as const)
    const requestPermission = vi.fn()
    expect(await resubscribeIfGranted({ notification: { permission: 'granted', requestPermission }, subscribe })).toBe('on')
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(requestPermission).not.toHaveBeenCalled()
    for (const permission of ['default', 'denied'] as const) {
      expect(await resubscribeIfGranted({ notification: { permission, requestPermission }, subscribe })).toBeNull()
    }
    expect(await resubscribeIfGranted({ notification: null, subscribe })).toBeNull()
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(requestPermission).not.toHaveBeenCalled()
  })

  it('구독이 던져도 조용히 failed', async () => {
    const subscribe = vi.fn(async () => {
      throw new Error('x')
    })
    expect(await resubscribeIfGranted({ notification: { permission: 'granted', requestPermission: vi.fn() }, subscribe })).toBe('failed')
  })
})
