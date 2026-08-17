import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { AgentId, AppSnapshot } from '../shared/contracts'

const api = {
  onSnapshot: (callback: (snapshot: AppSnapshot) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: AppSnapshot): void => {
      callback(snapshot)
    }
    ipcRenderer.on('app:snapshot', listener)
    return () => {
      ipcRenderer.removeListener('app:snapshot', listener)
    }
  },
  selectAgent: (agent: AgentId): void => {
    ipcRenderer.send('app:select-agent', agent)
  },
  selectSession: (delta: -1 | 1): void => {
    ipcRenderer.send('app:select-session', delta)
  },
  selectSessionId: (agent: AgentId, id: string): void => {
    ipcRenderer.send('app:select-session-id', { agent, id })
  },
  toggleRecording: (): void => {
    ipcRenderer.send('app:toggle-recording')
  },
  rescan: (): void => {
    ipcRenderer.send('app:rescan')
  },
  reannounce: (): void => {
    ipcRenderer.send('app:reannounce')
  },
  ensureMicPermission: (): Promise<boolean> => ipcRenderer.invoke('app:ensure-mic-permission')
}

export type Api = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
