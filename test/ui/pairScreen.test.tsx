import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react'
import { PairScreen, type PairOutcome, type PushOutcome } from '../../src/renderer/mobile/PairScreen'
import { defaultPhoneName, inAppBrowser, isIOS, isSamsung, type PairEnv } from '../../src/renderer/mobile/pairEnv'

afterEach(() => cleanup())

const android: PairEnv = { ios: false, standalone: false, inApp: null, samsung: false, push: true, defaultName: 'Pixel 9' }
const samsung: PairEnv = { ...android, samsung: true, defaultName: 'SM-S931N' }
const iphoneSafari: PairEnv = { ios: true, standalone: false, inApp: null, samsung: false, push: false, defaultName: '아이폰' }
const iphoneHome: PairEnv = { ...iphoneSafari, standalone: true, push: true }

function setup(o: { code?: string | null; env?: PairEnv; pair?: (s: string, n: string) => Promise<PairOutcome>; enablePush?: () => Promise<PushOutcome>; copy?: (t: string) => Promise<boolean> } = {}) {
  const pair = vi.fn(o.pair ?? (async (): Promise<PairOutcome> => ({ ok: true })))
  const enablePush = vi.fn(o.enablePush ?? (async (): Promise<PushOutcome> => 'on'))
  const copy = vi.fn(o.copy ?? (async () => true))
  const onDone = vi.fn()
  render(<PairScreen code={o.code ?? null} env={o.env ?? android} link="https://pc.tail.ts.net/mobile.html#pair=c0de" pair={pair} enablePush={enablePush} copy={copy} onDone={onDone} />)
  return { pair, enablePush, copy, onDone }
}
const heading = () => screen.getByRole('heading', { level: 1 })
const settle = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })

