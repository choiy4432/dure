import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { App } from '../../src/renderer/App'

describe('ui test environment', () => {
  it('runs in jsdom and renders React', () => {
    expect(typeof document).toBe('object')
    const { container } = render(<App />)
    expect(document.body.contains(container)).toBe(true)
    render(<p>안녕</p>)
    expect(screen.getByText('안녕').tagName).toBe('P')
  })
})
