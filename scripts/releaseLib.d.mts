export function notesProblem(text: string): string | null
export function releaseFiles(version: string): string[]
export function releaseArgs(version: string, notesFile: string): string[]
export function show(cmd: string, argv: string[]): string
export const ANDROID_REAL_PACKAGE: string
export const ANDROID_STALE: string
export function androidProblem(o: {
  /** 구운 APK 옆 dure.apk.json — sourceHash 는 예전에 구운 것엔 없다(그러면 멈춘다) */
  apkInfo: { versionCode: number; versionName: string; packageName: string; sourceHash?: string } | null
  version: { versionCode: number; versionName: string }
  /** 지금 android/ 소스의 SHA-256(androidSourceHash) */
  sourceHash: string
}): string | null
export const DRAFT_HINT: string
export type ReleaseStep = { name: 'typecheck' | 'test' | 'dist' | 'upload'; cmd: string; args: string[]; shell: boolean }
export function releasePlan(version: string, notesFile: string): ReleaseStep[]
export function runPlan(plan: ReleaseStep[], exec: (step: ReleaseStep) => number | null): string | null
