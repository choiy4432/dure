import { describe, it, expect, afterEach } from 'vitest'
import { render, act, cleanup, waitFor } from '@testing-library/react'
import { StrictMode, createRef, useRef } from 'react'
import { engine } from 'animejs'
import { MOTION, type MotionSpec } from '../../src/renderer/lib/motion'
import { Presence, PresenceList, MotionDiv, useLeaving, useMotion } from '../../src/renderer/lib/presence'
import { allowMotion, fastMotion } from './motion'

afterEach(() => cleanup())

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
/** 한 프레임(jsdom 의 requestAnimationFrame) 기다리기 */
const frame = () => act(() => new Promise<void>(r => requestAnimationFrame(() => r())))

function Flag() {
  return <span data-testid="flag">{String(useLeaving())}</span>
}

function Box({ show, motion = MOTION.pop }: { show: boolean; motion?: MotionSpec }) {
  return (
    <Presence show={show}>
      <MotionDiv motion={motion} origin="top right" data-testid="p">
        목록
        <Flag />
      </MotionDiv>
    </Presence>
  )
}

const opacity = (el: HTMLElement) => parseFloat(el.style.opacity)

describe('Presence · MotionDiv — 들어오기', () => {
  it('처음부터 보이던 것은 들어오지 않는다', async () => {
    allowMotion()
    const { getByTestId } = render(<Box show />)
    await frame()
    await frame()
    expect(getByTestId('p').style.opacity).toBe('')
    expect(getByTestId('p').style.transform).toBe('')
  })

  it('나중에 생긴 것은 들어와 opacity 1 로 끝난다 — 기준점은 origin, 끝나면 transform 을 남기지 않는다', async () => {
    allowMotion()
    const { rerender, getByTestId, queryByTestId } = render(<Box show={false} />)
    expect(queryByTestId('p')).toBeNull()
    rerender(<Box show />)
    const p = getByTestId('p')
    expect(p.style.opacity).toBe('0') // 그리기 전에 시작 값이 붙는다(한 번 번쩍이지 않는다)
    expect(p.style.transformOrigin).toBe('top right')
    fastMotion()
    await waitFor(() => expect(p.style.opacity).toBe('1'))
    // 끝 자리(y 0 · scale 1)의 transform 은 지운다 — 남으면 안쪽 position: fixed 목록의 기준이 이 요소로 바뀐다
    await waitFor(() => expect(p.style.transform).toBe(''))
  })

  it('Presence 밖에서는 늘 들어오고, appear: false 면 들어오지 않는다', async () => {
    allowMotion()
    function Still() {
      const ref = useRef<HTMLDivElement>(null)
      useMotion(ref, MOTION.line, { appear: false })
      return <div ref={ref} data-testid="still" />
    }
    const { getByTestId } = render(
      <>
        <MotionDiv motion={MOTION.line} data-testid="free" />
        <Still />
      </>,
    )
    expect(getByTestId('free').style.opacity).toBe('0')
    fastMotion()
    await waitFor(() => expect(getByTestId('free').style.opacity).toBe('1'))
    expect(getByTestId('still').style.opacity).toBe('')
  })
})

