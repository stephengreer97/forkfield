import { app, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { BrowserWindow } from 'electron'
import type { UpdateInfo } from 'electron-updater'

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'

interface UpdateState {
  status: UpdateStatus
  version?: string
  error?: string
}

let updateState: UpdateState = { status: 'idle' }
let win: BrowserWindow | null = null

export function setupUpdater(mainWindow: BrowserWindow): void {
  win = mainWindow

  // Configure updater
  autoUpdater.checkForUpdatesAndNotify()

  autoUpdater.on('checking-for-update', () => {
    updateState = { status: 'checking' }
    notifyRenderer()
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    updateState = { status: 'available', version: info.version }
    notifyRenderer()
  })

  autoUpdater.on('update-not-available', () => {
    updateState = { status: 'idle' }
    notifyRenderer()
  })

  autoUpdater.on('download-progress', () => {
    updateState = { status: 'downloading' }
    notifyRenderer()
  })

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    updateState = { status: 'ready', version: info.version }
    notifyRenderer()
  })

  autoUpdater.on('error', (err: Error) => {
    updateState = { status: 'error', error: err.message }
    notifyRenderer()
  })

  // IPC handlers for the renderer
  ipcMain.handle('updater:getStatus', () => updateState)
  ipcMain.handle('updater:checkForUpdates', () => autoUpdater.checkForUpdates())
  ipcMain.on('updater:quitAndInstall', () => {
    autoUpdater.quitAndInstall()
  })
}

export function getUpdateStatus(): UpdateState {
  return updateState
}

function notifyRenderer(): void {
  if (win) {
    win.webContents.send('updater:status', updateState)
  }
}
