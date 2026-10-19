import { contextBridge } from 'electron'

// Task 4 fills this bridge. Kept empty-but-valid so the renderer sees `window.dure`.
contextBridge.exposeInMainWorld('dure', {})