describe('Presence · MotionDiv — 나가기', () => {
  it('닫으면 나가는 동안 남아 있고 누를 수 없다 — 끝나면 사라진다', async () => {
    allowMotion()
    const { rerender, getByTestId, queryByTestId } = render(<Box show />)
    expect(getByTestId('flag').textContent).toBe('false')
    rerender(<Box show={false} />)
    const p = getByTestId('p')
    expect(p.inert).toBe(true)
    expect(p.hasAttribute('inert')).toBe(true)
    expect(p.style.pointerEvents).toBe('none')
    expect(getByTestId('flag').textContent).toBe('true') // useLeaving — 둘러싼 Presence 가 나가는 중
    fastMotion()
    await waitFor(() => expect(queryByTestId('p')).toBeNull())
  })

  it('나가는 중 다시 열면 같은 노드가 그 자리에서 돌아온다', async () => {
    allowMotion()
    const { rerender, getByTestId } = render(<Box show />)
    const node = getByTestId('p')
    fastMotion(0.5) // 나가는 도중을 붙잡을 수 있게 느리게
    rerender(<Box show={false} />)
    await frame()
    await frame()
    const mid = opacity(node)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
    rerender(<Box show />)
    expect(getByTestId('p')).toBe(node)
    expect(node.inert).toBe(false)
    expect(node.hasAttribute('inert')).toBe(false)
    expect(node.style.pointerEvents).toBe('')
    expect(getByTestId('flag').textContent).toBe('false')
    expect(opacity(node)).toBeCloseTo(mid, 2) // 처음 자리로 순간 이동하지 않고 지금 자리에서 이어 간다
    fastMotion()
    await waitFor(() => expect(node.style.opacity).toBe('1'))
    expect(getByTestId('p')).toBe(node)
  })

  it('움직임 줄이기면 같은 렌더에서 사라진다', () => {
    const { rerender, queryByTestId } = render(<Box show />)
    expect(queryByTestId('p')).not.toBeNull()
    rerender(<Box show={false} />)
    expect(queryByTestId('p')).toBeNull()
  })

  it('나가는 움직임을 가진 자식이 없으면(관계도 카드·맨 요소) 같은 렌더에서 사라진다', () => {
    allowMotion()
    const seen: boolean[] = []
    function Seen() {
      seen.push(useLeaving())
      return null
    }
    const node = (show: boolean) => (
      <Presence show={show}>
        <MotionDiv motion={MOTION.node} data-testid="p" />
        <Seen />
      </Presence>
    )
    const { rerender, queryByTestId } = render(node(true))
    rerender(node(false))
    expect(queryByTestId('p')).toBeNull()
    expect(seen).not.toContain(true) // 나가는 중으로 한 번도 그리지 않았다 — 남겨 두었다가 지운 것이 아니다

    const plain = (show: boolean) => (
      <Presence show={show}>
        <div data-testid="plain" />
      </Presence>
    )
    const r = render(plain(true))
    r.rerender(plain(false))
    expect(r.queryByTestId('plain')).toBeNull()
  })

  it('StrictMode 에서도 처음 것은 그대로 · 새로 생긴 것은 들어오고 · 닫으면 나간다', async () => {
    allowMotion()
    const first = render(
      <StrictMode>
        <Box show />
      </StrictMode>,
    )
    await frame()
    expect(first.getByTestId('p').style.opacity).toBe('')
    first.unmount()

    const { rerender, getByTestId, queryByTestId } = render(
      <StrictMode>
        <Box show={false} />
      </StrictMode>,
    )
    rerender(
      <StrictMode>
        <Box show />
      </StrictMode>,
    )
    const p = getByTestId('p')
    fastMotion()
    await waitFor(() => expect(p.style.opacity).toBe('1'))
    rerender(
      <StrictMode>
        <Box show={false} />
      </StrictMode>,
    )
    expect(p.inert).toBe(true)
    await waitFor(() => expect(queryByTestId('p')).toBeNull())
  })

  it('엔진이 멈춰도(끝났다는 알림이 없어도) 나간 것은 exit ms + 200ms 뒤 사라진다', async () => {
    allowMotion()
    const { rerender, queryByTestId } = render(<Box show />)
    // 창이 가려진 것처럼 — 돌던 고리를 멈추고, 새 움직임이 고리를 다시 깨우지도 못하게 한다
    engine.pause()
    engine.useDefaultMainLoop = false
    try {
      rerender(<Box show={false} />)
      await act(() => sleep(MOTION.pop.exit!.ms))
      expect(queryByTestId('p')).not.toBeNull() // 아직 — 움직임이 끝났다는 알림만 기다리지도, 바로 지우지도 않는다
      await act(() => sleep(200 + 50))
      expect(queryByTestId('p')).toBeNull()
    } finally {
      engine.useDefaultMainLoop = true
      engine.resume()
    }
  })
})

