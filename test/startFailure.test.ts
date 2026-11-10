import { describe, expect, it } from 'vitest'
import { startFailureMessage } from '../src/main/startFailure'

describe('startFailureMessage', () => {
  it('Error 의 글에서 홈 경로를 ~ 로 가린다', () => {
    const m = startFailureMessage(new Error('EPERM: C:\\Users\\kim\\AppData\\Roaming\\Dure'), 'C:\\Users\\kim')
    expect(m).not.toContain('kim')
    expect(m).toContain('~')
  })
  it('Error 가 아닌 값도 [object Object] 가 되지 않는다', () => {
    const m = startFailureMessage({ code: 'E1' }, 'C:\\Users\\kim')
    expect(m).not.toContain('[object Object]')
    expect(m).toContain('E1')
  })
})
