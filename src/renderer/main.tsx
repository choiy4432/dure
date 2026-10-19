import '@fontsource/noto-sans-kr/400.css'
import '@fontsource/noto-sans-kr/500.css'
import '@fontsource/noto-sans-kr/700.css'
import '@fontsource/jetbrains-mono/400.css'
import './styles/tokens.css'
import './styles/base.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { getStore } from './state/store'

// 파일을 입력창 밖에 떨어뜨리면 창이 그 파일로 넘어가 버린다 — 막는다(입력창은 스스로 받는다)
window.addEventListener('dragover', e => e.preventDefault())
window.addEventListener('drop', e => e.preventDefault())

const root = createRoot(document.getElementById('root')!)

// 처음 상태를 받은 뒤 그린다 — 받기 전의 빈 상태('첫 방을 만들어 보세요')가 잠깐 비치지 않게
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
