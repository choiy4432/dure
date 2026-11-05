// 테스트용 가짜 tailscale — 진짜 tailscale.exe 대신 띄운다(손잡이 { command: node, args: [이 파일] }, DURE_TAILSCALE_COMMAND/ARGS).
// 꼴은 실측 그대로(probe28 — .superpowers/sdd/2026-11-04-dure-phone-remote/task-1-report.md, Windows Tailscale):
//   status --json                                → 최상위 칸 BackendState·Self(DNSName 끝에 '.', Online)·CertDomains·User(사용자 칸) …, 코드 0
//   serve status --json                          → serve 설정 JSON(아무것도 없으면 {}), 코드 0
//   serve --bg --https=<P> http://127.0.0.1:<L>  → 바로 끝남(0), 'Available within your tailnet: …' 안내.
//                                                  Serve 가 꺼진 tailnet 이면 끝나지 않고 켜기 링크를 찍은 채 기다린다
//   serve --https=<P> off                        → 코드 0, 출력 없음(그 포트의 '/' 길만 지움)
// 실측 안 한 꼴(그럴듯하게만): 서비스가 안 돌 때의 글 · 로그인 안 됐을 때 serve 의 글 · 없는 길을 off 할 때의 글.
// 🔴 두레는 `serve reset`·`funnel` 을 쓰지 않는다 — 들어오면 코드 3 으로 크게 실패한다(시험이 잡게).
//
// 손잡이(환경 변수):
//   FAKE_TAILSCALE_STATE      missing | logged-out | no-https | ready(기본)
//                             missing    = CLI 는 있는데 Tailscale 서비스가 안 돎 — 모든 명령이 stderr 한 줄 뒤 코드 1
//                             logged-out = BackendState 'NeedsLogin' · serve 를 켜려 하면 코드 1
//                             no-https   = Running 인데 CertDomains 가 빈 배열 · serve --bg 는 켜기 링크를 찍고 끌 때까지 기다림(안전 상한 60초)
//                             ready      = Running · CertDomains 에 이 기기 이름
//   FAKE_TAILSCALE_LOG        받은 인자를 한 줄에 하나씩 JSON 으로: {"argv":[…],"pid":<이 프로세스>}
//   FAKE_TAILSCALE_ROOT       serve 설정을 <root>/serve.json 에 둔다(미리 사용자 항목을 넣어 둘 수 있다). serve 명령에 필요
//   FAKE_TAILSCALE_SERVE_FAIL 그 종료 코드로 serve --bg 가 실패한다 — stderr 에 사용자 이름·경로가 든 글(두레가 그대로 옮기지 않는지 보려고)
// 이 기기 이름은 늘 fake-pc.tail0000.ts.net, 사용자는 someone@example.com(가짜 — 결과·오류·로그에 새지 않는지 보려고 status 에 넣는다).
import fs from 'node:fs';
import path from 'node:path';

const DNS = 'fake-pc.tail0000.ts.net';
const EMAIL = 'someone@example.com';
const ENABLE_URL = 'https://login.tailscale.com/f/serve?node=nFAKE0000CNTRL';
const NOT_RUNNING = 'failed to connect to local Tailscale service; is Tailscale running?';

const argv = process.argv.slice(2);
const state = process.env.FAKE_TAILSCALE_STATE || 'ready';
if (process.env.FAKE_TAILSCALE_LOG) fs.appendFileSync(process.env.FAKE_TAILSCALE_LOG, JSON.stringify({ argv, pid: process.pid }) + '\n');

const out = (s) => process.stdout.write(s);
const fail = (code, msg) => {
  process.stderr.write(msg + '\n', () => process.exit(code));
};

function servePath() {
  const root = process.env.FAKE_TAILSCALE_ROOT;
  if (!root) {
    fail(2, '가짜 tailscale: FAKE_TAILSCALE_ROOT 가 필요해요');
    return null;
  }
  return path.join(root, 'serve.json');
}
function readServe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}
function writeServe(file, conf) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(conf, null, 2));
  fs.renameSync(tmp, file);
}

