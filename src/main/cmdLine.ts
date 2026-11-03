/**
 * cmd.exe 한 줄 만들기 — 경로·인자에 & ^ % ! ( ) 공백 · 따옴표가 있어도 cmd 가 나누거나 펼치지 않게.
 *
 * 쓰는 법: `spawn('cmd.exe', cmdArgs(줄), { windowsVerbatimArguments: true })` — Node 의 shell:true 와 같은 꼴
 * (`/s /c "<줄>"` 은 바깥 따옴표 한 쌍만 벗긴다). `/d` 는 AutoRun 을 건너뛰고 `/v:off` 는 !이름! 펼침을 끈다.
 *
 * 인자 하나는 두 겹으로 싼다(cross-spawn 과 같은 방법 — https://qntm.org/cmd):
 * 1) 받는 프로그램의 argv 규칙(CommandLineToArgvW) — 큰따옴표로 싸고, " 앞의 \ 는 두 배 + \", 끝의 \ 는 두 배
 * 2) cmd 의 규칙 — 특수 글자 앞마다 ^ (따옴표도 ^"). cmd 가 보기엔 모두 '따옴표 밖의 이스케이프된 글자'라
 *    & | < > 로 나누지 않고, %이름% 은 %이름^% 꼴(끝이 ^ 인 이름은 없다)이라 펼치지 않는다. cmd 는 ^ 를 지운 줄을 넘긴다
 */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g

/** 1) argv 규칙의 따옴표 */
export function argvQuote(arg: string): string {
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`
}

/** 2) cmd 특수 글자 앞에 ^ */
export function cmdEscape(s: string): string {
  return s.replace(CMD_META, '^$1')
}

/** 인자 하나 — 1) 뒤 2) */
export function cmdArg(arg: string): string {
  return cmdEscape(argvQuote(arg))
}

/**
 * `start "" /wait <명령> <인자…>` — cmd 가 명령을 새 콘솔 창으로 띄우고 그게 끝날 때까지 기다린다.
 * 띄운 것은 cmd 의 자식이라 cmd 를 나무째(taskkill /T) 끄면 그 창도 꺼진다 — 기다리지 않으면 cmd 가 바로 끝나 나무가 끊긴다.
 * sameWindow 는 시험용(`/b` — 새 창 없이 같은 콘솔에서)
 */
export function startWaitLine(command: string, args: string[], o: { sameWindow?: boolean } = {}): string {
  return ['start', '""', ...(o.sameWindow ? ['/b'] : []), '/wait', ...[command, ...args].map(cmdArg)].join(' ')
}

/** cmd.exe 에 넘길 인자 — windowsVerbatimArguments: true 와 함께 */
export function cmdArgs(line: string): string[] {
  return ['/d', '/v:off', '/s', '/c', `"${line}"`]
}