describe('PairScreen — 짝 맺기(B2: 큰 제목 + 아래 고정 단추)', () => {
  it('#pair 코드 — 바로 짝 맺기', async () => {
    const { pair, onDone } = setup({ code: 'c0de' })
    expect(heading()).toHaveTextContent('이 휴대폰을 두레와 짝 맺을까요?')
    const name = screen.getByRole('textbox', { name: '휴대폰 이름' })
    expect(name).toHaveValue('Pixel 9')
    fireEvent.change(name, { target: { value: '내 휴대폰' } })
    fireEvent.click(screen.getByRole('button', { name: '짝 맺기' }))
    await settle()
    expect(pair).toHaveBeenCalledWith('c0de', '내 휴대폰')
    // ② 짝을 맺었어요 → 알림 켜기 / 나중에
    expect(heading()).toHaveTextContent('짝을 맺었어요')
    expect(screen.getByRole('button', { name: '알림 켜기' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /삼성 팝업 설정/ })).toBeNull() // 삼성이 아니면 숨김
    fireEvent.click(screen.getByRole('button', { name: '나중에' }))
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('읽어 주는 프로그램 — 어느 단계든 main 영역 하나 · 이름 칸 오류는 그 칸이 오류 줄을 가리킨다', async () => {
    const outcomes: PairOutcome[] = [
      { ok: false, kind: 'locked', error: '여러 번 틀려서 잠깐 막았어요 — 1분 뒤에 다시 해 주세요' },
      { ok: true },
    ]
    setup({ code: 'c0de', pair: async () => outcomes.shift()! })
    expect(screen.getAllByRole('main')).toHaveLength(1)
    expect(screen.getByRole('main')).toContainElement(heading())
    // 단추는 main 안의 form 그대로 — Enter 로 보낸다
    expect(screen.getByRole('button', { name: '짝 맺기' }).closest('form')).not.toBeNull()
    const name = screen.getByRole('textbox', { name: '휴대폰 이름' })
    const note = name.getAttribute('aria-describedby')!
    expect(note).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '짝 맺기' }))
    await settle()
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('여러 번 틀려서 잠깐 막았어요')
    expect(name.getAttribute('aria-describedby')!.split(' ')).toEqual([note, alert.id])
    fireEvent.click(screen.getByRole('button', { name: '짝 맺기' }))
    await settle()
    expect(heading()).toHaveTextContent('짝을 맺었어요')
    expect(screen.getAllByRole('main')).toHaveLength(1)
    cleanup()
    setup({ env: iphoneHome })
    expect(screen.getAllByRole('main')).toHaveLength(1)
    expect(screen.getByRole('main')).toContainElement(screen.getByLabelText('숫자 6자리'))
    cleanup()
    setup({ env: iphoneSafari })
    expect(screen.getAllByRole('main')).toHaveLength(1)
    cleanup()
    setup({ env: { ...android, inApp: { name: '카카오톡' } } })
    expect(screen.getAllByRole('main')).toHaveLength(1)
  })

  it('QR 코드가 지났거나 이미 썼으면 — 6자리 넣기로, 까닭과 함께', async () => {
    setup({ code: 'old', pair: async () => ({ ok: false, kind: 'wrong', error: '짝 코드나 숫자가 맞지 않아요' }) })
    fireEvent.click(screen.getByRole('button', { name: '짝 맺기' }))
    await settle()
    expect(heading()).toHaveTextContent('PC 에 뜬 숫자 6자리를 넣어 주세요')
    expect(screen.getByRole('alert')).toHaveTextContent('QR 코드가 지났거나 이미 썼어요')
  })

  it('아이폰 사파리 — 홈 화면 안내만', async () => {
    const { pair } = setup({ code: 'c0de', env: iphoneSafari })
    expect(heading()).toHaveTextContent('아이폰은 홈 화면에 추가해 주세요')
    const steps = screen.getAllByRole('listitem')
    expect(steps.map(s => s.textContent)).toEqual([
      expect.stringContaining('공유 단추'),
      expect.stringContaining('홈 화면에 추가'),
      expect.stringContaining('PC 에 뜬 숫자 6자리'),
    ])
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: '짝 맺기' })).toBeNull()
    expect(pair).not.toHaveBeenCalled()
    // 알림 없이 사파리에서 쓰기 — QR 로 열었으면 그 코드로 바로
    fireEvent.click(screen.getByRole('button', { name: '알림 없이 사파리에서 쓰기' }))
    expect(heading()).toHaveTextContent('이 휴대폰을 두레와 짝 맺을까요?')
  })

  it('아이폰 사파리에서 코드 없이 — 알림 없이 쓰기는 6자리 넣기, 짝 맺으면 알림 묻지 않고 바로', async () => {
    const { pair, onDone, enablePush } = setup({ env: iphoneSafari })
    fireEvent.click(screen.getByRole('button', { name: '알림 없이 사파리에서 쓰기' }))
    expect(heading()).toHaveTextContent('PC 에 뜬 숫자 6자리를 넣어 주세요')
    fireEvent.change(screen.getByLabelText('숫자 6자리'), { target: { value: '482017' } }) // 6자리가 차면 바로 보낸다
    await settle()
    expect(pair).toHaveBeenCalledTimes(1)
    expect(pair).toHaveBeenCalledWith('482017', '아이폰')
    expect(onDone).toHaveBeenCalledTimes(1) // 사파리는 알림을 못 받는다 — 알림 켜기 화면 없이
    expect(enablePush).not.toHaveBeenCalled()
  })

  it('홈 화면 앱 — 6자리 넣기', async () => {
    const outcomes: PairOutcome[] = [
      { ok: false, kind: 'wrong', error: '짝 코드나 숫자가 맞지 않아요' },
      { ok: false, kind: 'expired', error: '짝 코드가 지났어요 — PC 에서 [휴대폰 짝 맺기]를 다시 눌러 주세요' },
      { ok: false, kind: 'locked', error: '여러 번 틀려서 잠깐 막았어요 — 1분 뒤에 다시 해 주세요' },
      { ok: true },
    ]
    const { pair } = setup({ env: iphoneHome, pair: async () => outcomes.shift()! })
    expect(heading()).toHaveTextContent('PC 에 뜬 숫자 6자리를 넣어 주세요')
    expect(screen.getByText('PC 두레 → 설정 → 휴대폰 → 휴대폰 짝 맺기')).toBeInTheDocument()
    const pin = screen.getByLabelText('숫자 6자리')
    expect(pin).toHaveAttribute('inputmode', 'numeric')
    expect(pin).toHaveAttribute('autocomplete', 'one-time-code')
    expect(pin).toHaveFocus()
    const go = screen.getByRole('button', { name: '짝 맺기' })
    expect(go).toBeDisabled()
    fireEvent.change(pin, { target: { value: '48a2 0' } })
    expect(pin).toHaveValue('4820') // 숫자만
    expect(go).toBeDisabled()
    expect(pair).not.toHaveBeenCalled()

    // 6자리가 차면 바로 보낸다(아이폰 숫자 자판엔 '이동' 키가 없다) — 7자리째는 버린다
    fireEvent.change(pin, { target: { value: '4820171' } })
    await settle()
    expect(pair).toHaveBeenCalledTimes(1)
    expect(pair).toHaveBeenLastCalledWith('482017', '아이폰')
    expect(screen.getByRole('alert')).toHaveTextContent('숫자가 맞지 않아요 — 다시 넣어 주세요')
    expect(pin).toHaveAttribute('aria-describedby', screen.getByRole('alert').id)
    // 틀리면 칸을 비우고 그 칸으로 — 바로 다시 친다
    expect(pin).toHaveValue('')
    expect(pin).toHaveFocus()
    // 고치기 시작하면 오류 줄이 사라진다
    fireEvent.change(pin, { target: { value: '4' } })
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.change(pin, { target: { value: '482018' } })
    await settle()
    expect(screen.getByRole('alert')).toHaveTextContent('시간이 지났어요')
    fireEvent.change(pin, { target: { value: '482019' } })
    await settle()
    expect(screen.getByRole('alert')).toHaveTextContent('여러 번 틀려서 잠깐 막았어요')
    // 막힘은 숫자를 그대로 둔다 — 1분 뒤 단추로 다시
    expect(pin).toHaveValue('482019')
    fireEvent.click(screen.getByRole('button', { name: '짝 맺기' }))
    await settle()
    expect(pair).toHaveBeenCalledTimes(4)
    expect(heading()).toHaveTextContent('짝을 맺었어요')
  })

  it('보내는 동안 — 단추 글이 바뀌고(흐려지지 않음) 읽어 주는 프로그램에 알린다 · 두 번 보내지 않는다', async () => {
    let finish: (r: PairOutcome) => void = () => {}
    const { pair } = setup({ code: 'c0de', pair: () => new Promise<PairOutcome>(r => { finish = r }) })
    fireEvent.click(screen.getByRole('button', { name: '짝 맺기' }))
    const busy = screen.getByRole('button', { name: '짝 맺는 중…' })
    expect(busy).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('짝 맺는 중…')
    fireEvent.submit(busy.closest('form')!)
    expect(pair).toHaveBeenCalledTimes(1)
    await act(async () => finish({ ok: true }))
    expect(heading()).toHaveTextContent('짝을 맺었어요')
  })

  it('짝을 맺은 뒤 — 삼성만 팝업 설정(접은 줄) · 알림을 켜면 펼쳐 보이고 두레 열기', async () => {
    const { enablePush, onDone } = setup({ code: 'c0de', env: samsung })
    fireEvent.click(screen.getByRole('button', { name: '짝 맺기' }))
    await settle()
    const fold = screen.getByRole('button', { name: '삼성 팝업 설정' })
    expect(fold).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(/앱별 알림 카테고리 관리/)).toBeNull()
    fireEvent.click(fold)
    expect(fold).toHaveAttribute('aria-expanded', 'true')
    const steps = screen.getAllByRole('listitem').map(li => li.textContent)
    expect(steps).toEqual([
      expect.stringContaining('설정 → 알림 → 고급 설정'),
      expect.stringContaining('앱별 알림 카테고리 관리'),
      expect.stringContaining('팝업으로 표시'),
    ])
    fireEvent.click(screen.getByRole('button', { name: '알림 켜기' }))
    await settle()
    expect(enablePush).toHaveBeenCalledTimes(1)
    // 켠 뒤에야 따라 할 수 있는 설정 — 펼쳐 둔 채 머문다
    expect(heading()).toHaveTextContent('알림을 켰어요')
    expect(screen.getByRole('button', { name: '삼성 팝업 설정' })).toHaveAttribute('aria-expanded', 'true')
    expect(onDone).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '두레 열기' }))
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('삼성이 아니면 알림을 켜자마자 두레로', async () => {
    const { onDone } = setup({ code: 'c0de' })
    fireEvent.click(screen.getByRole('button', { name: '짝 맺기' }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: '알림 켜기' }))
    await settle()
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('알림을 막아 두었으면 — 까닭을 보이고 단추는 알림 없이 계속', async () => {
    const { onDone } = setup({ code: 'c0de', enablePush: async () => 'denied' })
    fireEvent.click(screen.getByRole('button', { name: '짝 맺기' }))
    await settle()
    fireEvent.click(screen.getByRole('button', { name: '알림 켜기' }))
    await settle()
    expect(screen.getByRole('alert')).toHaveTextContent('알림이 막혀 있어요')
    expect(onDone).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '알림 켜기' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '알림 없이 계속' }))
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('앱 안 브라우저 — 크롬으로 열어 주세요 · 주소 복사(짝 코드 든 주소)', async () => {
    const { copy, pair } = setup({ code: 'c0de', env: { ...android, inApp: { name: '카카오톡' } } })
    expect(heading()).toHaveTextContent('크롬으로 열어 주세요')
    expect(screen.getByText(/카카오톡 안에서는 알림을 받을 수 없어요/)).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '주소 복사' }))
    await settle()
    expect(copy).toHaveBeenCalledWith('https://pc.tail.ts.net/mobile.html#pair=c0de')
    expect(screen.getByRole('button', { name: '복사했어요' })).toBeInTheDocument()
    expect(pair).not.toHaveBeenCalled()
  })

  it('앱 안 브라우저(아이폰) — 사파리로 · 복사가 안 되면 주소를 직접 고를 수 있게', async () => {
    setup({ env: { ...iphoneSafari, inApp: { name: null } }, copy: async () => false })
    expect(heading()).toHaveTextContent('사파리로 열어 주세요')
    expect(screen.getByText(/이 앱 안에서는 알림을 받을 수 없어요/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '주소 복사' }))
    await settle()
    expect(screen.getByRole('textbox', { name: '두레 주소' })).toHaveValue('https://pc.tail.ts.net/mobile.html#pair=c0de')
  })
})

