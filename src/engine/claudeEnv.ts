/**
 * 두레가 띄우는 모든 claude 가 거치는 환경 — API 키 변수를 뺀 사본.
 * 사용자 PC 에 ANTHROPIC_API_KEY 가 있으면 claude 가 구독 대신 API 과금으로 돌고 로그인 확인도 통과해 버린다(약관 경계선: API 키를 쓰지 않는다).
 * 대소문자 구분 없이 지운다(Windows 환경 변수는 대소문자를 가리지 않는다). 나머지(PATH·HOME·USERPROFILE·CLAUDE_CONFIG_DIR 등)는 그대로.
 */
const DROPPED = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);

export function claudeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (!DROPPED.has(k.toUpperCase())) out[k] = v;
  }
  return out;
}
