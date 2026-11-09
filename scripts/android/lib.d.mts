export function parseArgs(argv: string[]): { test: boolean }
export function requireEnv(
  env: Record<string, string | undefined>,
  test: boolean,
): { tools: string; keystore: string; alias: string; pass: string }
export function readVersion(file: string): { versionCode: number; versionName: string }
export function androidConsts(ts: string): { packageName: string; testPackageName: string; sha256: string; testSha256: string }
export function signerSha256(text: string): string | null
