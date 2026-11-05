import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
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
   * 원본은 읽기로만 연다. 실패하면 반쯤 쓴 사본을 지우고 던진다. 원본의 인터넷 표시(Zone.Identifier)도 사본에 옮긴다(윈도 · 되는 만큼).
   * 비동기 스트림 — 엔진은 Electron main 에서 돈다. 큰 파일·느린 원본(온라인 전용 OneDrive·USB·네트워크 공유)을 복사하는 동안 앱·MCP 가
   * 멈추지 않게. signal 이 끊기면 원본 읽기를 기다리지 않고 바로 그 까닭(AbortError)으로 던진다(반쯤 쓴 사본은 지운다 · 이미 끊겼으면 폴더도 안 만든다)
   */
  copyIn(agentId: AgentId, srcPath: string, name: string, signal?: AbortSignal): Promise<{ file: string; abs: string }>;
  /** 사본 하나를 지운다 — 모양이 틀린 이름·없는 파일은 조용히 */
  removeFile(agentId: AgentId, file: string): void;
  /**
   * 사본 하나를 다른 에이전트 폴더로 같은 이름에 복사한다 — 이름·폴더 모양이 틀리거나 원본이 없으면 false(이미 있으면 그대로 true).
   * 쓰다 끊기면 임시 파일을 지우고 던진다. 비동기 — 갈래 칠 때 큰 첨부가 많아도 main 을 막지 않는다.
   * copyFile(윈도 CopyFileW)이라 인터넷 표시(Zone.Identifier) 같은 대체 데이터 스트림도 따라온다(이름 바꾸기도 그대로 둔다)
   */
  copy(from: AgentId, to: AgentId, file: string): Promise<boolean>;
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

/**
 * 안전한 이름 — 금지·제어 글자는 _, 앞 공백·뒤 공백과 점 정리, 길면 확장자를 남기고 줄인다, 비면(점뿐이었으면) file.
 * 휴대폰 올리기(phoneServer)도 받은 파일 이름을 이걸로 다듬는다
 */
export function safeName(name: string): string {
  const s = trimEnds(String(name ?? '').replace(UNSAFE, '_'));
  if (!s) return 'file';
  if (Buffer.byteLength(s) <= NAME_MAX_BYTES) return s;
  const { base, ext } = splitExt(s);
  return trimEnds(fitBytes(base, NAME_MAX_BYTES - Buffer.byteLength(ext))) + ext || 'file';
}

const codeOf = (e: unknown) => (e as NodeJS.ErrnoException | null)?.code;

/**
 * realpath 가 이 까닭으로 실패하면 그 파일은 없거나 못 쓰는 것이다(보내기 거절 · 칩은 못 찾음). 그 밖(EISDIR·EINVAL·UNKNOWN …)은
 * 진짜 경로를 못 푸는 볼륨(RAM 디스크·일부 가상 FS)이라 보고 realpath 없이 넘어간다 — 엔진의 보내기와 resolve 가 같이 쓴다
 */
export const REALPATH_FATAL: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EBUSY']);
/**
 * 지우기 — 막 만든 파일은 백신(Defender) 등이 잠깐 잡아 EBUSY·EPERM 이 난다: 몇 번 다시 시도한다.
 * maxRetries 는 recursive 일 때만 듣는다(보통 파일에도 그대로 된다)
 */
const RM = { force: true, recursive: true, maxRetries: 3, retryDelay: 50 } as const;

/** 있나(따라간 뒤) — 못 재면 없음으로 */
const exists = (p: string) => fs.promises.access(p).then(() => true, () => false);

/** 복사 스트림 조각 크기 — 100MB 도 조각 수가 적게 */
const COPY_CHUNK = 1024 * 1024;

/**
 * 인터넷에서 받은 파일의 표시(Mark-of-the-Web) — 윈도가 대체 데이터 스트림 `<파일>:Zone.Identifier` 에 둔다. 사본에 없으면 칩으로 연
 * .doc·.xls·.ppt 가 보호된 보기·매크로 막기 없이 열린다. copyFile(CopyFileW)은 대체 스트림도 옮기지만 스트림 복사는 본 스트림만 옮긴다
 */
const ZONE_STREAM = ':Zone.Identifier';
/** 표시를 읽을 상한 — 보통 수백 바이트(ZoneId · 받은 주소) */
const ZONE_MAX = 64 * 1024;

/** 원본의 인터넷 표시 — 윈도만 · 없거나 못 읽으면 null(던지지 않는다 — 표시 없는 원본·FAT 볼륨·네트워크 공유) */
async function readZone(src: string): Promise<Buffer | null> {
  if (process.platform !== 'win32') return null;
  let h: fs.promises.FileHandle | undefined;
  try {
    h = await fs.promises.open(`${src}${ZONE_STREAM}`, 'r');
    const buf = Buffer.alloc(ZONE_MAX);
    const { bytesRead } = await h.read(buf, 0, ZONE_MAX, 0);
    return bytesRead > 0 ? buf.subarray(0, bytesRead) : null;
  } catch {
    return null;
  } finally {
    await h?.close().catch(() => {});
  }
}

