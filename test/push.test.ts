import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse as legacyParse } from 'node:url'
import webpush from 'web-push'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  createPush, isPushEndpoint, VAPID_SUBJECT, webPushOptions, webPushSend, type PhoneNotice, type PushSend,
} from '../src/main/phone/push'
import { openPhoneStore, type PhonePushSubscription, type StoredPhoneDevice } from '../src/main/phone/phoneStore'

// 웹 푸시 — 진짜 알림 서버로는 보내지 않는다(send 를 바꿔 끼우거나 web-push 의 sendNotification 을 가짜로). 주소·열쇠는 모두 가짜

vi.mock('web-push', async (importOriginal) => {
  const real = ((await importOriginal()) as { default: typeof import('web-push') }).default
  return { default: { ...real, sendNotification: vi.fn(), generateVAPIDKeys: vi.fn(real.generateVAPIDKeys) } }
})

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-push-'))
  vi.mocked(webpush.generateVAPIDKeys).mockClear()
  vi.mocked(webpush.sendNotification).mockReset()
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

const saved = () => JSON.parse(fs.readFileSync(path.join(dir, 'phone.json'), 'utf8'))
const P256DH = Buffer.alloc(65, 4).toString('base64url')
const AUTH = Buffer.alloc(16, 7).toString('base64url')
const FCM = 'https://fcm.googleapis.com/fcm/send/fake-endpoint-0001'
const sub = (endpoint = FCM): PhonePushSubscription => ({ endpoint, expirationTime: null, keys: { p256dh: P256DH, auth: AUTH } })
const dev = (id: string, over: Partial<StoredPhoneDevice> = {}): StoredPhoneDevice => ({
  id, name: `휴대폰 ${id}`, createdAt: 1000, lastSeen: null, push: false, tokenHash: 'a'.repeat(64), ...over,
})
const NOTICE: PhoneNotice = { title: '두레', body: '백엔드 · 승인을 기다려요', tag: 'dure-a1-approval-1', url: '/#agent=a1' }
const VAPID = { publicKey: 'BFakePublicKey0000', privateKey: 'fake-private-key-0000' }

/** 보낸 것을 모으는 가짜 send — 답은 reply 가 정한다 */
function fakeSend(reply: () => Promise<{ gone: boolean }> = async () => ({ gone: false })) {
  const calls: { sub: PhonePushSubscription; payload: string; vapid: { publicKey: string; privateKey: string }; o: unknown }[] = []
  const send: PushSend = async (s, payload, vapid, o) => {
    calls.push({ sub: s, payload, vapid, o })
    return reply()
  }
  return { send, calls }
}

test('VAPID 한 번 만들어 저장', () => {
  const store = openPhoneStore(dir)
  const push = createPush(store, { send: fakeSend().send })
  const key = push.publicKey()
  expect(key).toMatch(/^[A-Za-z0-9_-]{80,}$/)
  expect(webpush.generateVAPIDKeys).toHaveBeenCalledTimes(1)
  expect(saved().vapid.publicKey).toBe(key)
  expect(saved().vapid.privateKey).toMatch(/^[A-Za-z0-9_-]{40,}$/)
  // 다시 불러도 · 두레를 다시 켜도(새 store) 같은 열쇠 — 바꾸면 모든 구독이 깨진다(probe28)
  expect(push.publicKey()).toBe(key)
  expect(createPush(openPhoneStore(dir)).publicKey()).toBe(key)
  expect(webpush.generateVAPIDKeys).toHaveBeenCalledTimes(1)

  // 이미 있는 열쇠는 그대로 쓴다(만들지 않는다)
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'dure-push-'))
  try {
    openPhoneStore(other).write({ vapid: VAPID })
    expect(createPush(openPhoneStore(other)).publicKey()).toBe(VAPID.publicKey)
    expect(webpush.generateVAPIDKeys).toHaveBeenCalledTimes(1)
  } finally {
    fs.rmSync(other, { recursive: true, force: true })
  }
})

