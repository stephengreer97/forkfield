import { homedir } from 'os'
import { join } from 'path'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { randomUUID } from 'crypto'
import type { ContentBlock, Turn } from '../shared/types'

// Claude Code stores each session as a JSONL transcript under
// ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl. Session ids are unique,
// so we search every project dir for the file rather than guessing the
// cwd encoding.
function findSessionFile(sessionId: string): string | null {
  const base = join(homedir(), '.claude', 'projects')
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

export function loadSessionHistory(sessionId: string): Turn[] | null {
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

  return turns
}
