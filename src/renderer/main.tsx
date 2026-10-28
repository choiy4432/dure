import '@fontsource/noto-sans-kr/400.css'
import '@fontsource/noto-sans-kr/500.css'
import '@fontsource/noto-sans-kr/700.css'
import '@fontsource/jetbrains-mono/400.css'
import './styles/tokens.css'
import './styles/base.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { Splash } from './shell/Splash'
import { getStore } from './state/store'
import { followClockBack } from './lib/animeClock'

// 파일을 입력창 밖에 떨어뜨리면 창이 그 파일로 넘어가 버린다 — 막는다(입력창은 스스로 받는다)
window.addEventListener('dragover', e => e.preventDefault())
window.addEventListener('drop', e => e.preventDefault())

// PC 시계를 뒤로 돌려도 움직임이 첫 장면(투명)에 멈추지 않게 · 바꾼 시계에 '작업 중 N초'를 맞춘다(이벤트가 없는 동안에도)
followClockBack()
setInterval(() => getStore().followClock(), 1000)

const root = createRoot(document.getElementById('root')!)

// 처음 상태를 받은 뒤 그린다 — 받기 전의 빈 상태('첫 방을 만들어 보세요')가 잠깐 비치지 않게. 그 사이엔 여는 중(움직이는 아이콘)
root.render(<Splash />)
getStore()
  .init()
  .catch(err => console.error('두레: 처음 상태를 받지 못했어요', err))
  .finally(() =>
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    ),
  )
