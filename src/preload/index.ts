import { contextBridge, ipcRenderer } from 'electron'
import { CHANNEL, METHODS, type DureApi, type EventEnvelope, type InvokeResult } from '../shared/ipcContract'

async function invoke(method: string, args: unknown[]): Promise<unknown> {
  const r = (await ipcRenderer.invoke(CHANNEL.invoke, { method, args })) as InvokeResult
  if (!r.ok) throw new Error(r.error) // 엔진의 한국어 메시지만 — 스택은 오지 않는다
  return r.value
}

const api: Record<string, unknown> = {}
for (const m of METHODS) api[m] = (...args: unknown[]) => invoke(m, args)
api.on = (name: string, fn: (p: unknown) => void) => {
  const listener = (_e: unknown, env: EventEnvelope) => {
    if (env && env.name === name) fn(env.payload)
  }
  ipcRenderer.on(CHANNEL.event, listener)
  return () => {
    ipcRenderer.removeListener(CHANNEL.event, listener)
  }
}

// ipcRenderer 자체는 노출하지 않는다
contextBridge.exposeInMainWorld('dure', api as unknown as DureApi)