/** 던진 오류 — 안 던지면 시험이 실패한다 */
function thrownBy(fn: () => void): Error {
  try {
    fn()
  } catch (e) {
    return e as Error
  }
  throw new Error('던지지 않았어요')
}

/**
 * WHATWG URL 은 알려진 서버라고 읽지만 web-push 가 접속하는 옛 url.parse 는 다른 호스트로 읽는 주소들(SSRF 우회).
 * 호스트 자리의 ; ' ` { } " 와 %-escape 에서 url.parse 가 호스트를 끊는다 — 앞의 것이 접속할 곳이 된다
 */
const PARSER_SPLIT_BYPASSES = [
  'https://127.0.0.1;.fcm.googleapis.com/x',
  "https://192.168.0.1'.fcm.googleapis.com/fcm/send/x",
  'https://localhost%3B.fcm.googleapis.com/x',
  'https://evil.example%7B.push.apple.com/x',
  'https://evil.com%41.fcm.googleapis.com/x',
  'https://127.0.0.1`.fcm.googleapis.com/x',
  'https://127.0.0.1{.fcm.googleapis.com/x',
  'https://127.0.0.1}.fcm.googleapis.com/x',
  'https://127.0.0.1".fcm.googleapis.com/x',
]

test('두 URL 해석이 같은 호스트일 때만 — url.parse 가 다른 곳으로 접속할 주소는 거절', () => {
  // 시험의 전제: 이 주소들은 WHATWG 로는 알려진 서버 아래 이름인데, 옛 url.parse 로는 다른 호스트다
  for (const bad of PARSER_SPLIT_BYPASSES) {
    const whatwg = new URL(bad).hostname
    expect(whatwg.endsWith('.fcm.googleapis.com') || whatwg.endsWith('.push.apple.com'), bad).toBe(true)
    expect(legacyParse(bad).hostname, bad).not.toBe(whatwg)
    expect(isPushEndpoint(bad), bad).toBe(false)
  }
  for (const bad of [
    'https://FCM.googleapis.com/fcm/send/x', // 대문자 — 브라우저는 소문자로 직렬화한다
    'https://fcm.googleapis.com\\@evil.example.com/x', // 역슬래시
    'https://evil.example.com\\.fcm.googleapis.com/x',
    'https://fcm.googleapis.com:443/x', // 기본 포트라도 쓰여 있으면
    'https://fcm.googleapis.com', // 경로 없음
    'https://fcm.googleapis.com?x', // 호스트 뒤가 / 가 아님
    'https://fcm.googleapis.com#x',
    'https://fcm.googleapis.com/x y', // 빈칸
    'https://fcm.googleapis.com/x\t',
    'https://fcm.googleapis.com/x\n',
    "https://fcm.googleapis.com/x'y", // 따옴표 — 경로에 있어도
    'https://fcm.googleapis.com/x"y',
    'https://fcm.googleapis.com/x`y',
    'https://fcm.googleapis.com/{x}',
    'https://fcm.googleapis.com/x\\y',
    'https://fcm.googleapis.com/x<y>',
    'https://fcm.googleapis.com/x^y|',
    'https://ｆｃｍ.googleapis.com/x', // 전각 — WHATWG 는 fcm 으로 바꾼다
    'https://fcm.googleapis.com。/x',
    'https://[::ffff:127.0.0.1]/x',
    'https://0x7f.0.0.1/x',
    'https://fcm..googleapis.com/x',
    'https://a_b.fcm.googleapis.com/x', // 호스트 꼴 — 소문자·숫자·하이픈 낱말만(두 해석 모두 받아 주는 글자라도)
    'https://a+b.fcm.googleapis.com/x',
  ]) expect(isPushEndpoint(bad), JSON.stringify(bad)).toBe(false)
  // 진짜 브라우저가 주는 꼴은 그대로 통과 — 경로·질의의 %-escape · 콜론 · 밑줄도
  for (const ok of [
    'https://fcm.googleapis.com/fcm/send/dFake0000:APA91bFake_-0000',
    'https://wns2-par02p.notify.windows.com/w/?token=BQYAAAFake%2b%2fFake%3d',
    'https://web.push.apple.com/QFake0000-_~.',
  ]) {
    expect(isPushEndpoint(ok), ok).toBe(true)
    expect(legacyParse(ok).hostname).toBe(new URL(ok).hostname)
  }
})