function status() {
  const running = state === 'no-https' || state === 'ready';
  const self = {
    ID: 'nFAKE0000CNTRL',
    HostName: 'fake-pc',
    DNSName: running ? `${DNS}.` : '',
    OS: 'windows',
    UserID: 1001,
    TailscaleIPs: running ? ['100.64.0.1'] : null,
    Online: running,
  };
  return {
    Version: '1.90.0-fake',
    TUN: true,
    BackendState: running ? 'Running' : 'NeedsLogin',
    HaveNodeKey: true,
    AuthURL: '',
    TailscaleIPs: self.TailscaleIPs,
    Self: self,
    Health: [],
    MagicDNSSuffix: running ? 'tail0000.ts.net' : '',
    CurrentTailnet: running ? { Name: EMAIL, MagicDNSSuffix: 'tail0000.ts.net', MagicDNSEnabled: true } : null,
    CertDomains: state === 'ready' ? [DNS] : running ? [] : null,
    Peer: {},
    User: { 1001: { ID: 1001, LoginName: EMAIL, DisplayName: 'Fake User', ProfilePicURL: '' } },
    ClientVersion: null,
  };
}

const portOf = (flag) => {
  const m = /^--https=(\d+)$/.exec(flag ?? '');
  return m ? Number(m[1]) : null;
};

function main() {
  if (argv.includes('reset') || argv.includes('funnel')) return fail(3, `가짜 tailscale: 두레는 이 명령을 쓰면 안 돼요 — ${argv.join(' ')}`);
  if (state === 'missing') return fail(1, NOT_RUNNING);

  if (argv.length === 2 && argv[0] === 'status' && argv[1] === '--json') {
    out(JSON.stringify(status(), null, 2) + '\n');
    return;
  }
  if (argv.length === 3 && argv[0] === 'serve' && argv[1] === 'status' && argv[2] === '--json') {
    const file = servePath();
    if (!file) return;
    out(JSON.stringify(readServe(file), null, 2) + '\n');
    return;
  }
  // serve --bg --https=<P> <target>
  if (argv.length === 4 && argv[0] === 'serve' && argv[1] === '--bg' && portOf(argv[2]) !== null) {
    const port = portOf(argv[2]);
    const target = argv[3];
    const file = servePath();
    if (!file) return;
    if (state === 'logged-out') return fail(1, 'Tailscale is not logged in. Run `tailscale up` first.');
    if (process.env.FAKE_TAILSCALE_SERVE_FAIL) {
      return fail(Number(process.env.FAKE_TAILSCALE_SERVE_FAIL), `fake failure for ${EMAIL} at C:\\Users\\someone\\AppData\\Local\\Tailscale\\serve.json`);
    }
    if (state === 'no-https') {
      out(`Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         ${ENABLE_URL}\n\n`);
      // 진짜는 사용자가 켤 때까지 기다린다 — 두레가 끈다
      setTimeout(() => fail(1, '가짜 tailscale: 아무도 끄지 않아 60초 뒤 끝냄'), 60_000);
      return;
    }
    const conf = readServe(file);
    const key = `${DNS}:${port}`;
    conf.TCP = { ...(conf.TCP ?? {}), [port]: { HTTPS: true } };
    const web = conf.Web?.[key] ?? { Handlers: {} };
    conf.Web = { ...(conf.Web ?? {}), [key]: { ...web, Handlers: { ...(web.Handlers ?? {}), '/': { Proxy: target } } } };
    writeServe(file, conf);
    const url = port === 443 ? `https://${DNS}/` : `https://${DNS}:${port}/`;
    out(`Available within your tailnet:\n\n${url}\n|-- proxy ${target}\n\nServe started and running in the background.\nTo disable the proxy, run: tailscale serve --https=${port} off\n`);
    return;
  }
  // serve --https=<P> off
  if (argv.length === 3 && argv[0] === 'serve' && portOf(argv[1]) !== null && argv[2] === 'off') {
    const port = portOf(argv[1]);
    const file = servePath();
    if (!file) return;
    const conf = readServe(file);
    const key = Object.keys(conf.Web ?? {}).find((k) => k.endsWith(`:${port}`));
    if (!key || !conf.Web[key].Handlers?.['/']) return fail(1, 'error: handler does not exist');
    const handlers = { ...conf.Web[key].Handlers };
    delete handlers['/'];
    if (Object.keys(handlers).length) conf.Web[key] = { ...conf.Web[key], Handlers: handlers };
    else {
      delete conf.Web[key];
      if (conf.TCP) delete conf.TCP[port];
    }
    for (const k of ['TCP', 'Web']) if (conf[k] && Object.keys(conf[k]).length === 0) delete conf[k];
    writeServe(file, conf);
    return;
  }
  fail(2, `가짜 tailscale: 모르는 명령 — ${argv.join(' ')}`);
}

main();
