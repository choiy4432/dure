// PC 에 연결하는 동안·닿지 않을 때 화면(offline.html) — 서비스 워커가 화면 열기가 2초 넘게 걸리거나 실패하면 이 화면을 내어 준다.
// head 에서 그리기 전에 돈다: 'PC 에 연결하고 있어요'(로고 + 회전)로 바꾸고, 뒤에서 PC 에 닿는지 본다(/api/me — 짝이 끊겼어도 401 로 답하면 닿은 것).
// 닿으면 같은 주소를 다시 연다(#agent= 같은 조각도 그대로). 열고 CONNECTING_MS(서비스 워커가 기다린 2초까지 10초쯤) 안에 못 닿으면
// 'PC 에 닿지 않아요' + [다시 시도]. 그 뒤에도 화면이 보이는 동안 몇 초마다 · 망이 돌아오면 · 화면이 다시 보이면 저절로 다시 본다.
;(function () {
  /** '연결하고 있어요'를 이만큼 보이고 'PC 에 닿지 않아요'로 */
  var CONNECTING_MS = 8000
  /** 한 번 묻기를 이만큼 기다린다 — PC 가 잠들었으면 답도 실패도 없이 오래 걸린다 */
  var PROBE_TIMEOUT_MS = 4000
  /** 못 닿았으면 이만큼 쉬고 다시 */
  var PROBE_GAP_MS = 3000
  /** [다시 시도]의 '다시 잇는 중…'을 적어도 이만큼 — 바로 실패해도 눌린 것이 보이게 */
  var BUSY_MIN_MS = 600
  /** 서비스 워커에 알린 뒤 다시 열기까지 — 알림이 화면 열기보다 먼저 닿게 */
  var REOPEN_DELAY_MS = 100

  var root = document.documentElement
  var WORDS = { connecting: 'PC 에 연결하고 있어요', offline: 'PC 에 닿지 않아요' }
  var timer = null
  var inflight = null
  var leaving = false

  function status(text) {
    var el = document.getElementById('status')
    if (el) el.textContent = text
  }
  function setState(s) {
    root.setAttribute('data-state', s)
    document.title = '두레 — ' + WORDS[s]
    status(WORDS[s])
  }

  /** PC 의 두레가 답하나 — 200(짝 맺음)·401(짝 끊김 — 다시 열면 짝 맺기 화면)이면 닿음. 502~504·403·못 닿음·늦음은 아님 */
  function reachable() {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null
    var t
    var late = new Promise(function (resolve) {
      t = setTimeout(function () {
        if (ctl) ctl.abort()
        resolve(false)
      }, PROBE_TIMEOUT_MS)
    })
    var probe = fetch('/api/me', { cache: 'no-store', credentials: 'same-origin', signal: ctl ? ctl.signal : undefined }).then(
      function (r) {
        return r.status === 200 || r.status === 401
      },
      function () {
        return false
      },
    )
    return Promise.race([probe, late]).then(function (ok) {
      clearTimeout(t)
      return ok
    })
  }

  /** 닿았다 — 서비스 워커에 '이번 화면 열기는 더 기다려'를 알리고(느린 망에서 이 화면으로 또 돌아오지 않게) 같은 주소를 다시 연다 */
  function reopen() {
    try {
      var sw = navigator.serviceWorker && navigator.serviceWorker.controller
      if (sw) sw.postMessage({ type: 'dure:reconnect' })
    } catch (e) {
      // 못 알려도 다시 연다 — 늦으면 이 화면이 또 시도한다
    }
    setTimeout(function () {
      location.reload()
    }, REOPEN_DELAY_MS)
  }

  function schedule() {
    clearTimeout(timer)
    timer = null
    if (leaving || document.visibilityState === 'hidden') return // 숨은 동안은 묻지 않는다 — 다시 보이면 바로
    timer = setTimeout(check, PROBE_GAP_MS)
  }

  /** 한 번 묻기 — 묻는 중이면 그 답을 같이 기다린다. 닿으면 다시 열고 true */
  function check() {
    clearTimeout(timer)
    timer = null
    if (leaving) return Promise.resolve(true)
    if (inflight) return inflight
    inflight = reachable().then(function (ok) {
      inflight = null
      if (ok) {
        leaving = true
        reopen()
        return true
      }
      schedule()
      return false
    })
    return inflight
  }

  setState('connecting')
  setTimeout(function () {
    if (!leaving && root.getAttribute('data-state') === 'connecting') setState('offline')
  }, CONNECTING_MS)
  void check()

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      clearTimeout(timer)
      timer = null
    } else void check()
  })
  window.addEventListener('online', function () {
    void check()
  })

  document.addEventListener('DOMContentLoaded', function () {
    status(WORDS[root.getAttribute('data-state')] || '')
    var btn = document.getElementById('retry')
    if (!btn) return
    btn.addEventListener('click', function () {
      if (btn.getAttribute('aria-busy') === 'true') return
      btn.setAttribute('aria-busy', 'true')
      status('다시 잇는 중…')
      var t0 = Date.now()
      check().then(function (ok) {
        if (ok) return // 다시 여는 중 — 단추는 '다시 잇는 중…' 그대로
        setTimeout(function () {
          btn.setAttribute('aria-busy', 'false')
          status('아직 PC 에 닿지 않아요')
        }, Math.max(0, BUSY_MIN_MS - (Date.now() - t0)))
      })
    })
  })
})()
