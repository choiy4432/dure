import { describe, it, expect, afterEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { Splash } from '../../src/renderer/shell/Splash'

afterEach(() => cleanup())

describe('Splash — 여는 중', () => {
  it('창 가운데 아이콘 — 읽는 이름 "두레를 여는 중", 움직임 줄이기면 지나온 길을 다 그린 멈춘 D', () => {
    const { container } = render(<Splash />)
    expect(screen.getByRole('status', { name: '두레를 여는 중' })).toBeInTheDocument()
    const trails = container.querySelectorAll('.spl-trail')
    expect(trails).toHaveLength(2)
    trails.forEach(p => expect(p).toHaveAttribute('stroke-dasharray', '100 100'))
  })
})
