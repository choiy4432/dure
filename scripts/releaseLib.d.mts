export function notesProblem(text: string): string | null
export function releaseFiles(version: string): string[]
export function releaseArgs(version: string, notesFile: string): string[]
export function show(cmd: string, argv: string[]): string
export const ANDROID_REAL_PACKAGE: string
export function androidProblem(o: {
  apkInfo: { versionCode: number; versionName: string; packageName: string } | null
  version: { versionCode: number; versionName: string }
}): string | null
