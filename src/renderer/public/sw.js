// 두레 휴대폰 서비스 워커 — 웹 푸시 알림만(오프라인 캐시는 하지 않는다: 화면은 늘 PC 의 지금 두레에서).
// 알림 글은 PC(main 의 phoneNotifier)가 정한 네 칸 { title, body, tag, url } 뿐 — 명령·대화 글은 오지 않는다.

// 새 판을 받으면 바로 맡는다 — 안 그러면 알림을 예전 판이 띄워 badge·icon 이 기본값으로 나온다(실측)
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
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
        // 열린 두레 — 앞으로 꺼내고 그 대화로(다시 읽지 않는다: 쓰던 글이 남게 화면이 #agent= 로 옮긴다)
        await win.focus()
        win.postMessage({ type: 'dure:open', url })
        return
      }
      await self.clients.openWindow(url)
    })(),
  )
})
