# 두레(Dure) — Claude 작업 규칙

- 두레 = 여러 Claude 에이전트가 서로 일을 넘기는 Windows 데스크톱 앱. 지금은 UI 없는 TypeScript 엔진부터 만든다.
- 설계: `docs/superpowers/specs/2026-10-19-dure-design.md` · 실측(findings): `docs/findings/2026-10-19-headless-probe.md` · 계획: `docs/superpowers/plans/`
- 🔴 약관 경계선:
  - 앱에 Claude Code 바이너리를 넣어 배포하지 않는다. 사용자 PC 의 `claude` 를 부른다.
  - 자격 증명 파일(`%USERPROFILE%\.claude\.credentials.json` 등)을 읽지도 옮기지도 않는다. `initialize` 응답의 `account` 도 읽지·저장하지 않는다.
  - `--bare` 를 쓰지 않는다. API 키를 쓰지 않는다.
  - 제품·패키지 이름에 "Claude Code" 를 쓰지 않는다. 이름은 `dure` / 두레.
  - 공개 레포 — 커밋에 이메일·로컬 사용자 경로·토큰을 넣지 않는다.
- 🔴 모든 에이전트 실행에 `--disallowedTools SendMessage ListAgents` 필수. 빠지면 Claude 가 두레의 `send_message` 대신 내장 세션 메시지를 고른다(findings).
- UI 규칙(설계 §10): 테마·레이아웃은 시안 2~3벌을 브라우저에 띄워 사용자가 고른 뒤에 구현한다. 고르기 전엔 그 화면을 구현하지 않는다. 화면마다 `/impeccable` 로 AI slop 을 점검한다.
- 답과 UI 문구는 한국어.
- 확인: `npm test` · `npm run typecheck`
