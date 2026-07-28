import { app, ipcMain, shell } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { autoUpdater } from 'electron-updater'
import type { BrowserWindow } from 'electron'
import type { UpdateInfo } from 'electron-updater'

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'manual'
  | 'error'

interface UpdateState {
  status: UpdateStatus
  version?: string
  error?: string
}

let updateState: UpdateState = { status: 'idle' }
let win: BrowserWindow | null = null

// Fallback only. The packaged app reads owner/repo out of the app-update.yml
// electron-builder generates, so these can't drift from the publish config.
const DEFAULT_REPO = 'stephengreer97/forkfield'

function repoSlug(): string {
  const file = join(process.resourcesPath ?? '', 'app-update.yml')
  if (!existsSync(file)) return DEFAULT_REPO
  try {
    const yml = readFileSync(file, 'utf8')
    const owner = /^owner:\s*(\S+)/m.exec(yml)?.[1]
    const repo = /^repo:\s*(\S+)/m.exec(yml)?.[1]
    return owner && repo ? `${owner}/${repo}` : DEFAULT_REPO
  } catch {
    return DEFAULT_REPO
  }
}

function releasesPageUrl(): string {
  return `https://github.com/${repoSlug()}/releases/latest`
}

// electron-updater can swap out a running AppImage, but it can't replace a deb
// (or rpm, or a distro package) — that's the package manager's job, and it
// refuses to even check. Those users still deserve to hear about a release, so
// we check GitHub ourselves and point them at the download.
function canSelfUpdate(): boolean {
  if (process.platform !== 'linux') return true
  return process.env.APPIMAGE != null
}

// Compare dotted versions numerically. Enough for the x.y.z tags we publish;
// any prerelease suffix is ignored rather than ordered.
function isNewer(candidate: string, current: string): boolean {
  const parts = (v: string): number[] => v.split('.').map((p) => parseInt(p, 10) || 0)
  const a = parts(candidate)
  const b = parts(current)
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

async function checkManually(): Promise<void> {
  updateState = { status: 'checking' }
  notifyRenderer()
  try {
    const res = await fetch(`https://api.github.com/repos/${repoSlug()}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'forkfield' }
    })
    if (!res.ok) throw new Error(`GitHub responded ${res.status}`)
    const body = (await res.json()) as { tag_name?: string }
    const latest = (body.tag_name ?? '').replace(/^v/, '')
    updateState =
      latest && isNewer(latest, app.getVersion())
        ? { status: 'manual', version: latest }
        : { status: 'idle' }
  } catch (err) {
    updateState = { status: 'error', error: (err as Error).message }
  }
  notifyRenderer()
}

export function setupUpdater(mainWindow: BrowserWindow): void {
  win = mainWindow

  if (canSelfUpdate()) {
    autoUpdater.checkForUpdatesAndNotify()
  } else {
    void checkManually()
  }

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
  ipcMain.handle('updater:checkForUpdates', () =>
    canSelfUpdate() ? autoUpdater.checkForUpdates() : checkManually()
  )
  ipcMain.on('updater:quitAndInstall', () => {
    autoUpdater.quitAndInstall()
  })
  ipcMain.on('updater:openDownloadPage', () => {
    void shell.openExternal(releasesPageUrl())
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
