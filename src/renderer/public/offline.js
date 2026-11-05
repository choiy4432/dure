// PC 에 닿지 않을 때 화면(offline.html)의 단추 — 같은 주소를 다시 연다(#agent= 같은 조각도 그대로). 망이 돌아와도 저절로 다시.
// 다시 여는 동안(서비스 워커가 8초까지 기다린다) 단추에 '다시 잇는 중…' — 여러 번 누르지 않게
;(function () {
  var btn = document.getElementById('retry')
  var status = document.getElementById('status')
  function retry() {
    if (btn.getAttribute('aria-busy') === 'true') return
    btn.setAttribute('aria-busy', 'true')
    if (status) status.textContent = '다시 잇는 중…'
    location.reload()
  }
  btn.addEventListener('click', retry)
  window.addEventListener('online', retry)
})()
