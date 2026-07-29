import { contextBridge, ipcRenderer } from 'electron'
import type {
  ForkfieldApi,
  CanvasState,
  SessionEvent,
  StartTurnParams,
  RendererError,
  Worktree,
  UpdateState
} from '../shared/types'

const api: ForkfieldApi = {
  chooseDirectory: () => ipcRenderer.invoke('dialog:chooseDirectory'),
  loadCanvas: () => ipcRenderer.invoke('canvas:load'),
  saveCanvas: (state: CanvasState) => ipcRenderer.invoke('canvas:save', state),
  startTurn: (params: StartTurnParams) => ipcRenderer.invoke('session:startTurn', params),
  interrupt: (nodeId: string) => ipcRenderer.send('session:interrupt', nodeId),
  respondPermission: (requestId: string, allow: boolean) =>
    ipcRenderer.send('session:respondPermission', { requestId, allow }),
  loadHistory: (sessionId: string) => ipcRenderer.invoke('session:loadHistory', sessionId),
  listSessions: () => ipcRenderer.invoke('session:list'),
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
  },
  isGitRepo: (dir: string) => ipcRenderer.invoke('git:isRepo', dir),
  createWorktree: (baseDir: string, nodeId: string) =>
    ipcRenderer.invoke('worktree:create', { baseDir, nodeId }),
  removeWorktree: (wt: Worktree) => ipcRenderer.invoke('worktree:remove', wt),
  gitDiff: (wt: Worktree) => ipcRenderer.invoke('git:diff', wt),
  promoteWorktree: (wt: Worktree) => ipcRenderer.invoke('git:promote', wt),
  openInEditor: (command: string, path: string) =>
    ipcRenderer.invoke('editor:open', { command, path }),
  onUpdaterStatus: (cb: (state: UpdateState) => void) => {
    const listener = (_: unknown, state: UpdateState): void => cb(state)
    ipcRenderer.on('updater:status', listener)
    return () => ipcRenderer.removeListener('updater:status', listener)
  },
  getUpdateStatus: () => ipcRenderer.invoke('updater:getStatus'),
  checkForUpdates: () => ipcRenderer.invoke('updater:checkForUpdates'),
  quitAndInstall: () => ipcRenderer.send('updater:quitAndInstall'),
  openDownloadPage: () => ipcRenderer.send('updater:openDownloadPage'),
  reportError: (err: RendererError) => ipcRenderer.send('renderer:error', err)
}

contextBridge.exposeInMainWorld('forkfield', api)

// Opt-in automation hook. Only present when launched with FORKFIELD_DEBUG=1;
// the renderer uses it to expose a scripting bridge for the demo driver.
if (process.env.FORKFIELD_DEBUG === '1') {
  contextBridge.exposeInMainWorld('__ffdebug', {
    screenshot: (path: string) => ipcRenderer.invoke('debug:screenshot', path)
  })
}
