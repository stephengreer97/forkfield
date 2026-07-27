import { app } from 'electron'
import { join } from 'path'
import { readFileSync, existsSync, mkdirSync } from 'fs'
import { writeFile, rename } from 'fs/promises'
import type { CanvasState } from '../shared/types'

function canvasPath(): string {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'forkfield-canvas.json')
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

// Saves are chained rather than concurrent: the canvas carries every turn of
// every fork, so two overlapping writes could interleave versions of the file.
let inFlight: Promise<void> = Promise.resolve()

export function saveCanvas(state: CanvasState): Promise<void> {
  const done = inFlight.then(async () => {
    const target = canvasPath()
    const tmp = `${target}.tmp`
    try {
      // Unindented: at this size the pretty-printing is a third of the bytes.
      await writeFile(tmp, JSON.stringify(state), 'utf8')
      // Rename is atomic within a filesystem, so a crash mid-write leaves the
      // previous canvas intact instead of a half-written one.
      await rename(tmp, target)
    } catch (err) {
      console.error('Failed to save canvas:', err)
    }
  })
  inFlight = done
  return done
}