describe('PresenceList', () => {
  function List({ keys }: { keys: string[] }) {
    return (
      <PresenceList>
        {keys.map(k => (
          <MotionDiv key={k} motion={MOTION.line} data-testid={k} className="row">
            {k}
          </MotionDiv>
        ))}
      </PresenceList>
    )
  }

  it('처음 key 는 들어오지 않고, 빠진 key 는 제자리에서 나가고, 새 key 는 들어온다', async () => {
    allowMotion()
    const { rerender, container, getByTestId, queryByTestId } = render(<List keys={['a', 'b']} />)
    const texts = () => Array.from(container.querySelectorAll('.row')).map(e => e.textContent)
    const a = getByTestId('a')
    await frame()
    await frame()
    expect(a.style.opacity).toBe('')
    expect(getByTestId('b').style.opacity).toBe('')

    rerender(<List keys={['a', 'c']} />)
    expect(texts()).toEqual(['a', 'b', 'c'])
    expect(getByTestId('b').inert).toBe(true)
    const c = getByTestId('c')
    expect(c.style.opacity).toBe('0')
    fastMotion()
    await waitFor(() => expect(queryByTestId('b')).toBeNull())
    expect(texts()).toEqual(['a', 'c'])
    await waitFor(() => expect(c.style.opacity).toBe('1'))
    expect(getByTestId('a')).toBe(a)
    expect(a.style.opacity).toBe('')
  })

  it('나가는 중 같은 key 가 돌아오면 같은 노드가 되돌아 들어오고, 다 나간 key 가 돌아오면 새로 들어온다', async () => {
    allowMotion()
    const { rerender, container, getByTestId, queryByTestId } = render(<List keys={['a', 'b']} />)
    const texts = () => Array.from(container.querySelectorAll('.row')).map(e => e.textContent)
    const b = getByTestId('b')
    rerender(<List keys={['a']} />)
    expect(b.inert).toBe(true)
    rerender(<List keys={['a', 'b']} />)
    expect(getByTestId('b')).toBe(b)
    expect(b.inert).toBe(false)
    expect(texts()).toEqual(['a', 'b'])

    fastMotion()
    rerender(<List keys={['a']} />)
    await waitFor(() => expect(queryByTestId('b')).toBeNull())
    rerender(<List keys={['b', 'a']} />)
    expect(texts()).toEqual(['b', 'a'])
    const b2 = getByTestId('b')
    expect(b2).not.toBe(b)
    await waitFor(() => expect(b2.style.opacity).toBe('1'))

    // 한 번 다 나갔던 key 도 다시 빠지면 또 나가는 움직임을 거친다
    rerender(<List keys={['a']} />)
    expect(getByTestId('b')).toBe(b2)
    expect(b2.inert).toBe(true)
    await waitFor(() => expect(queryByTestId('b')).toBeNull())
  })

  it('움직임 줄이기면 빠진 key 는 같은 렌더에서 사라진다', () => {
    const { rerender, queryByTestId } = render(<List keys={['a', 'b']} />)
    rerender(<List keys={['a']} />)
    expect(queryByTestId('b')).toBeNull()
  })

  it('같은 key 가 다른 묶음(배열 ↔ 낱개)으로 옮겨도 같은 자식이다 — 나갔다 다시 들어오지 않는다', async () => {
    allowMotion()
    // 고정 카드 자리처럼 — 받은 메시지 목록(배열)에 있던 것이 '최근 전달된 것' 자리(낱개)로 옮긴다
    const row = (k: string) => (
      <MotionDiv key={k} motion={MOTION.line} data-testid={k} className="row">
        {k}
      </MotionDiv>
    )
    const Groups = ({ waiting, delivered }: { waiting: string[]; delivered: string | null }) => (
      <PresenceList>
        {waiting.map(row)}
        {delivered && row(delivered)}
      </PresenceList>
    )
    const { rerender, container, getByTestId } = render(<Groups waiting={['m']} delivered={null} />)
    const m = getByTestId('m')
    rerender(<Groups waiting={[]} delivered="m" />)
    expect(container.querySelectorAll('.row')).toHaveLength(1)
    expect(getByTestId('m')).toBe(m)
    expect(m.hasAttribute('inert')).toBe(false)
    expect(m.style.opacity).toBe('')
  })
})

describe('MotionDiv — 넘겨받은 ref', () => {
  it('여러 목록이 같은 ref 를 나눠 쓸 때 — 앞 목록이 다 나가 떨어져도 ref 는 지금 열린 목록을 가리킨다', async () => {
    allowMotion()
    // 방 목록처럼 — 줄마다 메뉴가 있고 ref 하나(roomMenu)를 같이 쓴다. A 를 열었다가 B 를 열면 A 는 나가는 동안 남는다
    const shared = createRef<HTMLDivElement>()
    const Menus = ({ open }: { open: 'a' | 'b' | null }) => (
      <>
        <Presence show={open === 'a'}>
          <MotionDiv motion={MOTION.pop} ref={shared} data-testid="a" />
        </Presence>
        <Presence show={open === 'b'}>
          <MotionDiv motion={MOTION.pop} ref={shared} data-testid="b" />
        </Presence>
      </>
    )
    const { rerender, getByTestId, queryByTestId } = render(<Menus open={null} />)
    rerender(<Menus open="a" />)
    expect(shared.current).toBe(getByTestId('a'))
    rerender(<Menus open="b" />)
    const b = getByTestId('b')
    expect(getByTestId('a').inert).toBe(true) // A 는 아직 나가는 중
    expect(shared.current).toBe(b)
    fastMotion()
    await waitFor(() => expect(queryByTestId('a')).toBeNull())
    expect(shared.current).toBe(b)
  })

  it('ref 함수가 정리 함수를 돌려주면 떨어질 때 그 정리 함수를 부른다 — null 로 다시 부르지 않는다(React 19)', () => {
    const got: (HTMLDivElement | null)[] = []
    const cleaned: HTMLDivElement[] = []
    const take = (el: HTMLDivElement | null) => {
      got.push(el)
      return () => {
        if (el) cleaned.push(el)
      }
    }
    const { getByTestId, unmount } = render(<MotionDiv motion={MOTION.pop} ref={take} data-testid="p" />)
    const p = getByTestId('p')
    unmount()
    expect(got).toEqual([p])
    expect(cleaned).toEqual([p])
  })

  it('정리 함수가 없는 ref 함수는 지금처럼 떨어질 때 null 로 불린다', () => {
    const got: (HTMLDivElement | null)[] = []
    const take = (el: HTMLDivElement | null) => {
      got.push(el)
    }
    const { getByTestId, unmount } = render(<MotionDiv motion={MOTION.pop} ref={take} data-testid="p" />)
    const p = getByTestId('p')
    unmount()
    expect(got).toEqual([p, null])
  })
})