describe('pairEnv — 어떤 브라우저인가', () => {
  const UA = {
    kakaoAndroid: 'Mozilla/5.0 (Linux; Android 14; SM-S931N Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0 Mobile Safari/537.36;KAKAOTALK 2410870',
    kakaoIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 10.9.0',
    naver: 'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36 NAVER(inapp; search; 2000; 12.10.4)',
    instagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 355.0.0.0',
    facebook: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/490.0]',
    line: 'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36 Line/14.19.1',
    webview: 'Mozilla/5.0 (Linux; Android 14; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0 Mobile Safari/537.36',
    chrome: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    samsungInternet: 'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S931N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0 Mobile Safari/537.36',
    safari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
    crios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1',
    ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  }

  it('inAppBrowser — 카카오톡·네이버·인스타그램·페이스북·라인·안드로이드 웹뷰는 앱 안, 크롬·삼성 인터넷·사파리는 아님', () => {
    expect(inAppBrowser(UA.kakaoAndroid)).toEqual({ name: '카카오톡' })
    expect(inAppBrowser(UA.kakaoIos)).toEqual({ name: '카카오톡' })
    expect(inAppBrowser(UA.naver)).toEqual({ name: '네이버 앱' })
    expect(inAppBrowser(UA.instagram)).toEqual({ name: '인스타그램' })
    expect(inAppBrowser(UA.facebook)).toEqual({ name: '페이스북' })
    expect(inAppBrowser(UA.line)).toEqual({ name: '라인' })
    expect(inAppBrowser(UA.webview)).toEqual({ name: null })
    expect(inAppBrowser(UA.chrome)).toBeNull()
    expect(inAppBrowser(UA.samsungInternet)).toBeNull()
    expect(inAppBrowser(UA.safari)).toBeNull()
    expect(inAppBrowser(UA.crios)).toBeNull()
  })

  it('inAppBrowser — 이름 표시가 없는 앱 안 브라우저도: 아이폰(홈 화면 앱 아님)에 Safari/ 가 없음 · 안드로이드에 PushManager 없음', () => {
    const daum = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 DaumApps/8.10.0 DaumDevice/mobile'
    const band = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 BAND/16.2.1 iOS(18.1)'
    const iosHomeApp = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
    const ios = { ios: true, standalone: false, pushManager: false }
    expect(inAppBrowser(daum, ios)).toEqual({ name: null })
    expect(inAppBrowser(band, ios)).toEqual({ name: null })
    // 홈 화면 앱(설치한 웹 앱)의 UA 에도 Safari/ 가 없다 — 앱 안이 아니다
    expect(inAppBrowser(iosHomeApp, { ...ios, standalone: true })).toBeNull()
    // 사파리·아이폰 크롬·아이패드(데스크톱 꼴)는 Safari/ 가 있다
    expect(inAppBrowser(UA.safari, ios)).toBeNull()
    expect(inAppBrowser(UA.crios, ios)).toBeNull()
    expect(inAppBrowser(UA.ipad, ios)).toBeNull()
    // 이름표가 있으면 그 이름이 먼저
    expect(inAppBrowser(UA.kakaoIos, ios)).toEqual({ name: '카카오톡' })

    // 안드로이드 — 웹 푸시를 못 받는 브라우저(앱 안 웹뷰가 ; wv 를 지운 것 등)
    const android = { ios: false, standalone: false, pushManager: false }
    expect(inAppBrowser(UA.chrome, android)).toEqual({ name: null })
    expect(inAppBrowser(UA.chrome, { ...android, pushManager: true })).toBeNull()
    expect(inAppBrowser(UA.samsungInternet, { ...android, pushManager: true })).toBeNull()
    // 데스크톱(안드로이드·아이폰 아님)은 PushManager 가 없어도 앱 안으로 치지 않는다
    expect(inAppBrowser('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36', android)).toBeNull()
  })

  it('isIOS — 아이폰·아이패드(데스크톱 꼴 UA + 터치)', () => {
    expect(isIOS(UA.safari, 5)).toBe(true)
    expect(isIOS(UA.crios, 5)).toBe(true)
    expect(isIOS(UA.ipad, 5)).toBe(true)
    expect(isIOS(UA.ipad, 0)).toBe(false) // 진짜 맥
    expect(isIOS(UA.chrome, 5)).toBe(false)
  })

  it('defaultPhoneName — 삼성 모델 번호엔 갤럭시 · 아이폰 · 모르면 휴대폰', () => {
    expect(defaultPhoneName('SM-S931N', false)).toBe('갤럭시 SM-S931N')
    expect(defaultPhoneName('Pixel 9', false)).toBe('Pixel 9')
    expect(defaultPhoneName('', true)).toBe('아이폰')
    expect(defaultPhoneName('', false)).toBe('휴대폰')
  })

  it('isSamsung — UA-CH 모델이 SM- 로 시작하거나 UA 에 삼성 표시', () => {
    expect(isSamsung('SM-S931N', UA.chrome)).toBe(true)
    expect(isSamsung('', UA.samsungInternet)).toBe(true)
    expect(isSamsung('Pixel 9', UA.chrome)).toBe(false)
    expect(isSamsung('', UA.chrome)).toBe(false)
  })
})

