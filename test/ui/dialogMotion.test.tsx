import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { animate } from 'animejs'
import { ConfirmDialog } from '../../src/renderer/shell/ConfirmDialog'
import { FormDialog } from '../../src/renderer/shell/FormDialog'
import { Presence } from '../../src/renderer/lib/presence'
import { allowMotion, fastMotion } from './motion'

vi.mock('animejs', async orig => {
  const m = await orig<typeof import('animejs')>()
  return { ...m, animate: vi.fn(m.animate) }
})

afterEach(() => {
  cleanup()
  vi.mocked(animate).mockClear()
})

function Confirm({ onCancel }: { onCancel: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        열기
      </button>
      <button type="button" onClick={() => setOpen(false)}>
        닫기
      </button>
      <ConfirmDialog open={open} title="지울까요?" confirmLabel="지우기" onConfirm={() => {}} onCancel={onCancel} />
    </div>
  )
}

function Form() {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        열기
      </button>
      <Presence show={open}>
        <FormDialog title="새 방" submitLabel="만들기" canSubmit busy={false} onSubmit={() => {}} onClose={() => setOpen(false)}>
          <input aria-label="이름" />
        </FormDialog>
      </Presence>
    </div>
  )
}

const dlg = () => document.querySelector('.dlg') as HTMLElement | null
const bd = () => document.querySelector('.dlg-bd') as HTMLElement | null

describe('대화상자 움직임', () => {
  it('확인 대화상자: 열면 막은 260ms linear, 면은 260ms outQuint · y 14 · scale 0.97 에서', () => {
    allowMotion()
    render(<Confirm onCancel={() => {}} />)
    fireEvent.click(screen.getByText('열기'))
    const calls = vi.mocked(animate).mock.calls
    const b = calls.find(c => c[0] === bd())![1] as any
    expect(b.opacity.from).toBe(0)
    expect(b.duration).toBe(260)
    expect(b.ease).toBe('linear')
    const d = calls.find(c => c[0] === dlg())![1] as any
    expect(d.opacity.from).toBe(0)
    expect(d.translateY.from).toBe(14)
    expect(d.scale.from).toBe(0.97)
    expect(d.duration).toBe(260)
    expect(d.ease).toBe('outQuint')
  })

  it('닫는 순간 초점이 연 버튼으로 돌아간다 — 대화상자는 170ms 동안 남아 inert', async () => {
    allowMotion()
    const restore = fastMotion(1)
    render(<Confirm onCancel={() => {}} />)
    const open = screen.getByText('열기')
    open.focus()
    fireEvent.click(open)
    expect(dlg()!.contains(document.activeElement)).toBe(true)
    fireEvent.click(screen.getByText('닫기'))
    expect(document.activeElement).toBe(open)
    expect(dlg()).not.toBeNull()
    expect(dlg()!.hasAttribute('inert')).toBe(true)
    await waitFor(() => expect(dlg()).toBeNull(), { timeout: 1000 })
    expect(document.activeElement).toBe(open)
    restore()
  })

  it('나가는 중 Esc 는 다시 닫기(onCancel)를 부르지 않는다', () => {
    allowMotion()
    fastMotion(1)
    const onCancel = vi.fn()
    render(<Confirm onCancel={onCancel} />)
    fireEvent.click(screen.getByText('열기'))
    fireEvent.click(screen.getByText('닫기'))
    expect(dlg()).not.toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('입력 대화상자(FormDialog)도 Presence 안에서 같은 움직임으로 닫힌다', async () => {
    allowMotion()
    fastMotion(1)
    render(<Form />)
    const open = screen.getByText('열기')
    open.focus()
    fireEvent.click(open)
    const d = vi.mocked(animate).mock.calls.find(c => c[0] === dlg())![1] as any
    expect(d.translateY.from).toBe(14)
    fireEvent.click(screen.getByText('취소'))
    expect(document.activeElement).toBe(open)
    expect(dlg()!.hasAttribute('inert')).toBe(true)
    const exit = vi.mocked(animate).mock.calls.filter(c => c[0] === dlg()).pop()![1] as any
    expect(exit.duration).toBe(170)
    expect(exit.ease).toBe('outCubic')
    await waitFor(() => expect(dlg()).toBeNull(), { timeout: 1000 })
  })

  it('움직임 줄이기면 지금처럼 같은 렌더에서 사라지고 초점이 돌아간다', () => {
    render(<Confirm onCancel={() => {}} />)
    const open = screen.getByText('열기')
    open.focus()
    fireEvent.click(open)
    expect(dlg()).not.toBeNull()
    fireEvent.click(screen.getByText('닫기'))
    expect(dlg()).toBeNull()
    expect(document.activeElement).toBe(open)
    expect(animate).not.toHaveBeenCalled()
  })
})
