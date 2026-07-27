import { app } from 'electron'
import { join } from 'path'
import { appendFileSync, existsSync, mkdirSync } from 'fs'
import type { RendererError } from '../shared/types'

function errorLogPath(): string {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'forkfield-errors.log')
}

function indent(text: string): string {
  return text.replace(/^/gm, '  ')
}

// Renderer exceptions are otherwise invisible: a throw during render blanks the
// window without touching stderr or Crashpad. Record them somewhere durable.
export function recordRendererError(err: RendererError): void {
  const parts = [`[${new Date().toISOString()}] ${err.kind}: ${err.message}`]
  if (err.stack) parts.push(indent(err.stack))
  if (err.componentStack) parts.push(indent(`component stack:${err.componentStack}`))
  const text = parts.join('\n') + '\n'

  // stderr lands in forkfield.log; the file below outlives it.
  console.error(text.trimEnd())
  try {
    appendFileSync(errorLogPath(), text, 'utf8')
  } catch (e) {
    console.error('Failed to append to the error log:', e)
  }
}