describe('PairScreen — 짝을 맺은 화면의 두레 앱 띠(설계 §5.4-3 · 방 목록과 같은 띠)', () => {
  const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 15; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36'
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
  const PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'
  const STEER = '두레 앱으로 쓰면 알림에 주소가 안 붙어요.'
  let pcApp: { versionCode: number; packageName: string } | null
  let me: ReturnType<typeof vi.fn>

  const as = (ua: string, referrer = '') => {
    Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true })
    Object.defineProperty(document, 'referrer', { value: referrer, configurable: true })
  }
  /** 띠 모듈이 /api/me 를 한 번 받아 두니 시험마다 새로 읽는다 */
  async function pairOn(env: PairEnv = android) {
    vi.resetModules()
    const { PairScreen: Fresh } = await import('../../src/renderer/mobile/PairScreen')
    const enablePush = vi.fn(async (): Promise<PushOutcome> => 'on')
    render(<Fresh code="c0de" env={env} link="https://pc.tail0000.ts.net/mobile.html" pair={async () => ({ ok: true })} enablePush={enablePush} copy={async () => true} onDone={() => {}} />)
    expect(me).not.toHaveBeenCalled() // 짝을 맺기 전엔 묻지 않는다(401)
    fireEvent.click(screen.getByRole('button', { name: '짝 맺기' }))
    await settle()
    return { enablePush }
  }

  beforeEach(() => {
    sessionStorage.clear()
    pcApp = { versionCode: 3, packageName: 'io.github.choiy4432.dure' }
    me = vi.fn(async (u: string) =>
      String(u).endsWith('/api/me')
        ? new Response(JSON.stringify({ ok: true, device: { id: 'd', name: '내 휴대폰', createdAt: 1, lastSeen: 1, push: false }, androidApp: pcApp }), { status: 200 })
        : new Response(null, { status: 404 }),
    )
    vi.stubGlobal('fetch', me)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete (navigator as any).userAgent
    delete (document as any).referrer
  })

  it('안드로이드 크롬 + PC 가 앱을 내어 줌 — 짝을 맺었어요 화면에 띠 · [두레 앱으로 열기] = 방 목록과 같은 intent 링크(앱이 없으면 /dure.apk) · 띠의 [나중에]는 없다', async () => {
    as(ANDROID_CHROME)
    await pairOn()
    expect(heading()).toHaveTextContent('짝을 맺었어요')
    const band = await screen.findByRole('region', { name: '두레 앱으로 쓰기' })
    expect(band).toHaveTextContent(STEER)
    expect(band).toHaveClass('m-appband')
    expect(within(band).getByRole('link', { name: '두레 앱으로 열기' }).getAttribute('href')).toBe(
      `intent://${location.host}${location.pathname}#Intent;scheme=https;package=io.github.choiy4432.dure;S.browser_fallback_url=${encodeURIComponent(`${location.origin}/dure.apk`)};end`,
    )
    expect(within(band).queryByRole('button', { name: '나중에' })).toBeNull()
    // 알림 단추들은 그대로(맨 아래)
    expect(screen.getByRole('button', { name: '알림 켜기' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: '나중에' })).toHaveLength(1)
  })

  it('삼성 — 알림을 켠 뒤의 화면(알림을 켰어요)에도 띠', async () => {
    as(ANDROID_CHROME)
    await pairOn(samsung)
    await screen.findByRole('region', { name: '두레 앱으로 쓰기' })
    fireEvent.click(screen.getByRole('button', { name: '알림 켜기' }))
    await settle()
    expect(heading()).toHaveTextContent('알림을 켰어요')
    expect(await screen.findByRole('region', { name: '두레 앱으로 쓰기' })).toHaveTextContent(STEER)
  })

  it('PC 에 앱 파일이 없으면(androidApp null) · 두레 것이 아닌 패키지면 띠 없음', async () => {
    for (const app of [null, { versionCode: 3, packageName: 'com.evil.app' }]) {
      pcApp = app
      as(ANDROID_CHROME)
      await pairOn()
      await settle()
      expect(me).toHaveBeenCalled()
      expect(screen.queryByText(STEER), String(app?.packageName)).toBeNull()
      cleanup()
      me.mockClear()
    }
  })

  it('아이폰 · PC 브라우저 · 두레 앱 안 — 띠 없음(/api/me 도 묻지 않는다)', async () => {
    for (const [ua, referrer] of [[IPHONE, ''], [PC, ''], [ANDROID_CHROME, 'android-app://io.github.choiy4432.dure/']]) {
      as(ua, referrer)
      await pairOn(ua === IPHONE ? iphoneHome : android)
      await settle()
      expect(heading()).toHaveTextContent('짝을 맺었어요')
      expect(screen.queryByText(STEER), ua).toBeNull()
      cleanup()
    }
    expect(me).not.toHaveBeenCalled()
  })
})
