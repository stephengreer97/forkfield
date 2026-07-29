import type { CanvasNode, Usage } from '../../shared/types'

export function descendantIds(nodes: CanvasNode[], rootId: string): string[] {
  const childrenOf = new Map<string, string[]>()
  for (const n of nodes) {
    if (n.parentId) {
      const arr = childrenOf.get(n.parentId) ?? []
      arr.push(n.id)
      childrenOf.set(n.parentId, arr)
    }
  }
  const out: string[] = []
  const stack = [...(childrenOf.get(rootId) ?? [])]
  while (stack.length) {
    const id = stack.pop() as string
    out.push(id)
    for (const c of childrenOf.get(id) ?? []) stack.push(c)
  }
  return out
}

export function childCount(nodes: CanvasNode[], parentId: string): number {
  return nodes.filter((n) => n.parentId === parentId).length
}

// Pull a session id out of whatever the user pasted into the resume field:
// a bare id/title, or a whole "claude --resume <id>" command copied by mistake.
export function cleanResumeId(raw: string): string {
  let s = raw.trim()
  const afterFlag = s.match(/(?:--resume|-r)\s+(.+)$/i)
  if (afterFlag) s = afterFlag[1].trim()
  s = s
    .replace(/^claude\s+/i, '')
    .replace(/^(?:-p|--print)\s+/i, '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
  const uuid = s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  return uuid ? uuid[0] : s
}

// True if the node's title or any transcript text contains the (lowercased) query.
export function nodeMatches(n: CanvasNode, q: string): boolean {
  if (n.title.toLowerCase().includes(q)) return true
  if (n.tags?.some((t) => t.toLowerCase().includes(q))) return true
  for (const t of n.turns) {
    for (const b of t.blocks) {
      if (b.text && b.text.toLowerCase().includes(q)) return true
    }
  }
  return false
}

// The chain of nodes from the root down to (and including) the given node.
export function lineage(nodes: CanvasNode[], nodeId: string): { id: string; title: string }[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const chain: { id: string; title: string }[] = []
  let cur = byId.get(nodeId)
  const seen = new Set<string>()
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    chain.unshift({ id: cur.id, title: cur.title })
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return chain
}

// Tidy tree layout: x by depth, y packed so each parent centers over its
// subtree. Multiple roots stack vertically. Returns new positions by node id.
export function tidyLayout(nodes: CanvasNode[]): Record<string, { x: number; y: number }> {
  const COL = 440
  const ROW = 260
  const X0 = 80
  const childrenOf = new Map<string, CanvasNode[]>()
  for (const n of nodes) {
    if (n.parentId) {
      const arr = childrenOf.get(n.parentId) ?? []
      arr.push(n)
      childrenOf.set(n.parentId, arr)
    }
  }
  const pos: Record<string, { x: number; y: number }> = {}
  let cursor = 0
  const place = (node: CanvasNode, depth: number): number => {
    const kids = childrenOf.get(node.id) ?? []
    const x = X0 + depth * COL
    if (kids.length === 0) {
      const y = cursor * ROW + 120
      cursor += 1
      pos[node.id] = { x, y }
      return y
    }
    const ys = kids.map((k) => place(k, depth + 1))
    const y = (ys[0] + ys[ys.length - 1]) / 2
    pos[node.id] = { x, y }
    return y
  }
  const roots = nodes.filter((n) => !n.parentId)
  for (const r of roots) {
    place(r, 0)
    cursor += 1 // gap between separate trees
  }
  return pos
}

export function buildBranchPrompt(selection: string, question: string): string {
  const quoted = selection
    .split('\n')
    .map((l) => '> ' + l)
    .join('\n')
  return `Regarding this part of your previous response:\n\n${quoted}\n\n${question}`
}

// Usable context window per session, in tokens.
export const CONTEXT_LIMIT = 200_000

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

// Compact "when did this last happen" for list rows.
export function relativeTime(ms: number): string {
  const secs = Math.max(0, (Date.now() - ms) / 1000)
  if (secs < 90) return 'just now'
  const mins = secs / 60
  if (mins < 60) return `${Math.round(mins)}m ago`
  const hours = mins / 60
  if (hours < 24) return `${Math.round(hours)}h ago`
  const days = hours / 24
  if (days < 30) return `${Math.round(days)}d ago`
  return new Date(ms).toLocaleDateString()
}

export function formatCost(usd: number): string {
  if (usd <= 0) return '$0.00'
  if (usd < 0.01) return '<$0.01'
  return '$' + usd.toFixed(2)
}

// The raw "tokens" number is dominated by cache reads, which are near-free and
// counted at a fraction of the rate. This spells out where the tokens actually
// went so a huge number doesn't read as a huge bill.
export function usageBreakdown(u: Usage): string {
  const f = (n: number): string => n.toLocaleString('en-US')
  const total = u.input + u.output + u.cacheWrite + u.cacheRead
  return [
    `Output (generated): ${f(u.output)}`,
    `Fresh input: ${f(u.input)}`,
    `Cache write (1.25x): ${f(u.cacheWrite)}`,
    `Cache read (~0.1x, near-free): ${f(u.cacheRead)}`,
    `Total counted: ${f(total)}`,
    `Cost: ${formatCost(u.costUsd)}`
  ].join('\n')
}

// Condense a prompt into a short node title: first non-empty line, stripped of
// markdown noise and branch-quote scaffolding, truncated to a few words.
export function autoTitle(text: string): string {
  const firstLine =
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('>') && !/^regarding this part/i.test(l)) ?? text.trim()
  const clean = firstLine
    .replace(/^[#>*\-\s]+/, '')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) return 'Untitled'
  if (clean.length <= 42) return clean
  return clean.slice(0, 42).replace(/\s+\S*$/, '') + '…'
}

// Full text of the node's most recent assistant turn (untruncated), for
// collecting findings across branches.
export function lastAssistantText(node: CanvasNode): string {
  for (let i = node.turns.length - 1; i >= 0; i--) {
    const turn = node.turns[i]
    if (turn.role !== 'assistant') continue
    const text = turn.blocks
      .filter((b) => b.kind === 'text' && b.text)
      .map((b) => b.text)
      .join('\n')
      .trim()
    if (text) return text
  }
  return '(no response yet)'
}

export function nodePreview(node: CanvasNode): string {
  for (let i = node.turns.length - 1; i >= 0; i--) {
    const turn = node.turns[i]
    if (turn.role !== 'assistant') continue
    const text = turn.blocks
      .filter((b) => b.kind === 'text' && b.text)
      .map((b) => b.text)
      .join(' ')
      .trim()
    if (text) return text.length > 160 ? text.slice(0, 160) + '…' : text
  }
  const firstUser = node.turns.find((t) => t.role === 'user')
  if (firstUser) {
    const t = firstUser.blocks.map((b) => b.text).join(' ').trim()
    return t.length > 160 ? t.slice(0, 160) + '…' : t
  }
  return 'Empty session. Click to open.'
}
