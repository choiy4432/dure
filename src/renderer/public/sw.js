// 두레 휴대폰 서비스 워커 — 웹 푸시 알림 · PC 에 닿지 않을 때 화면(offline.html).
// 화면·API 는 캐시하지 않는다(늘 PC 의 지금 두레에서) — 미리 받아 두는 것은 오프라인 화면 두 파일뿐이고, 화면 열기(navigate)가 실패할 때만 쓴다.
// 알림 글은 PC(main 의 phoneNotifier)가 정한 네 칸 { title, body, tag, url } 뿐 — 명령·대화 글은 오지 않는다.

/** 오프라인 화면 캐시 — 판이 바뀌면 이름을 바꾼다(activate 가 옛 'dure-offline-*' 를 지운다) */
const OFFLINE_CACHE = 'dure-offline-1'
const OFFLINE_PAGE = '/offline.html'
const OFFLINE_FILES = [OFFLINE_PAGE, '/offline.js']
/** 화면 열기를 이만큼 기다린다 — PC 가 잠들었거나 꺼져 있으면 Tailscale 너머 연결이 답도 실패도 없이 오래 걸린다 */
const NAVIGATE_TIMEOUT_MS = 8000

// 새 판을 받으면 바로 맡는다 — 안 그러면 알림을 예전 판이 띄워 badge·icon 이 기본값으로 나온다(실측).
// 오프라인 화면을 못 받아 둬도 설치는 한다(알림이 먼저 — 그때는 브라우저 기본 오류 화면)
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(OFFLINE_CACHE)
        await cache.addAll(OFFLINE_FILES)
      } catch {
        // 다음 판·다음 설치 때
      }
      await self.skipWaiting()
    })(),
  )
})
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        for (const k of await caches.keys()) if (k.startsWith('dure-offline') && k !== OFFLINE_CACHE) await caches.delete(k)
      } catch {
        // 지우지 못한 옛 캐시는 다음 판에
      }
      await self.clients.claim()
    })(),
  )
})

const HOME = '/mobile.html'

/** 같은 곳(이 두레 주소)의 길만 — 아니면 첫 화면 */
function sameOriginPath(url) {
  if (typeof url !== 'string' || url === '') return HOME
  try {
    const u = new URL(url, self.location.origin)
    return u.origin === self.location.origin ? u.pathname + u.search + u.hash : HOME
  } catch {
    return HOME
  }
}

// ── PC 에 닿지 않을 때 화면 ──

/** 망이 먼저 — 닿으면 그 답 그대로. 못 닿음·8초 넘게 답 없음·502~504(Tailscale 은 닿았는데 두레가 안 떠 있음)면 미리 받아 둔 fallback */
async function networkOr(request, fallback) {
  let res = null
  let timer
  try {
    res = await Promise.race([
      fetch(request),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), NAVIGATE_TIMEOUT_MS)
      }),
    ])
    if (res.status < 502 || res.status > 504) return res
  } catch {
    res = null
  } finally {
    clearTimeout(timer)
  }
  try {
    const cache = await caches.open(OFFLINE_CACHE)
    const hit = await cache.match(fallback)
    if (hit) return hit
  } catch {
    // 아래로
  }
  return res || Response.error()
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  let u
  try {
    u = new URL(req.url)
  } catch {
    return
  }
  // 다른 곳 · API(WebSocket 포함)는 손대지 않는다
  if (u.origin !== self.location.origin || u.pathname.startsWith('/api/')) return
  if (req.mode === 'navigate') event.respondWith(networkOr(req, OFFLINE_PAGE))
  else if (OFFLINE_FILES.includes(u.pathname)) event.respondWith(networkOr(req, u.pathname))
})

// ── 알림 ──

self.addEventListener('push', (event) => {
  let n = null
  try {
    n = event.data ? event.data.json() : null
  } catch {
    n = null
  }
  if (!n || typeof n !== 'object') n = {}
  const title = typeof n.title === 'string' && n.title ? n.title : '두레'
  // 크롬은 알림 없는 푸시를 받으면 스스로 '백그라운드에서 업데이트됨'을 띄운다 — 글이 깨져도 하나는 띄운다
  const body = typeof n.body === 'string' && n.body ? n.body : '확인할 일이 있어요'
  const options = {
    body,
    renotify: true,
    icon: '/icons/dure-192.png',
    badge: '/icons/dure-badge-96.png',
    vibrate: [120, 60, 120],
    data: { url: sameOriginPath(n.url) },
  }
  // renotify 는 tag 가 있어야 한다 — 없으면 tag 없이(크롬은 renotify 만 있으면 오류)
  if (typeof n.tag === 'string' && n.tag) options.tag = n.tag
  else delete options.renotify
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data
  const url = new URL(sameOriginPath(data && data.url), self.location.origin).href
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const win = wins.find((c) => {
        try {
          return new URL(c.url).origin === self.location.origin
        } catch {
          return false
        }
      })
      if (win) {
        // 열린 두레 — 앞으로 꺼내고 그 대화로(다시 읽지 않는다: 쓰던 글이 남게 화면이 #agent= 로 옮긴다).
        // 꺼내지 못하면(브라우저가 막음) 그 주소로 새로 연다
        let focused = false
        try {
          await win.focus()
          focused = true
        } catch {
          focused = false
        }
        if (focused) {
          win.postMessage({ type: 'dure:open', url })
          return
        }
      }
      await self.clients.openWindow(url)
    })(),
  )
})

/** VAPID 공개 열쇠(base64url) → 바이트 */
function keyBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// 브라우저가 구독을 바꿨거나 지웠다(만료·키 바꿈) — 화면을 열지 않아도 알림이 이어지게 다시 구독해 PC 에 올린다.
// 쿠키(기기 토큰)는 같은 곳 요청이라 실린다 · 안 되면 조용히 그만(다음에 두레를 열 때 화면이 다시 구독한다)
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        let sub = event.newSubscription || null
        if (!sub) {
          const r = await fetch('/api/vapid', { credentials: 'same-origin', cache: 'no-store' })
          const v = await r.json()
          if (!r.ok || !v || v.ok !== true || typeof v.publicKey !== 'string') return
          sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(v.publicKey) })
        }
        await fetch('/api/subscribe', {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ subscription: sub.toJSON() }),
        })
      } catch {
        // 다음에 두레를 열 때
      }
    })(),
  )
})
