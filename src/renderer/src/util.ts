import type { CanvasNode } from '../../shared/types'

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

export function buildBranchPrompt(selection: string, question: string): string {
  const quoted = selection
    .split('\n')
    .map((l) => '> ' + l)
    .join('\n')
  return `Regarding this part of your previous response:\n\n${quoted}\n\n${question}`
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

export function formatCost(usd: number): string {
  if (usd <= 0) return '$0.00'
  if (usd < 0.01) return '<$0.01'
  return '$' + usd.toFixed(2)
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
