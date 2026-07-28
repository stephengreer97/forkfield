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

function write(line: string): void {
  const text = line.endsWith('\n') ? line : line + '\n'
  // stderr lands in forkfield.log; the file below outlives it.
  console.error(text.trimEnd())
  try {
    appendFileSync(errorLogPath(), text, 'utf8')
  } catch (e) {
    console.error('Failed to append to the error log:', e)
  }
}

// Renderer exceptions are otherwise invisible: a throw during render blanks the
// window without touching stderr or Crashpad. Record them somewhere durable.
export function recordRendererError(err: RendererError): void {
  const parts = [`[${new Date().toISOString()}] ${err.kind}: ${err.message}`]
  if (err.stack) parts.push(indent(err.stack))
  if (err.componentStack) parts.push(indent(`component stack:${err.componentStack}`))
  write(parts.join('\n'))
}

// A child process dying takes the app down with no JS error to catch: Chromium
// retries the launch a few times, then aborts the whole process. Naming the
// process and reason turns that cascade into one readable line.
export function recordProcessGone(what: string, details: Record<string, unknown>): void {
  const fields = Object.entries(details)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ')
  write(`[${new Date().toISOString()}] process-gone: ${what}${fields ? ` ${fields}` : ''}`)
}
