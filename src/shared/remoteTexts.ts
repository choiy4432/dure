// 서버(SSH) 방 문제의 글 — 엔진의 대화 알림 줄과 화면의 안내 띠가 같은 글자를 쓰도록 한 곳에 둔다(설계 4.6 문구 표).
import type { RemoteIssue } from '../engine/types'

/** 문제 한 줄 — login 은 안내 띠 제목(설명은 REMOTE_LOGIN_HELP). 접속 실패는 ssh 오류 첫 줄을 ' — ' 뒤에 */
export function remoteIssueText(host: string, issue: RemoteIssue): string {
  switch (issue.kind) {
    case 'denied':
      return `${host} 에 키로 접속할 수 없어요 — SSH 키를 등록해 주세요`
    case 'hostkey':
      return `${host} 의 서버 키가 바뀌었어요 — 서버가 바뀐 게 맞는지 확인한 뒤 known_hosts 를 고쳐 주세요`
    case 'no-claude':
      return `${host} 에 claude 가 없어요`
    case 'no-folder':
      return '서버에 그 폴더가 없어요'
    case 'disconnected':
      return `${host} 연결이 끊겼어요 — 다시 보내면 이어서 해요`
    case 'login':
      return `${host} 의 claude 로그인이 만료됐어요`
    default:
      // unreachable(그리고 화면에 오지 않는 port)
      return `${host} 에 접속하지 못했어요${issue.detail ? ` — ${issue.detail}` : ''}`
  }
}

/** 로그인 만료 안내 띠의 설명 줄 */
export const REMOTE_LOGIN_HELP = '서버 터미널에서 claude 를 실행해 /login 해 주세요 — 다시 보내면 이어서 해요'

/** 원격 포트를 바꿔 가며 다시 해도 서버가 전달을 열지 않았다 — 그 에이전트의 오류 글(ssh 날글 대신) */
export function remotePortBlockedText(host: string): string {
  return `${host} 에서 포트 전달이 막혀 있어요 — 서버의 sshd 설정(AllowTcpForwarding)을 확인해 주세요`
}

/** 두레가 서버의 claude 를 정리하지 못했다(두 번 해 봄) — 그 에이전트 기록에 한 줄 */
export const REMOTE_CLEANUP_FAILED = '서버의 claude 를 끄지 못했어요 — 서버에서 직접 확인해 주세요'