test('알려진 알림 서버만 — 그 밖은 subscribe 가 거절, 보내지도 않음', async () => {
  for (const ok of [
    FCM,
    'https://fcm.googleapis.com/fcm/send/fake-endpoint-0002',
    'https://web.push.apple.com/QFake0000',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAAFake',
    'https://wns2-par02p.notify.windows.com/w/?token=BQYAAAFake',
  ]) expect(isPushEndpoint(ok), ok).toBe(true)
  for (const bad of [
    ...PARSER_SPLIT_BYPASSES,
    'http://fcm.googleapis.com/fcm/send/x',
    'https://evil.example.com/fcm/send/x',
    'https://fcm.googleapis.com.evil.example.com/x',
    'https://evilfcm.googleapis.com/x',
    'https://notpush.apple.com/x',
    'https://notify.windows.com.evil.example.com/x',
    'https://127.0.0.1/x',
    'https://[::1]/x',
    'https://localhost/x',
    'https://fcm.googleapis.com:8443/x',
    'https://user:pw@fcm.googleapis.com/x',
    'https://fcm.googleapis.com./x',
    '아무 글',
  ]) expect(isPushEndpoint(bad), bad).toBe(false)

  const store = openPhoneStore(dir)
  store.write({ devices: [dev('d1')] })
  const { send, calls } = fakeSend()
  const push = createPush(store, { send })
  for (const endpoint of ['https://evil.example.com/x', 'https://127.0.0.1:47615/api/pair', ...PARSER_SPLIT_BYPASSES]) {
    const e = thrownBy(() => push.subscribe('d1', sub(endpoint)))
    expect(e.message).toBe('알려진 알림 서버가 아니에요')
    expect(e.message).not.toContain(endpoint) // 오류 글에 주소를 싣지 않는다
  }
  const malformed = thrownBy(() => push.subscribe('d1', { endpoint: FCM, keys: { p256dh: 'P', auth: 'A' } }))
  expect(malformed.message).toBe('알림 구독 꼴이 틀렸어요')
  expect(malformed.message).not.toContain(FCM)
  expect(store.read().devices[0].subscription).toBeUndefined()

  // 파일을 손대 알려지지 않은 주소가 들어 있어도 보내지 않는다(우회 꼴도)
  const log = vi.fn()
  for (const endpoint of ['https://evil.example.com/x', ...PARSER_SPLIT_BYPASSES]) {
    store.write({ devices: [dev('d1', { subscription: sub(endpoint) })] })
    await createPush(store, { send, log }).sendTo('d1', NOTICE)
  }
  expect(calls).toHaveLength(0)
  const logged = JSON.stringify(log.mock.calls)
  for (const s of ['evil.example', '127.0.0.1', '192.168.0.1', 'localhost', 'evil.com']) expect(logged).not.toContain(s)
})

