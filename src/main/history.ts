import { homedir } from 'os'
import { basename, join } from 'path'
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync
} from 'fs'
import { randomUUID } from 'crypto'
import type { ContentBlock, SessionHistory, SessionSummary, Turn } from '../shared/types'

// Resolve the Claude config directory, respecting CLAUDE_CONFIG_DIR env var.
function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
}

// Claude Code stores each session as a JSONL transcript under
// <CLAUDE_CONFIG_DIR>/projects/<encoded-cwd>/<session-id>.jsonl. Session ids are unique,
// so we search every project dir for the file rather than guessing the
// cwd encoding.
function findSessionFile(sessionId: string): string | null {
  const base = join(claudeConfigDir(), 'projects')
  if (!existsSync(base)) return null
  let dirs: string[]
  try {
    dirs = readdirSync(base)
  } catch {
    return null
  }
  for (const d of dirs) {
    const f = join(base, d, `${sessionId}.jsonl`)
    if (existsSync(f)) return f
  }
  return null
}

// Claude Code keys session transcripts by the cwd they ran in: the project dir
// is the absolute path with every non-alphanumeric character turned into a dash.
function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

// When a branch runs in a git worktree, its cwd differs from the parent's, so a
// `--resume <parentSession>` would look in the wrong project dir and lose the
// inherited context. Copy the transcript into the cwd's project dir so resume
// resolves it there. No-op when the file is already present (shared mode, or
// after the first branch turn).
export function ensureSessionInCwd(cwd: string, sessionId: string): void {
  const dir = join(claudeConfigDir(), 'projects', encodeCwd(cwd))
  const dest = join(dir, `${sessionId}.jsonl`)
  if (existsSync(dest)) return
  const src = findSessionFile(sessionId)
  if (!src || src === dest) return
  try {
    mkdirSync(dir, { recursive: true })
    copyFileSync(src, dest)
  } catch (err) {
    console.error('ensureSessionInCwd failed:', err)
  }
}

// Transcripts run to tens of megabytes, but everything a session list needs
// sits in the opening lines: `cwd` is on the first one and the opening prompt
// follows soon after. Read a fixed head instead of the whole file so listing
// cost doesn't scale with conversation length.
const HEAD_BYTES = 32 * 1024

function readHead(file: string, bytes: number): string {
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(bytes)
    const read = readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, read).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* already gone */
      }
    }
  }
}

// The first thing the user actually typed, which makes a far better label than
// a session id. Skips the machinery that also arrives as "user" messages:
// tool results, slash-command envelopes, and injected reminders — all of which
// are either non-text or start with an XML-ish tag.
function firstPrompt(obj: any): string | null {
  if (obj?.type !== 'user' || obj?.isSidechain || obj?.isMeta) return null
  const content = obj?.message?.content
  let text: string | null = null
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    const block = content.find((b: any) => b?.type === 'text' && typeof b.text === 'string')
    text = block?.text ?? null
  }
  if (!text) return null
  const clean = text.trim().replace(/\s+/g, ' ')
  if (!clean || clean.startsWith('<')) return null
  return clean.slice(0, 120)
}

// Every resumable Claude session on this machine, newest first. The same id can
// exist under several project dirs — `ensureSessionInCwd` copies a transcript
// when a fork runs in a worktree — so collapse duplicates and keep the newest.
export function listRecentSessions(limit = 40): SessionSummary[] {
  const base = join(claudeConfigDir(), 'projects')
  if (!existsSync(base)) return []
  let dirs: string[]
  try {
    dirs = readdirSync(base)
  } catch {
    return []
  }

  const bySession = new Map<string, SessionSummary>()
  for (const dir of dirs) {
    let files: string[]
    try {
      files = readdirSync(join(base, dir)).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const file of files) {
      const path = join(base, dir, file)
      const sessionId = basename(file, '.jsonl')
      let updatedAt: number
      let bytes: number
      try {
        const st = statSync(path)
        updatedAt = st.mtimeMs
        bytes = st.size
      } catch {
        continue
      }
      const existing = bySession.get(sessionId)
      if (existing && existing.updatedAt >= updatedAt) continue

      let cwd: string | null = null
      let title: string | null = null
      let gitBranch: string | null = null
      for (const line of readHead(path, HEAD_BYTES).split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let obj: any
        try {
          obj = JSON.parse(trimmed)
        } catch {
          // A truncated final line is expected: we read a fixed-size head.
          continue
        }
        cwd = cwd ?? obj?.cwd ?? null
        // Outside a repo (or on a detached head) Claude records "HEAD", which
        // tells the user nothing — treat it as no branch.
        if (!gitBranch && obj?.gitBranch && obj.gitBranch !== 'HEAD') gitBranch = obj.gitBranch
        title = title ?? firstPrompt(obj)
        if (cwd && title) break
      }

      bySession.set(sessionId, {
        sessionId,
        cwd,
        cwdExists: !!cwd && existsSync(cwd),
        title,
        gitBranch,
        updatedAt,
        bytes
      })
    }
  }

  return [...bySession.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)
}

function textOf(content: unknown): ContentBlock[] {
  if (typeof content === 'string') {
    return content.trim() ? [{ kind: 'text', text: content }] : []
  }
  if (!Array.isArray(content)) return []
  const out: ContentBlock[] = []
  for (const b of content as any[]) {
    if (b?.type === 'text' && b.text) {
      out.push({ kind: 'text', text: b.text })
    } else if (b?.type === 'tool_use') {
      out.push({ kind: 'tool_use', toolName: b.name, toolInput: b.input })
    } else if (b?.type === 'tool_result') {
      const t = typeof b.content === 'string' ? b.content : JSON.stringify(b.content)
      out.push({ kind: 'tool_result', text: t, isError: !!b.is_error })
    }
  }
  return out
}

// Context size is what the *last* request carried, not a sum: every assistant
// message reports the whole conversation it was sent (input + cache + output).
function contextTokensOf(usage: any): number {
  if (!usage) return 0
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.output_tokens ?? 0)
  )
}

export function loadSessionHistory(sessionId: string): SessionHistory | null {
  const file = findSessionFile(sessionId)
  if (!file) return null
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return null
  }

  const turns: Turn[] = []
  let lastAssistant: Turn | null = null
  let contextTokens = 0

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let obj: any
    try {
      obj = JSON.parse(trimmed)
    } catch {
      continue
    }
    // Skip subagent side chains so the transcript matches what the user saw.
    if (obj?.isSidechain) continue

    const type = obj?.type
    const message = obj?.message
    if (!message) continue

    if (type === 'assistant') {
      const ctx = contextTokensOf(message.usage)
      if (ctx) contextTokens = ctx
      const blocks = textOf(message.content)
      if (!blocks.length) continue
      // Claude Code writes one content block per line; merge consecutive
      // assistant lines into a single turn until the next user prompt.
      if (lastAssistant) {
        lastAssistant.blocks.push(...blocks)
      } else {
        lastAssistant = { id: randomUUID(), role: 'assistant', blocks, createdAt: Date.now() }
        turns.push(lastAssistant)
      }
    } else if (type === 'user') {
      const blocks = textOf(message.content)
      if (!blocks.length) continue
      const onlyToolResults = blocks.every((b) => b.kind === 'tool_result')
      // Tool results live in user messages in the transcript; fold them into
      // the preceding assistant turn so the display matches live streaming.
      if (onlyToolResults && lastAssistant) {
        lastAssistant.blocks.push(...blocks)
      } else {
        turns.push({ id: randomUUID(), role: 'user', blocks, createdAt: Date.now() })
        lastAssistant = null
      }
    }
  }

  return { turns, contextTokens }
}
