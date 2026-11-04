import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { APP_METHODS, CHANNEL, METHODS, type DureApi, type EventEnvelope, type InvokeResult } from '../shared/ipcContract'

async function invoke(method: string, args: unknown[]): Promise<unknown> {
  const r = (await ipcRenderer.invoke(CHANNEL.invoke, { method, args })) as InvokeResult
  if (!r.ok) throw new Error(r.error) // 엔진의 한국어 메시지만 — 스택은 오지 않는다
  return r.value
}

const api: Record<string, unknown> = {}
// 엔진 메서드와 앱 메서드(엔진 없이 됨) — 앱 사건도 엔진 사건과 같은 봉투라 on 은 그대로
for (const m of [...METHODS, ...APP_METHODS]) api[m] = (...args: unknown[]) => invoke(m, args)
api.on = (name: string, fn: (p: unknown) => void) => {
  const listener = (_e: unknown, env: EventEnvelope) => {
    if (env && env.name === name) fn(env.payload)
  }
  ipcRenderer.on(CHANNEL.event, listener)
  return () => {
    ipcRenderer.removeListener(CHANNEL.event, listener)
  }
}
// 사용자가 고르거나 끌어다 놓은 File 의 경로 — 샌드박스 화면은 File 의 경로를 모른다. IPC 가 아니라 이 자리에서(동기) Electron 이 준 글만 돌려준다
// (디스크 파일이 아닌 File 이면 빈 글). 읽기·열기는 하지 않는다
api.pathForFile = (file: File): string => webUtils.getPathForFile(file)

// ipcRenderer 자체는 노출하지 않는다
contextBridge.exposeInMainWorld('dure', api as unknown as DureApi)
