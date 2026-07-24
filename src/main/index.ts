import { app, BrowserWindow, ipcMain, dialog, Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { SessionManager } from './sessions'
import { loadCanvas, saveCanvas } from './persistence'
import { loadSessionHistory } from './history'
import { isGitRepo, createWorktree, removeWorktree, gitDiff } from './git'
import type { SessionEvent, StartTurnParams, CanvasState, Worktree } from '../shared/types'

let win: BrowserWindow | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#e9edf3',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })

  // Keep DevTools available without a View menu.
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      win?.webContents.toggleDevTools()
    }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const send =
    (action: string) =>
    (): void => {
      win?.webContents.send('menu', action)
    }
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'New', accelerator: 'CmdOrCtrl+N', click: send('new') },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: send('open') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: send('saveAs') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

const send = (event: SessionEvent): void => {
  win?.webContents.send('session:event', event)
}

const sessions = new SessionManager(send)

// Single instance: a second `forkfield` launch focuses the existing window
// instead of opening another.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    buildMenu()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

ipcMain.handle('dialog:chooseDirectory', async () => {
  const res = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory']
  })
  if (res.canceled || res.filePaths.length === 0) return null
  return res.filePaths[0]
})

ipcMain.handle('canvas:load', async () => loadCanvas())

ipcMain.handle('canvas:save', async (_e, state: CanvasState) => {
  saveCanvas(state)
})

ipcMain.handle('session:startTurn', async (_e, params: StartTurnParams) => {
  // Fire and forget: the turn streams events back over session:event.
  void sessions.startTurn(params)
})

ipcMain.handle('session:loadHistory', async (_e, sessionId: string) =>
  loadSessionHistory(sessionId)
)

ipcMain.handle('file:save', async (_e, payload: { canvas: CanvasState; path: string | null }) => {
  let target = payload.path
  if (!target) {
    const res = await dialog.showSaveDialog({
      title: 'Save Forkfield session',
      defaultPath: 'session.fork',
      filters: [{ name: 'Forkfield Session', extensions: ['fork'] }]
    })
    if (res.canceled || !res.filePath) return null
    target = res.filePath
  }
  try {
    writeFileSync(target, JSON.stringify(payload.canvas, null, 2), 'utf8')
    return target
  } catch (err) {
    console.error('Failed to save session file:', err)
    return null
  }
})

ipcMain.handle('file:open', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Open Forkfield session',
    properties: ['openFile'],
    filters: [{ name: 'Forkfield Session', extensions: ['fork'] }]
  })
  if (res.canceled || res.filePaths.length === 0) return null
  const p = res.filePaths[0]
  try {
    const raw = readFileSync(p, 'utf8')
    const canvas = JSON.parse(raw) as CanvasState
    return { path: p, canvas }
  } catch (err) {
    console.error('Failed to open session file:', err)
    return null
  }
})

ipcMain.handle('git:isRepo', async (_e, dir: string) => isGitRepo(dir))

ipcMain.handle('worktree:create', async (_e, p: { baseDir: string; nodeId: string }) =>
  createWorktree(p.baseDir, p.nodeId)
)

ipcMain.handle('worktree:remove', async (_e, wt: Worktree) => {
  await removeWorktree(wt)
})

ipcMain.handle('git:diff', async (_e, wt: Worktree) => gitDiff(wt))

ipcMain.on('session:interrupt', (_e, nodeId: string) => {
  sessions.interrupt(nodeId)
})

ipcMain.on('session:respondPermission', (_e, payload: { requestId: string; allow: boolean }) => {
  sessions.resolvePermission(payload.requestId, payload.allow)
})