test('subscribe — 그 기기에 저장(push 켜짐) · 모르는 기기는 무시 · 같은 주소의 다른 기기 구독은 뺌', () => {
  const store = openPhoneStore(dir)
  store.write({ devices: [dev('old', { subscription: sub() }), dev('d1'), dev('d2', { subscription: sub(`${FCM}-other`) })] })
  const push = createPush(store, { send: fakeSend().send })
  push.subscribe('d1', sub())
  const ds = store.read().devices
  expect(ds.find((d) => d.id === 'd1')).toMatchObject({ push: true, subscription: sub() })
  // 같은 브라우저가 다시 짝을 맺었다 — 옛 기기의 같은 구독은 빠진다(한 휴대폰에 두 번 울리지 않게)
  expect(ds.find((d) => d.id === 'old')).toMatchObject({ push: false })
  expect(ds.find((d) => d.id === 'old')?.subscription).toBeUndefined()
  expect(ds.find((d) => d.id === 'd2')?.subscription?.endpoint).toBe(`${FCM}-other`)

  // 그 사이 끊긴 기기 — 쓰지 않는다
  const before = fs.readFileSync(path.join(dir, 'phone.json'), 'utf8')
  push.subscribe('없는-기기', sub(`${FCM}-x`))
  expect(fs.readFileSync(path.join(dir, 'phone.json'), 'utf8')).toBe(before)
})

test('sendTo — 네 칸만 보냄 · 급함·TTL 은 고른 대로 · 구독이 없으면 안 보냄', async () => {
  const store = openPhoneStore(dir)
  store.write({ devices: [dev('d1', { subscription: sub() }), dev('d2')] })
  const { send, calls } = fakeSend()
  const push = createPush(store, { send })
  const key = push.publicKey()
  await push.sendTo('d1', { ...NOTICE, extra: '명령 rm -rf' } as PhoneNotice, { urgency: 'normal', ttl: 600 })
  await push.sendTo('d1', NOTICE)
  await push.sendTo('d2', NOTICE)
  await push.sendTo('없는-기기', NOTICE)
  expect(calls).toHaveLength(2)
  expect(JSON.parse(calls[0].payload)).toEqual(NOTICE)
  expect(calls[0].payload).not.toContain('rm -rf')
  expect(calls[0].sub).toEqual(sub())
  expect(calls[0].vapid.publicKey).toBe(key)
  expect(calls[0].o).toEqual({ urgency: 'normal', ttl: 600 })
  expect(calls[1].o).toEqual({ urgency: 'high', ttl: 3600 })
})

test('410 이면 구독 지움', async () => {
  const store = openPhoneStore(dir)
  store.write({ devices: [dev('d1', { subscription: sub() }), dev('d2', { subscription: sub(`${FCM}-2`) })] })
  const { send } = fakeSend(async () => ({ gone: true }))
  await createPush(store, { send }).sendTo('d1', NOTICE)
  const ds = store.read().devices
  expect(ds.find((d) => d.id === 'd1')?.subscription).toBeUndefined()
  expect(ds.find((d) => d.id === 'd1')?.push).toBe(false)
  expect(ds.find((d) => d.id === 'd2')?.subscription).toBeDefined()
  expect(saved().devices.find((d: { id: string }) => d.id === 'd1').subscription).toBeUndefined()

  // 보내는 사이 휴대폰이 새로 구독했다 — 옛 구독의 410 이 새 구독을 지우지 않는다
  let release!: () => void
  const slow: PushSend = () => new Promise((resolve) => (release = () => resolve({ gone: true })))
  const push = createPush(store, { send: slow })
  const sending = push.sendTo('d2', NOTICE)
  push.subscribe('d2', sub(`${FCM}-new`))
  release()
  await sending
  expect(store.read().devices.find((d) => d.id === 'd2')?.subscription?.endpoint).toBe(`${FCM}-new`)
})