/** 사본에 인터넷 표시를 — 되는 만큼(던지지 않는다 — 대체 스트림이 없는 볼륨 등) */
async function writeZone(abs: string, zone: Buffer): Promise<void> {
  try {
    await fs.promises.writeFile(`${abs}${ZONE_STREAM}`, zone);
  } catch {
    // 표시를 못 옮겨도 사본은 쓴다
  }
}

/** 쓰는 스트림을 닫고(이미 닫혔으면 바로) 닫힘을 기다린다 — 열린 파일은 지워도 이름이 남는다 */
function closed(s: fs.WriteStream): Promise<void> {
  if (s.closed) return Promise.resolve();
  return new Promise((resolve) => {
    s.once('close', () => resolve());
    s.destroy();
  });
}

/**
 * p 를 기다리되 signal 이 끊기면 그 까닭(signal.reason — AbortError)으로 바로 던진다. p 는 뒤에서 끝나게 두고 그 거절은 삼킨다 —
 * 끊을 수 없는 느린 일(끊긴 공유 폴더의 realpath·stat·읽기)을 보내기가 기다리지 않게
 */
export function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  p.catch(() => {}); // 끊긴 뒤에 온 거절이 처리 안 된 거절로 남지 않게
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', stop);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', stop);
        reject(e);
      },
    );
  });
}

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
    async copyIn(agentId, srcPath, name, signal) {
      const dir = needDir(agentId);
      signal?.throwIfAborted(); // 이미 끊겼으면 폴더도 만들지 않는다(지운 에이전트의 폴더를 되살리지 않게)
      await fs.promises.mkdir(dir, { recursive: true });
      const { base, ext } = splitExt(safeName(name));
      const stamp = stampOf(now());
      for (let n = 1; ; n++) {
        const file = `${stamp}-${n === 1 ? base : `${base}-${n}`}${ext}`;
        const abs = path.join(dir, file);
        // 이름을 먼저 차지한다('wx' — 같은 이름이 있으면 EEXIST, 덮지 않는다). 차지한 뒤의 실패는 이 사본뿐이라 지워도 된다
        const out = fs.createWriteStream(abs, { flags: 'wx' });
        try {
          await once(out, 'open');
        } catch (e) {
          if (codeOf(e) === 'EEXIST') continue;
          throw e;
        }
        try {
          // 스트림이라 끊을 수 있다(signal) — 끊기면 느린 원본(온라인 전용 OneDrive·끊긴 공유 폴더)의 읽기가 돌아오길 기다리지 않는다
          const copying = pipeline(fs.createReadStream(srcPath, { flags: 'r', highWaterMark: COPY_CHUNK }), out, signal ? { signal } : {});
          await (signal ? abortable(copying, signal) : copying);
          // 인터넷 표시도 — 스트림 복사는 본 스트림만 옮긴다. 읽기도 끊을 수 있게(원본 쪽), 쓰기는 이 PC 사본이라 기다린다
          // (끊긴 뒤 늦게 쓰면 지운 사본 자리에 빈 파일이 다시 생긴다)
          const reading = readZone(srcPath);
          const zone = await (signal ? abortable(reading, signal) : reading);
          if (zone) await writeZone(abs, zone);
        } catch (e) {
          // 반쯤 쓴 사본이 남지 않게 — 쓰는 쪽을 닫은 뒤 지운다. 지우기 실패가 원래 까닭을 가리지 않게 삼킨다
          try {
            await closed(out);
            await fs.promises.rm(abs, RM);
          } catch {
            // 남은 조각은 에이전트를 지울 때 폴더째 지워진다
          }
          throw e;
        }
        return { file, abs };
      }
    },
    removeFile(agentId, file) {
      const abs = inside(agentId, file);
      if (!abs) return;
      writable(abs);
      fs.rmSync(abs, RM);
    },
    async copy(from, to, file) {
      const source = inside(from, file);
      const full = inside(to, file);
      if (!source || !full || !(await exists(source))) return false;
      if (!(await exists(full))) {
        await fs.promises.mkdir(path.dirname(full), { recursive: true });
        // 그림 칸과 같이 — 다 쓴 뒤 이름을 바꾼다
        const tmp = `${full}.${process.pid}.tmp`;
        try {
          await fs.promises.copyFile(source, tmp);
          writable(tmp);
          await fs.promises.rename(tmp, full);
        } catch (e) {
          // 쓰다 끊긴 임시 파일이 남지 않게 — 지우기 실패가 원래 까닭을 가리지 않게 삼킨다
          try {
            writable(tmp);
            await fs.promises.rm(tmp, RM);
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
        let real: { dir: string; root: string } | null = null;
        try {
          real = { dir: fs.realpathSync.native(dir), root: fs.realpathSync.native(root) };
        } catch (e) {
          if (REALPATH_FATAL.has(codeOf(e) ?? '')) return null;
          // 진짜 경로를 못 푸는 볼륨(RAM 디스크 등 — 보낼 때도 이름 검사만으로 받아들였다): 모양·폴더 안은 inside 가 봤다 —
          // 에이전트 폴더·첨부 폴더가 링크(junction 포함)가 아닌지만 본다
          return fs.lstatSync(dir).isSymbolicLink() || fs.lstatSync(root).isSymbolicLink() ? null : abs;
        }
        return real.dir === path.join(real.root, path.basename(dir)) ? abs : null;
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
