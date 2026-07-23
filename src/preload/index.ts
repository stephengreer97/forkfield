import { contextBridge, ipcRenderer } from 'electron'
import type {
  ForkfieldApi,
  CanvasState,
  SessionEvent,
  StartTurnParams
} from '../shared/types'

const api: ForkfieldApi = {
  chooseDirectory: () => ipcRenderer.invoke('dialog:chooseDirectory'),
  loadCanvas: () => ipcRenderer.invoke('canvas:load'),
  saveCanvas: (state: CanvasState) => ipcRenderer.invoke('canvas:save', state),
  startTurn: (params: StartTurnParams) => ipcRenderer.invoke('session:startTurn', params),
  interrupt: (nodeId: string) => ipcRenderer.send('session:interrupt', nodeId),
  respondPermission: (requestId: string, allow: boolean) =>
    ipcRenderer.send('session:respondPermission', { requestId, allow }),
  setBypass: (on: boolean) => ipcRenderer.send('settings:setBypass', on),
  loadHistory: (sessionId: string) => ipcRenderer.invoke('session:loadHistory', sessionId),
  saveFile: (canvas: CanvasState, path?: string | null) =>
    ipcRenderer.invoke('file:save', { canvas, path: path ?? null }),
  openFile: () => ipcRenderer.invoke('file:open'),
  onMenu: (cb: (action: string) => void) => {
    const listener = (_: unknown, action: string): void => cb(action)
    ipcRenderer.on('menu', listener)
    return () => ipcRenderer.removeListener('menu', listener)
  },
  onSessionEvent: (cb: (event: SessionEvent) => void) => {
    const listener = (_: unknown, event: SessionEvent): void => cb(event)
    ipcRenderer.on('session:event', listener)
    return () => ipcRenderer.removeListener('session:event', listener)
  }
}

contextBridge.exposeInMainWorld('forkfield', api)
