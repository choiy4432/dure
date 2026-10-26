/// <reference types="vite/client" />
import type { DureApi } from '../shared/ipcContract'

declare global {
  interface Window {
    dure: DureApi
  }
}

export {}
