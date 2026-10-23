import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { ImageViewer, type ViewerSource } from '../../src/renderer/panel/ImageViewer'
import { forgetSavedImages } from '../../src/renderer/panel/savedImage'

let image: ReturnType<typeof vi.fn>

beforeEach(() => {
  forgetSavedImages()
  image = vi.fn(async (_id: string, file: string) => (file === 'gone.png' ? null : `data:image/png;base64,${file}`))
  ;(window as any).dure = { image }
})
afterEach(() => cleanup())

/** 여는 버튼 + 보기 막 — 부르는 쪽처럼 열린 번호를 들고 있다 */
function Harness({ sources, start = 0, onClose }: { sources: ViewerSource[]; start?: number; onClose?: () => void }) {
  const [at, setAt] = useState<number | null>(null)
  return (
    <>
      <button type="button" onClick={() => setAt(start)}>열기</button>
      <ImageViewer
        open={at !== null}
        sources={sources}
        index={at ?? 0}
        onIndex={setAt}
        onClose={() => {
          setAt(null)
          onClose?.()
        }}
      />
    </>
  )
}

const urls: ViewerSource[] = [{ url: 'blob:dure/1' }, { url: 'blob:dure/2' }]
const open = () => fireEvent.click(screen.getByRole('button', { name: '열기' }))
const shown = () => screen.getByRole('dialog').querySelector('.iv-img') as HTMLImageElement | null

describe('ImageViewer', () => {
  it('누르면 흐린 막 위에 큰 그림 — 몇 번째인지와 함께', () => {
    render(<Harness sources={urls} />)
    open()
    const dlg = screen.getByRole('dialog', { name: '이미지 보기' })
    expect(dlg).toHaveAttribute('aria-modal', 'true')
    expect(dlg).toHaveClass('iv-bd')
    expect(shown()).toHaveAttribute('src', 'blob:dure/1')
    expect(shown()).toHaveAttribute('alt', '이미지 1/2')
    expect(dlg).toHaveTextContent('1 / 2')
  })

  it('다음·이전 버튼과 ← → 키로 넘긴다 — 끝에서는 그쪽 버튼이 막힌다', () => {
    render(<Harness sources={urls} />)
    open()
    expect(screen.getByRole('button', { name: '이전 이미지' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '다음 이미지' }))
    expect(shown()).toHaveAttribute('src', 'blob:dure/2')
    expect(screen.getByRole('dialog')).toHaveTextContent('2 / 2')
    expect(screen.getByRole('button', { name: '다음 이미지' })).toBeDisabled()
    fireEvent.keyDown(document, { key: 'ArrowRight' }) // 끝 — 그대로
    expect(shown()).toHaveAttribute('src', 'blob:dure/2')
    fireEvent.keyDown(document, { key: 'ArrowLeft' })
    expect(shown()).toHaveAttribute('src', 'blob:dure/1')
  })

  it('한 장이면 넘기기 버튼도 번호도 없다', () => {
    render(<Harness sources={[{ url: 'blob:dure/1' }]} />)
    open()
    expect(screen.queryByRole('button', { name: '다음 이미지' })).toBeNull()
    expect(screen.getByRole('dialog')).not.toHaveTextContent('1 / 1')
  })

  it('Esc · 닫기 버튼 · 막을 누르면 닫힌다 — 그림을 눌러선 안 닫힌다', () => {
    const onClose = vi.fn()
    render(<Harness sources={urls} onClose={onClose} />)
    open()
    fireEvent.pointerDown(shown()!)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.pointerDown(screen.getByRole('dialog'))
    expect(onClose).toHaveBeenCalledTimes(1)
    open()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
    open()
    fireEvent.click(screen.getByRole('button', { name: '닫기' }))
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('열리면 초점은 안으로, 닫으면 연 버튼으로 돌아간다', () => {
    render(<Harness sources={urls} />)
    const opener = screen.getByRole('button', { name: '열기' })
    opener.focus()
    open()
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.activeElement).toBe(opener)
  })

  it('저장한 그림은 엔진에서 읽어 온다 — 같은 그림은 한 번만', async () => {
    render(<Harness sources={[{ agentId: 'w', file: 'a.png' }, { agentId: 'w', file: 'a.png' }]} />)
    open()
    await act(async () => {})
    expect(shown()).toHaveAttribute('src', 'data:image/png;base64,a.png')
    fireEvent.click(screen.getByRole('button', { name: '다음 이미지' }))
    await act(async () => {})
    expect(shown()).toHaveAttribute('src', 'data:image/png;base64,a.png')
    expect(image).toHaveBeenCalledTimes(1)
    expect(image).toHaveBeenCalledWith('w', 'a.png')
  })

  it('저장하기 전에 보낸 그림 · 없어진 그림은 그림 대신 안내', async () => {
    render(<Harness sources={[{ agentId: 'w', file: null }, { agentId: 'w', file: 'gone.png' }]} />)
    open()
    expect(shown()).toBeNull()
    expect(screen.getByRole('dialog')).toHaveTextContent('저장하기 전에 보낸 그림이라 볼 수 없어요')
    expect(image).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '다음 이미지' }))
    await act(async () => {})
    expect(shown()).toBeNull()
    expect(screen.getByRole('dialog')).toHaveTextContent('그림을 찾을 수 없어요')
  })

  it('읽다 실패하면(엔진 오류) 안내하고 다음에 다시 읽는다', async () => {
    image.mockRejectedValueOnce(new Error('끊김'))
    render(<Harness sources={[{ agentId: 'w', file: 'b.png' }]} />)
    open()
    await act(async () => {})
    expect(screen.getByRole('dialog')).toHaveTextContent('그림을 찾을 수 없어요')
    fireEvent.keyDown(document, { key: 'Escape' })
    open()
    await act(async () => {})
    expect(shown()).toHaveAttribute('src', 'data:image/png;base64,b.png')
  })
})
