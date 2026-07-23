import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import type { CanvasState } from '../shared/types'

function canvasPath(): string {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'branchpad-canvas.json')
}

export function loadCanvas(): CanvasState | null {
  try {
    const p = canvasPath()
    if (!existsSync(p)) return null
    const raw = readFileSync(p, 'utf8')
    return JSON.parse(raw) as CanvasState
  } catch (err) {
    console.error('Failed to load canvas:', err)
    return null
  }
}

export function saveCanvas(state: CanvasState): void {
  try {
    writeFileSync(canvasPath(), JSON.stringify(state, null, 2), 'utf8')
  } catch (err) {
    console.error('Failed to save canvas:', err)
  }
}