test('보내기 실패 — 던지지 않고, 로그에 주소·열쇠가 없음', async () => {
  const store = openPhoneStore(dir)
  store.write({ vapid: VAPID, devices: [dev('d1', { subscription: sub() })] })
  const log = vi.fn()
  const secretish = `${FCM} ${P256DH} ${AUTH} ${VAPID.privateKey}`
  const failing: PushSend = async () => {
    throw Object.assign(new Error(`boom ${secretish}`), { statusCode: 500, endpoint: FCM })
  }
  await expect(createPush(store, { send: failing, log }).sendTo('d1', NOTICE)).resolves.toBeUndefined()
  expect(log).toHaveBeenCalled()
  const logged = JSON.stringify(log.mock.calls)
  for (const s of [FCM, 'fake-endpoint', P256DH, AUTH, VAPID.privateKey, 'boom']) expect(logged).not.toContain(s)
  expect(logged).toContain('500')
  // 구독은 그대로(410·404 가 아니다)
  expect(store.read().devices[0].subscription).toBeDefined()
})

test('webPushSend — VAPID 주제·aes128gcm·급함·TTL · 404/410 = gone · 그 밖 오류는 주소 없이', async () => {
  expect(VAPID_SUBJECT).toBe('https://github.com/choiy4432/dure')
  const sendNotification = vi.mocked(webpush.sendNotification)
  sendNotification.mockResolvedValueOnce({ statusCode: 201, body: '', headers: {} })
  await expect(webPushSend(sub(), '{"title":"두레"}', VAPID, { urgency: 'high', ttl: 3600 })).resolves.toEqual({ gone: false })
  expect(sendNotification).toHaveBeenCalledWith(sub(), '{"title":"두레"}', expect.objectContaining({
    vapidDetails: { subject: VAPID_SUBJECT, publicKey: VAPID.publicKey, privateKey: VAPID.privateKey },
    urgency: 'high',
    TTL: 3600,
    contentEncoding: 'aes128gcm',
  }))
  expect(sendNotification.mock.calls[0][2]).not.toHaveProperty('proxy')

  for (const statusCode of [404, 410]) {
    sendNotification.mockRejectedValueOnce(Object.assign(new Error('Received unexpected response code'), { statusCode, endpoint: FCM }))
    await expect(webPushSend(sub(), 'x', VAPID, { urgency: 'normal', ttl: 600 })).resolves.toEqual({ gone: true })
  }
  sendNotification.mockRejectedValueOnce(Object.assign(new Error(`bad ${FCM}`), { statusCode: 403, endpoint: FCM }))
  const e = await webPushSend(sub(), 'x', VAPID, { urgency: 'high', ttl: 3600 }).catch((x: unknown) => x)
  expect(e).toBeInstanceOf(Error)
  expect(String((e as Error).message)).toContain('403')
  expect(JSON.stringify({ m: (e as Error).message, ...(e as object) })).not.toContain('fake-endpoint')

  sendNotification.mockRejectedValueOnce(Object.assign(new Error(`getaddrinfo ENOTFOUND ${FCM}`), { code: 'ENOTFOUND' }))
  const n = await webPushSend(sub(), 'x', VAPID, { urgency: 'high', ttl: 3600 }).catch((x: unknown) => x)
  expect((n as Error).message).toContain('ENOTFOUND')
  expect(JSON.stringify({ m: (n as Error).message, ...(n as object) })).not.toContain('fake-endpoint')
})

test('webPushOptions — 진짜 web-push 가 받아 요청을 만든다(보내지는 않음)', () => {
  const ecdh = crypto.createECDH('prime256v1')
  const browser = {
    endpoint: FCM,
    keys: { p256dh: ecdh.generateKeys().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
  }
  const vapid = webpush.generateVAPIDKeys()
  const r = webpush.generateRequestDetails(browser, '{"title":"두레"}', webPushOptions(vapid, { urgency: 'high', ttl: 3600 }))
  expect(r.endpoint).toBe(FCM)
  expect(r.headers).toMatchObject({ TTL: 3600, Urgency: 'high', 'Content-Encoding': 'aes128gcm' })
  expect(String(r.headers.Authorization)).toMatch(/^vapid t=.+, k=/)
  expect(r.body).toBeInstanceOf(Buffer)
  expect(r.body?.toString('utf8')).not.toContain('두레') // 암호화됐다
})
