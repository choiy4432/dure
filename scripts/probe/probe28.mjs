// probe28 — 휴대폰으로 쓰기 실측: tailscale serve 로 127.0.0.1 서버를 tailnet 안에만 https 로 열고, 휴대폰에서 열리는지·웹 푸시가 오는지.
// (T1) CLI 위치·status --json 에서 쓸 칸(사용자 칸은 꺼내지 않는다) · (T2) 포트 하나만 여는/닫는 명령, serve status 꼴 · (T3) https 꺼진 tailnet
// 출력(이번 PC 는 켜져 있어 못 봄) · (T4) 안드로이드 크롬·아이폰 홈 화면 앱 웹 푸시, 아이폰 사파리↔홈 화면 앱 저장소 분리 · (T5) serve 가 붙이는 헤더 이름.
// 사용자의 다른 serve 설정은 시작 전 상태를 적어 두고 끝난 뒤 같은지 본다. `serve reset`·`funnel` 은 쓰지 않는다.
// 실행: node scripts/probe/probe28.mjs   (끝내기: Ctrl+C 또는 PROBE28_MINUTES 분 뒤 — 끌 때 그 포트의 serve 만 끈다)
// 환경: PROBE28_NODE_MODULES = web-push 를 깐 node_modules 폴더(이 레포의 의존성이 아니다) · PROBE28_PORT(기본 47615) · PROBE28_LOG(기본 임시 폴더)
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { appendFileSync, existsSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { join } from 'node:path'
import os from 'node:os'

const PORT = Number(process.env.PROBE28_PORT ?? 47615)
const MINUTES = Number(process.env.PROBE28_MINUTES ?? 30)
const LOG = process.env.PROBE28_LOG ?? join(os.tmpdir(), 'probe28.log')
const nm = process.env.PROBE28_NODE_MODULES
if (!nm) throw new Error('PROBE28_NODE_MODULES 가 필요해요(web-push 를 깐 node_modules)')
const webpush = createRequire(join(nm, 'x.js'))('web-push')

const log = (tag, o = {}) => {
  const line = `${new Date().toISOString()} ${tag} ${JSON.stringify(o)}`
  console.log(line)
  appendFileSync(LOG, line + '\n')
}

// ---------- T1: CLI · 상태(사용자 칸은 꺼내지 않는다)
const cli = (() => {
  for (const c of ['tailscale', join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe')]) {
    try {
      execFileSync(c, ['version'], { stdio: 'pipe' })
      return c
    } catch {}
  }
  throw new Error('tailscale CLI 를 찾지 못했어요')
})()
const ts = (args) => {
  try {
    // serve 가 꺼진 tailnet 이면 `serve --bg` 는 켜기 링크를 찍고 켜질 때까지 기다린다(T3) — 상한을 둔다
    return { code: 0, out: execFileSync(cli, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 }) }
  } catch (e) {
    return { code: e.status ?? -1, out: String(e.stdout ?? ''), err: String(e.stderr ?? '') }
  }
}
const st = JSON.parse(ts(['status', '--json']).out)
const dns = String(st.Self?.DNSName ?? '').replace(/\.$/, '')
log('T1', { cli: cli === 'tailscale' ? 'PATH' : 'ProgramFiles', backend: st.BackendState, online: st.Self?.Online, haveDns: !!dns, certDomains: (st.CertDomains ?? []).length, keys: Object.keys(st).sort() })
if (!dns) throw new Error('이 기기의 DNS 이름이 없어요')
const host = `${dns}:${PORT}`
const url = `https://${host}/`

// ---------- 웹 푸시 열쇠(이번 실행에만 — 저장하지 않는다)
const vapid = webpush.generateVAPIDKeys()
webpush.setVapidDetails('https://github.com/choiy4432/dure', vapid.publicKey, vapid.privateKey)

// ---------- 페이지 · 서비스 워커 · 매니페스트
const PAGE = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="manifest" href="/manifest.webmanifest"><meta name="apple-mobile-web-app-capable" content="yes"><link rel="apple-touch-icon" href="/icon-192.png">
<title>두레 실측</title><style>body{font:16px system-ui;margin:20px;line-height:1.5}button{font-size:17px;padding:12px 16px;margin:6px 0;width:100%}pre{white-space:pre-wrap;background:#f1f5f9;padding:10px;border-radius:8px}</style></head>
<body><h2>두레 휴대폰 실측</h2><pre id="info"></pre>
<button id="sub">1) 알림 허락하고 시험 알림 받기</button>
<button id="mark">2) 이 화면에 표시 남기기(저장소 시험)</button>
<pre id="out"></pre>
<script>
const out = (t) => { document.getElementById('out').textContent += t + '\\n'; fetch('/log', { method: 'POST', body: JSON.stringify({ t }) }) }
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
document.getElementById('info').textContent = 'standalone=' + standalone + '\\nmark=' + (localStorage.getItem('dure-mark') || '(없음)') + '\\npush=' + ('PushManager' in window) + ' sw=' + ('serviceWorker' in navigator) + ' notif=' + ('Notification' in window ? Notification.permission : 'none')
fetch('/log', { method: 'POST', body: JSON.stringify({ open: true, standalone, mark: localStorage.getItem('dure-mark'), push: 'PushManager' in window, ua: navigator.userAgent }) })
document.getElementById('mark').onclick = () => { const v = (standalone ? 'home-' : 'browser-') + Date.now(); localStorage.setItem('dure-mark', v); out('표시 남김: ' + v) }
document.getElementById('sub').onclick = async () => {
  try {
    const p = await Notification.requestPermission(); out('permission=' + p)
    const reg = await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready
    const key = await (await fetch('/vapid')).text()
    const b = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - key.length % 4) % 4)), c => c.charCodeAt(0))
    // 실측은 실행마다 VAPID 열쇠가 바뀐다 — 예전 열쇠의 구독이 있으면 지우고 다시(두레는 열쇠를 저장해 계속 쓴다)
    const old = await reg.pushManager.getSubscription(); if (old) { await old.unsubscribe(); out('예전 구독 지움') }
    await reg.update()
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b })
    await fetch('/sub', { method: 'POST', body: JSON.stringify(sub) }); out('구독함 — 5초 뒤 알림이 와요. 화면을 끄거나 다른 앱으로 가 보세요')
  } catch (e) { out('오류: ' + e) }
}
</script></body></html>`
// 같은 tag 의 알림이 이미 있으면 안드로이드는 조용히 바꿔치기만 한다(팝업 없음) — 알림마다 다른 tag + renotify.
// badge = 상태 표시줄의 작은 단색 아이콘(없으면 크롬 아이콘), icon = 알림 안의 큰 아이콘
const SW = `self.addEventListener('push', e => { const d = e.data ? e.data.json() : {}; e.waitUntil(self.registration.showNotification(d.title || '두레', { body: d.body || '', tag: d.tag || 'probe28', renotify: true, icon: '/icon-192.png', badge: '/badge.png', data: { url: '/' } })) })
self.addEventListener('notificationclick', e => { e.notification.close(); e.waitUntil(clients.openWindow(e.notification.data.url)) })`
const MANIFEST = JSON.stringify({
  name: '두레 실측', short_name: '두레', start_url: '/', display: 'standalone', background_color: '#FFFFFF', theme_color: '#2563EB',
  icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }],
})

// ---------- PNG 아이콘(의존성 없이) — 파란 바탕 흰 D / 상태 표시줄용 흰 D(투명 바탕)
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]) }
/** 정규 좌표(0..1)의 D 안인가 — 세로 막대 + 반타원 고리 */
const inD = (u, v) => {
  if (u >= 0.27 && u <= 0.39 && v >= 0.22 && v <= 0.78) return true
  if (u < 0.33) return false
  const o = ((u - 0.33) / 0.36) ** 2 + ((v - 0.5) / 0.28) ** 2
  const i = ((u - 0.33) / 0.24) ** 2 + ((v - 0.5) / 0.16) ** 2
  return o <= 1 && i >= 1
}
const png = (size, pixel) => {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    for (let x = 0; x < size; x++) raw.set(pixel((x + 0.5) / size, (y + 0.5) / size), y * (size * 4 + 1) + 1 + x * 4)
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const appIcon = (size) => png(size, (u, v) => (inD(u, v) ? [255, 255, 255, 255] : [37, 99, 235, 255]))
const ICON192 = appIcon(192)
const ICON512 = appIcon(512)
const BADGE = png(96, (u, v) => (inD(u, v) ? [255, 255, 255, 255] : [0, 0, 0, 0]))
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#2563EB"/><text x="32" y="44" font-size="34" text-anchor="middle" fill="#fff" font-family="sans-serif">D</text></svg>'

const body = (req) => new Promise((r) => { let s = ''; req.on('data', (d) => { if (s.length < 16384) s += d }); req.on('end', () => r(s)) })
const server = createServer(async (req, res) => {
  // T5: serve 가 붙이는 헤더 이름만(값은 적지 않는다 — 사용자 정보가 들 수 있다)
  log('req', { method: req.method, path: req.url, hostOk: req.headers.host === host, tsHeaders: Object.keys(req.headers).filter((h) => h.startsWith('tailscale-')) })
  const send = (code, type, text) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(text) }
  if (req.url === '/' ) return send(200, 'text/html; charset=utf-8', PAGE)
  if (req.url === '/sw.js') return send(200, 'text/javascript', SW)
  if (req.url === '/manifest.webmanifest') return send(200, 'application/manifest+json', MANIFEST)
  if (req.url === '/icon.svg') return send(200, 'image/svg+xml', ICON)
  if (req.url === '/icon-192.png') return send(200, 'image/png', ICON192)
  if (req.url === '/icon-512.png') return send(200, 'image/png', ICON512)
  if (req.url === '/badge.png') return send(200, 'image/png', BADGE)
  if (req.url === '/vapid') return send(200, 'text/plain', vapid.publicKey)
  if (req.url === '/log' && req.method === 'POST') { log('page', JSON.parse((await body(req)) || '{}')); return send(204, 'text/plain', '') }
  if (req.url === '/sub' && req.method === 'POST') {
    const sub = JSON.parse(await body(req))
    log('sub', { endpointHost: new URL(sub.endpoint).host })
    send(204, 'text/plain', '')
    setTimeout(async () => {
      try {
        const r = await webpush.sendNotification(sub, JSON.stringify({ title: '두레', body: '실측 알림이에요 — 눌러 보세요', tag: `probe28-${Date.now()}` }), { urgency: 'high' })
        log('push', { status: r.statusCode })
      } catch (e) {
        log('push-error', { status: e.statusCode, body: String(e.body ?? e.message).slice(0, 200) })
      }
    }, 5000)
    return
  }
  send(404, 'text/plain', 'not found')
})

// ---------- T2: 그 포트 하나만 열기 · 끄기
const before = ts(['serve', 'status', '--json'])
log('serve-before', { code: before.code, out: before.out.trim().slice(0, 400) })
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
const on = ts(['serve', '--bg', `--https=${PORT}`, `http://127.0.0.1:${PORT}`])
log('serve-on', { code: on.code, out: (on.out + (on.err ?? '')).trim().slice(0, 600) })
const during = ts(['serve', 'status', '--json'])
log('serve-during', { code: during.code, out: during.out.trim().slice(0, 600) })
console.log(`\n휴대폰에서 열 주소: ${url}\n`)

let closing = false
const stop = async () => {
  if (closing) return
  closing = true
  const off = ts(['serve', `--https=${PORT}`, 'off'])
  log('serve-off', { code: off.code, out: (off.out + (off.err ?? '')).trim().slice(0, 400) })
  const after = ts(['serve', 'status', '--json'])
  log('serve-after', { code: after.code, same: after.out.trim() === before.out.trim(), out: after.out.trim().slice(0, 400) })
  server.close()
  setTimeout(() => process.exit(0), 300)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
setTimeout(stop, MINUTES * 60_000)
// 뒤에서 돌릴 때(Windows 는 SIGINT 를 보낼 수 없다) — `<LOG>.stop` 파일이 생기면 끈다
setInterval(() => { if (existsSync(`${LOG}.stop`)) void stop() }, 1000)
