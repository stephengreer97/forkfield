import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { SessionManager } from './sessions'
import { loadCanvas, saveCanvas } from './persistence'
import type { SessionEvent, StartTurnParams, CanvasState } from '../shared/types'

let win: BrowserWindow | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#0e1116',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const send = (event: SessionEvent): void => {
  win?.webContents.send('session:event', event)
}

const sessions = new SessionManager(send)

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

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

ipcMain.on('session:interrupt', (_e, nodeId: string) => {
  sessions.interrupt(nodeId)
})

ipcMain.on('session:respondPermission', (_e, payload: { requestId: string; allow: boolean }) => {
  sessions.resolvePermission(payload.requestId, payload.allow)
})

ipcMain.on('settings:setBypass', (_e, on: boolean) => {
  sessions.setBypass(!!on)
})
