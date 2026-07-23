import { contextBridge, ipcRenderer } from 'electron'
import type {
  BranchpadApi,
  CanvasState,
  SessionEvent,
  StartTurnParams
} from '../shared/types'

const api: BranchpadApi = {
  chooseDirectory: () => ipcRenderer.invoke('dialog:chooseDirectory'),
  loadCanvas: () => ipcRenderer.invoke('canvas:load'),
  saveCanvas: (state: CanvasState) => ipcRenderer.invoke('canvas:save', state),
  startTurn: (params: StartTurnParams) => ipcRenderer.invoke('session:startTurn', params),
  interrupt: (nodeId: string) => ipcRenderer.send('session:interrupt', nodeId),
  respondPermission: (requestId: string, allow: boolean) =>
    ipcRenderer.send('session:respondPermission', { requestId, allow }),
  setBypass: (on: boolean) => ipcRenderer.send('settings:setBypass', on),
  onSessionEvent: (cb: (event: SessionEvent) => void) => {
    const listener = (_: unknown, event: SessionEvent): void => cb(event)
    ipcRenderer.on('session:event', listener)
    return () => ipcRenderer.removeListener('session:event', listener)
  }
}

contextBridge.exposeInMainWorld('branchpad', api)
