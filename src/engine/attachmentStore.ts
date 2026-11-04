import fs from 'node:fs';
import path from 'node:path';
import type { AgentId } from './types';

// 사람이 보낸 첨부 파일 — 원본은 읽기만 하고 에이전트마다 한 폴더(attachments/<에이전트>/)에 사본을 둔다.
// Claude 는 그 사본을 자기 도구(Read 등)로 읽고(띄울 때 --add-dir 로 미리 허용), 기록에는 사본 이름만 남는다

/** 에이전트 폴더 이름 — 가게(store)가 만든 id 모양만 */
const AGENT_RE = /^[A-Za-z0-9-]+$/;
/** 사본 이름에 못 쓰는 글자 — 윈도 금지 글자와 제어 글자 */
const UNSAFE = /[/\\:*?"<>|\p{Cc}]/gu;
/** 사본 이름의 모양 — 시각 접두 + 안전한 이름(금지 글자 없음, 끝이 공백·점 아님). 이 모양이 아니면 풀지 않는다(폴더 밖으로 못 나간다) */
const FILE_RE = /^\d{8}-\d{6}-[^/\\:*?"<>|\p{Cc}]*[^/\\:*?"<>|\p{Cc}\s.]$/u;
/**
 * 안전한 이름 부분의 길이 상한(UTF-8 바이트) — 시각 접두·숫자를 더해도 서버(리눅스) 파일 이름 상한 255 바이트 안,
 * 이 PC 의 데이터 폴더 경로와 합쳐도 윈도 경로 260자 안쪽(다른 프로그램으로 열 때)
 */
const NAME_MAX_BYTES = 100;
/** 확장자로 칠 끝 조각의 길이 상한(점 포함) — 더 길면 이름의 일부로 본다 */
const EXT_MAX = 16;

export interface AttachmentStore {
  /** 그 에이전트의 첨부 폴더(만들지는 않는다) — id 모양이 틀리면 던진다 */
  dir(agentId: AgentId): string;
  /**
   * 원본을 그 에이전트 폴더로 복사한다 — 이름 = `<YYYYMMDD-HHmmss>-<안전한 이름>`, 겹치면 확장자 앞에 -2·-3….
   * 원본은 읽기만 한다. 실패하면 반쯤 쓴 사본을 지우고 던진다.
   * 비동기 — 엔진은 Electron main 에서 돈다. 큰 파일·느린 원본(온라인 전용 OneDrive·USB·네트워크 공유)을 복사하는 동안 앱·MCP 가 멈추지 않게
   */
  copyIn(agentId: AgentId, srcPath: string, name: string): Promise<{ file: string; abs: string }>;
  /** 사본 하나를 지운다 — 모양이 틀린 이름·없는 파일은 조용히 */
  removeFile(agentId: AgentId, file: string): void;
  /** 사본 하나를 다른 에이전트 폴더로 같은 이름에 복사한다 — 이름·폴더 모양이 틀리거나 원본이 없으면 false(이미 있으면 그대로 true) */
  copy(from: AgentId, to: AgentId, file: string): boolean;
  /** 사본의 절대 경로 — 첨부 폴더 밖(`..`·절대 경로·다른 모양)이거나 없으면 null */
  resolve(agentId: AgentId, file: string): string | null;
  /** 그 에이전트의 첨부 폴더를 통째로 지운다 */
  remove(agentId: AgentId): void;
  /**
   * 주인 없는 첨부 폴더를 지운다(지울 때 잠겨 남은 것) — 첨부 폴더 바로 안의, 에이전트 id 모양이고 keep 이 false 인 폴더만.
   * 링크(junction 등)는 따라가지 않는다 · 던지지 않는다(못 지운 것은 다음에 다시)
   */
  prune(keep: (agentId: AgentId) => boolean): Promise<void>;
}

/** Claude 에게 가는 경로 줄 — 사람 글 뒤에 빈 줄 + `첨부 파일:` + 줄마다 `- <절대 경로>`(따옴표 없이). 없으면 '' */
export function attachmentLines(paths: string[]): string {
  return paths.length ? `\n\n첨부 파일:\n${paths.map((p) => `- ${p}`).join('\n')}` : '';
}

const two = (n: number) => String(n).padStart(2, '0');
/** 이 PC 시각 — YYYYMMDD-HHmmss */
function stampOf(d: Date): string {
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

/** 앞 공백·뒤 공백과 점을 뗀다 — 앞 점은 둔다(.env 그대로 — 사본 이름은 늘 시각 접두가 앞이라 숨김·`..` 이 되지 않는다) */
const trimEnds = (s: string) => s.replace(/^\s+|[\s.]+$/gu, '');

/** 이름과 확장자 — 확장자는 마지막 점부터(EXT_MAX 안, 이름이 남을 때만) */
function splitExt(s: string): { base: string; ext: string } {
  const i = s.lastIndexOf('.');
  if (i <= 0 || s.length - i > EXT_MAX) return { base: s, ext: '' };
  return { base: s.slice(0, i), ext: s.slice(i) };
}

/** 앞에서부터 max 바이트(UTF-8)까지 — 글자를 쪼개지 않는다 */
function fitBytes(s: string, max: number): string {
  let out = '';
  let n = 0;
  for (const c of s) {
    n += Buffer.byteLength(c);
    if (n > max) break;
    out += c;
  }
  return out;
}

/** 안전한 이름 — 금지·제어 글자는 _, 앞 공백·뒤 공백과 점 정리, 길면 확장자를 남기고 줄인다, 비면(점뿐이었으면) file */
function safeName(name: string): string {
  const s = trimEnds(String(name ?? '').replace(UNSAFE, '_'));
  if (!s) return 'file';
  if (Buffer.byteLength(s) <= NAME_MAX_BYTES) return s;
  const { base, ext } = splitExt(s);
  return trimEnds(fitBytes(base, NAME_MAX_BYTES - Buffer.byteLength(ext))) + ext || 'file';
}

const codeOf = (e: unknown) => (e as NodeJS.ErrnoException | null)?.code;
/**
 * 지우기 — 막 만든 파일은 백신(Defender) 등이 잠깐 잡아 EBUSY·EPERM 이 난다: 몇 번 다시 시도한다.
 * maxRetries 는 recursive 일 때만 듣는다(보통 파일에도 그대로 된다)
 */
const RM = { force: true, recursive: true, maxRetries: 3, retryDelay: 50 } as const;

export function openAttachmentStore(dataDir: string, o: { now?: () => Date } = {}): AttachmentStore {
  const root = path.join(dataDir, 'attachments');
  const now = o.now ?? (() => new Date());
  const dirOf = (id: AgentId) => (typeof id === 'string' && AGENT_RE.test(id) ? path.join(root, id) : null);
  const needDir = (id: AgentId): string => {
    const dir = dirOf(id);
    if (!dir) throw new Error(`첨부 폴더 이름이 올바르지 않아요: ${id}`);
    return dir;
  };
  /** 그 폴더 안 그 사본 — 이름 모양이 틀리거나 폴더를 벗어나면 null(있는지는 보지 않는다) */
  const inside = (id: AgentId, file: string): string | null => {
    const dir = dirOf(id);
    if (!dir || typeof file !== 'string' || !FILE_RE.test(file)) return null;
    const abs = path.join(dir, file);
    return path.dirname(abs) === dir ? abs : null;
  };
  /** 지울 수 있게 — 읽기 전용 원본의 사본은 읽기 전용 속성을 따라온다(윈도에서 지우기·덮기가 막힌다) */
  const writable = (abs: string) => {
    try {
      fs.chmodSync(abs, 0o644);
    } catch {
      // 속성을 못 바꿔도 사본은 쓸 수 있다
    }
  };

  return {
    dir: needDir,
    async copyIn(agentId, srcPath, name) {
      const dir = needDir(agentId);
      await fs.promises.mkdir(dir, { recursive: true });
      const { base, ext } = splitExt(safeName(name));
      const stamp = stampOf(now());
      for (let n = 1; ; n++) {
        const file = `${stamp}-${n === 1 ? base : `${base}-${n}`}${ext}`;
        const abs = path.join(dir, file);
        try {
          // 이름을 차지하며 복사 — 같은 이름이 있으면 EEXIST(덮지 않는다)
          await fs.promises.copyFile(srcPath, abs, fs.constants.COPYFILE_EXCL);
        } catch (e) {
          if (codeOf(e) === 'EEXIST') continue;
          // 반쯤 쓴 사본이 남지 않게 — EXCL 이라 원래 있던 파일은 아니다. 지우기 실패가 원래 까닭을 가리지 않게 삼킨다
          try {
            writable(abs);
            await fs.promises.rm(abs, RM);
          } catch {
            // 남은 조각은 에이전트를 지울 때 폴더째 지워진다
          }
          throw e;
        }
        writable(abs);
        return { file, abs };
      }
    },
    removeFile(agentId, file) {
      const abs = inside(agentId, file);
      if (!abs) return;
      writable(abs);
      fs.rmSync(abs, RM);
    },
    copy(from, to, file) {
      const source = inside(from, file);
      const full = inside(to, file);
      if (!source || !full || !fs.existsSync(source)) return false;
      if (!fs.existsSync(full)) {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        // 그림 칸과 같이 — 다 쓴 뒤 이름을 바꾼다
        const tmp = `${full}.${process.pid}.tmp`;
        try {
          fs.copyFileSync(source, tmp);
          writable(tmp);
          fs.renameSync(tmp, full);
        } catch (e) {
          // 쓰다 끊긴 임시 파일이 남지 않게 — 지우기 실패가 원래 까닭을 가리지 않게 삼킨다
          try {
            writable(tmp);
            fs.rmSync(tmp, RM);
          } catch {
            // 남은 조각은 에이전트를 지울 때 폴더째 지워진다
          }
          throw e;
        }
      }
      return true;
    },
    resolve(agentId, file) {
      const abs = inside(agentId, file);
      if (!abs) return null;
      try {
        // 링크는 따라가지 않는다 — 파일 링크·폴더 자리의 junction 이 첨부 폴더 밖을 가리키면 그 밖이 열린다
        if (!fs.lstatSync(abs).isFile()) return null;
        const dir = path.dirname(abs);
        if (fs.realpathSync.native(dir) !== path.join(fs.realpathSync.native(root), path.basename(dir))) return null;
        return abs;
      } catch {
        return null;
      }
    },
    remove(agentId) {
      const dir = dirOf(agentId);
      if (dir) fs.rmSync(dir, RM);
    },
    async prune(keep) {
      try {
        // 첨부 폴더 자체가 링크면 손대지 않는다 — 따라가면 데이터 폴더 밖을 지울 수 있다
        if (!(await fs.promises.lstat(root)).isDirectory()) return;
        // withFileTypes 는 링크를 따라가지 않는다 — junction·심볼릭 링크는 폴더로 치지 않는다
        for (const d of await fs.promises.readdir(root, { withFileTypes: true })) {
          if (!d.isDirectory() || !AGENT_RE.test(d.name) || keep(d.name)) continue;
          try {
            await fs.promises.rm(path.join(root, d.name), RM);
          } catch {
            // 아직 잠겼다 — 다음에 켤 때 다시
          }
        }
      } catch {
        // 첨부 폴더가 없다 등 — 지울 것이 없다
      }
    },
  };
}
