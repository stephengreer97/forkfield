import { useEffect, useRef, useState } from 'react'
import type { JSX, MouseEvent as ReactMouseEvent } from 'react'
import type { CanvasNode, ContentBlock, Turn } from '../../../shared/types'
import type { PendingPermission } from '../store'
import { formatCost, formatTokens } from '../util'
import { Markdown } from './Markdown'
import Icon from './Icon'

interface BranchPopover {
  text: string
  turnIndex: number
  x: number
  y: number
}

// "claude-opus-4-8" / "claude-3-5-sonnet-..." -> "opus" / "sonnet" / "haiku".
function shortModel(model: string): string {
  const m = model.toLowerCase()
  if (m.includes('opus')) return 'opus'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('haiku')) return 'haiku'
  return model
}

export default function CliView(props: {
  node: CanvasNode
  anim?: 'collapse' | 'enter' | null
  showToolDetail?: boolean
  permission?: PendingPermission
  onClose: () => void
  onSend: (nodeId: string, text: string) => void
  onBranch: (parentId: string, turnIndex: number, selection: string, question: string) => void
  onFanOut?: (parentId: string, turnIndex: number, selection: string, questions: string[]) => void
  onInterrupt: (nodeId: string) => void
  onRespondPermission: (nodeId: string, requestId: string, allow: boolean) => void
  onShowDiff?: (nodeId: string) => void
  onRetry?: (nodeId: string) => void
  onOpenEditor?: (nodeId: string) => void
  onPromote?: (nodeId: string) => void
  lineage?: { id: string; title: string }[]
  onNavigate?: (nodeId: string) => void
}): JSX.Element {
  const { node } = props
  const [focus, setFocus] = useState(false)
  const [input, setInput] = useState('')
  const [popover, setPopover] = useState<BranchPopover | null>(null)
  const [question, setQuestion] = useState('')
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; text: string } | null>(null)
  const [acIndex, setAcIndex] = useState(0)
  const [acDismissed, setAcDismissed] = useState(false)
  const [histIndex, setHistIndex] = useState<number | null>(null)
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const questionRef = useRef<HTMLTextAreaElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const lastSelRef = useRef<string>('')
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const inputRef = useRef('')
  const stashRef = useRef<{ text: string; time: number } | null>(null)
  const thinking = node.status === 'thinking' || node.status === 'awaiting_permission'

  // Slash command autocomplete, driven by the command list the SDK advertises.
  const commands = node.slashCommands ?? []
  const acQuery =
    input.startsWith('/') && !input.includes(' ') ? input.slice(1).toLowerCase() : null
  const acMatches =
    acQuery !== null ? commands.filter((c) => c.toLowerCase().startsWith(acQuery)).slice(0, 8) : []
  const showAc = acMatches.length > 0 && !acDismissed
  const acActive = Math.min(acIndex, acMatches.length - 1)

  // Previous messages for up/down recall (terminal-style history).
  const history = node.turns
    .filter((t) => t.role === 'user')
    .map((t) => t.blocks.filter((b) => b.kind === 'text').map((b) => b.text ?? '').join(''))
    .filter((s) => s.trim().length > 0)

  function acceptCompletion(cmd: string): void {
    setInput('/' + cmd + ' ')
    setAcDismissed(true)
  }

  function insertNewlineAtCaret(): void {
    const el = textareaRef.current
    if (!el) {
      setInput(input + '\n')
      return
    }
    const start = el.selectionStart
    const end = el.selectionEnd
    setInput(input.slice(0, start) + '\n' + input.slice(end))
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = start + 1
    })
  }

  // Mirror input into a ref for the window key handler, and auto-grow the box.
  useEffect(() => {
    inputRef.current = input
    const el = textareaRef.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 220) + 'px'
    }
  }, [input])

  // Auto-grow the branch question box as it fills with text.
  useEffect(() => {
    const el = questionRef.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 160) + 'px'
    }
  }, [question, popover])

  // Auto scroll to bottom as the transcript grows.
  useEffect(() => {
    const el = transcriptRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [node.turns])

  // ctrl+c interrupts a thinking node.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) {
        if (popover) {
          const text = window.getSelection()?.toString() || popover.text
          void navigator.clipboard.writeText(text)
          return
        }
        if (thinking) {
          e.preventDefault()
          props.onInterrupt(node.id)
          return
        }
        // No selection, not thinking: clear the input and stash it; a quick
        // second ctrl+c puts it back.
        e.preventDefault()
        const current = inputRef.current
        if (current.trim()) {
          stashRef.current = { text: current, time: Date.now() }
          setInput('')
        } else if (stashRef.current && Date.now() - stashRef.current.time < 4000) {
          setInput(stashRef.current.text)
          stashRef.current = null
        }
        return
      }
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [thinking, node.id, popover])

  useEffect(() => {
    if (popover) questionRef.current?.focus()
  }, [popover])

  // Click away from the branch popover to dismiss it.
  useEffect(() => {
    if (!popover) return
    const onDown = (e: MouseEvent): void => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setPopover(null)
      }
    }
    const id = window.setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    return () => {
      window.clearTimeout(id)
      document.removeEventListener('mousedown', onDown)
    }
  }, [popover])

  // Clear the persistent highlight when the popover closes, and on unmount.
  useEffect(() => {
    if (!popover) clearSelectionHighlight()
  }, [popover])
  useEffect(() => () => clearSelectionHighlight(), [])

  function handleMouseUp(): void {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed) return
    const text = sel.toString().trim()
    if (!text) return
    lastSelRef.current = text
    const anchor = sel.anchorNode
    const parent = anchor instanceof Element ? anchor : anchor?.parentElement ?? null
    const el = parent?.closest('[data-turn-index]') as HTMLElement | null
    if (!el) return
    const turnIndex = Number(el.getAttribute('data-turn-index'))
    const range0 = sel.getRangeAt(0)
    const rect = range0.getBoundingClientRect()
    const range = range0.cloneRange()
    setQuestion('')
    setPopover({ text, turnIndex, x: rect.left, y: rect.bottom + 6 })
    // Keep the selection visibly highlighted (independent of the live
    // selection, which collapses when focus moves to the branch input).
    try {
      const HL = (window as unknown as { Highlight?: new (r: Range) => unknown }).Highlight
      const reg = (CSS as unknown as { highlights?: { set(k: string, v: unknown): void } })
        .highlights
      if (HL && reg) reg.set('forkfield-sel', new HL(range))
    } catch {
      // Custom Highlight API not available.
    }
  }

  function handleContextMenu(e: ReactMouseEvent): void {
    const live = window.getSelection()?.toString().trim() ?? ''
    const text = live || lastSelRef.current
    if (!text) return
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY, text })
  }

  function submitBranch(): void {
    if (!popover) return
    const q = question.trim()
    if (!q) return
    props.onBranch(node.id, popover.turnIndex, popover.text, q)
    setPopover(null)
    setQuestion('')
    window.getSelection()?.removeAllRanges()
  }

  function submitFanOut(): void {
    if (!popover || !props.onFanOut) return
    const parts = question
      .split(/[|\n]/)
      .map((p) => p.trim())
      .filter(Boolean)
    if (parts.length < 2) {
      submitBranch()
      return
    }
    props.onFanOut(node.id, popover.turnIndex, popover.text, parts)
    setPopover(null)
    setQuestion('')
    window.getSelection()?.removeAllRanges()
  }

  const fanCount = question.split(/[|\n]/).filter((p) => p.trim()).length

  function send(): void {
    const text = input.trim()
    if (!text || thinking) return
    props.onSend(node.id, text)
    setInput('')
    setHistIndex(null)
  }

  const tokens = node.usage.input + node.usage.output + node.usage.cacheRead + node.usage.cacheWrite

  return (
    <div
      className="cli-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
    >
      <div
        className={`cli-panel${focus ? ' focus' : ''}${
          props.anim === 'collapse' ? ' anim-collapse' : props.anim === 'enter' ? ' anim-enter' : ''
        }`}
      >
        <div className="cli-header">
          <div className="cli-title">
            {props.lineage && props.lineage.length > 1 ? (
              <nav className="cli-breadcrumb">
                {props.lineage.map((h, i) => {
                  const last = i === props.lineage!.length - 1
                  return (
                    <span key={h.id} className="crumb-wrap">
                      {i > 0 && <Icon name="chevronRight" size={11} className="crumb-sep" />}
                      {last ? (
                        <span className="crumb current">{h.title}</span>
                      ) : (
                        <button className="crumb" onClick={() => props.onNavigate?.(h.id)}>
                          {h.title}
                        </button>
                      )}
                    </span>
                  )
                })}
              </nav>
            ) : (
              <span className="cli-node-title">{node.title}</span>
            )}
            <span className="cli-cwd">{node.workingDirectory}</span>
          </div>
          <div className="cli-header-right">
            <span className="usage-pill" title="Model for this node (change with /model)">
              {node.model ?? 'default'}
            </span>
            <span className="usage-pill">
              {formatTokens(tokens)} tok · {formatCost(node.usage.costUsd)}
            </span>
            <span className={`cli-status status-${node.status}`}>
              <span className="status-dot" />
              {node.status}
            </span>
            {node.worktree && props.onShowDiff && (
              <button
                className="btn tiny"
                title="Show this branch's file changes"
                onClick={() => props.onShowDiff!(node.id)}
              >
                <Icon name="diff" size={13} />
                Diff
              </button>
            )}
            {node.worktree && props.onOpenEditor && (
              <button
                className="btn tiny ghost icon-btn"
                title="Open this branch's worktree in your editor"
                onClick={() => props.onOpenEditor!(node.id)}
              >
                <Icon name="external" size={14} />
              </button>
            )}
            {node.worktree && props.onPromote && (
              <button
                className="btn tiny"
                title="Merge this branch's commits into the base branch"
                onClick={() => props.onPromote!(node.id)}
              >
                <Icon name="merge" size={13} />
                Promote
              </button>
            )}
            <button
              className="btn tiny ghost icon-btn"
              title={focus ? 'Exit focus mode' : 'Focus mode'}
              onClick={() => setFocus((f) => !f)}
            >
              <Icon name={focus ? 'collapse' : 'expand'} size={14} />
            </button>
            <button className="btn tiny ghost icon-btn" title="Close" onClick={props.onClose}>
              <Icon name="close" size={14} />
            </button>
          </div>
        </div>

        {node.seedSelection && (
          <div className="cli-seed" title="This branch was forked from a highlighted selection">
            forked from: “{node.seedSelection.slice(0, 200)}
            {node.seedSelection.length > 200 ? '…' : ''}”
          </div>
        )}

        <div
          className="cli-transcript"
          ref={transcriptRef}
          onMouseUp={handleMouseUp}
          onContextMenu={handleContextMenu}
        >
          {node.turns.length === 0 && node.sessionId ? (
            <div className="cli-skeleton" aria-label="Loading history">
              <div className="skeleton skeleton-line" style={{ width: '40%' }} />
              <div className="skeleton skeleton-line" style={{ width: '92%' }} />
              <div className="skeleton skeleton-line" style={{ width: '85%' }} />
              <div className="skeleton skeleton-line" style={{ width: '60%' }} />
            </div>
          ) : (
            node.turns.length === 0 && (
              <div className="cli-hint">
                This node is a Claude Code session running in <b>{node.workingDirectory}</b>.
                <br />
                <br />
                Type a message below to start. Highlight any assistant text later to branch off it.
              </div>
            )
          )}
          {node.turns.map((turn, idx) => (
            <TurnView
              key={turn.id}
              turn={turn}
              index={idx}
              showToolDetail={props.showToolDetail !== false}
            />
          ))}
          {thinking && (
            <div className="thinking-indicator" aria-label="Claude is thinking">
              <span className="thinking-dot" />
              <span className="thinking-dot" />
              <span className="thinking-dot" />
            </div>
          )}
        </div>

        {props.permission && (
          <div className="cli-permission">
            <span>
              Allow <b>{props.permission.toolName}</b> to run?
            </span>
            <div className="perm-actions">
              <button
                className="btn tiny"
                onClick={() => props.onRespondPermission(node.id, props.permission!.requestId, true)}
              >
                Allow
              </button>
              <button
                className="btn tiny ghost"
                onClick={() =>
                  props.onRespondPermission(node.id, props.permission!.requestId, false)
                }
              >
                Deny
              </button>
            </div>
          </div>
        )}

        <div className="cli-input">
          {showAc && (
            <div className="autocomplete">
              {acMatches.map((c, i) => (
                <button
                  key={c}
                  className={`ac-item ${i === acActive ? 'active' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    acceptCompletion(c)
                  }}
                >
                  /{c}
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={input}
            placeholder="Message this node, or / for commands"
            onChange={(e) => {
              setInput(e.target.value)
              setAcIndex(0)
              setAcDismissed(false)
              setHistIndex(null)
            }}
            onKeyDown={(e) => {
              if (showAc) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setAcIndex((i) => (i + 1) % acMatches.length)
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setAcIndex((i) => (i - 1 + acMatches.length) % acMatches.length)
                  return
                }
                if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                  e.preventDefault()
                  acceptCompletion(acMatches[acActive])
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setAcDismissed(true)
                  return
                }
              }
              // Ctrl+Enter inserts a newline, like Shift+Enter.
              if (e.key === 'Enter' && e.ctrlKey) {
                e.preventDefault()
                insertNewlineAtCaret()
                return
              }
              // Up/Down recall previous messages when the caret is on the edge line.
              if (e.key === 'ArrowUp' && history.length) {
                const caret = e.currentTarget.selectionStart
                if (!input.slice(0, caret).includes('\n')) {
                  e.preventDefault()
                  const idx =
                    histIndex === null ? history.length - 1 : Math.max(0, histIndex - 1)
                  setHistIndex(idx)
                  setInput(history[idx])
                  return
                }
              }
              if (e.key === 'ArrowDown' && histIndex !== null) {
                const caret = e.currentTarget.selectionStart
                if (!input.slice(caret).includes('\n')) {
                  e.preventDefault()
                  if (histIndex >= history.length - 1) {
                    setHistIndex(null)
                    setInput('')
                  } else {
                    const idx = histIndex + 1
                    setHistIndex(idx)
                    setInput(history[idx])
                  }
                  return
                }
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          {thinking ? (
            <button className="btn stop" onClick={() => props.onInterrupt(node.id)}>
              Stop (ctrl+c)
            </button>
          ) : (
            <>
              {props.onRetry && node.turns.some((t) => t.role === 'assistant') && !input.trim() && (
                <button
                  className="btn ghost"
                  title="Ask the last question again"
                  onClick={() => props.onRetry!(node.id)}
                >
                  <Icon name="undo" size={14} />
                  Retry
                </button>
              )}
              <button className="btn primary" onClick={send} disabled={!input.trim()}>
                <Icon name="send" size={14} />
                Send
              </button>
            </>
          )}
        </div>
      </div>

      {popover && (
        <div
          ref={popoverRef}
          className="branch-popover"
          style={{ left: popover.x, top: popover.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="branch-quote">“{popover.text.slice(0, 120)}
            {popover.text.length > 120 ? '…' : ''}”</div>
          <div className="branch-row">
            <textarea
              ref={questionRef}
              value={question}
              rows={1}
              placeholder="Ask about this…  (use | to fan out)"
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submitBranch()
                }
                if (e.key === 'Escape') setPopover(null)
              }}
            />
            <button className="btn tiny primary" onClick={submitBranch} disabled={!question.trim()}>
              Branch
            </button>
          </div>
          {props.onFanOut && fanCount > 1 && (
            <button className="btn tiny fanout" onClick={submitFanOut}>
              Fan out into {fanCount} branches
            </button>
          )}
        </div>
      )}
      {ctxMenu && (
        <>
          <div
            className="menu-backdrop"
            onMouseDown={() => setCtxMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault()
              setCtxMenu(null)
            }}
          />
          <div className="context-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
            <button
              className="menu-item"
              onClick={() => {
                void navigator.clipboard.writeText(ctxMenu.text)
                setCtxMenu(null)
              }}
            >
              Copy
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function TurnView(props: {
  turn: Turn
  index: number
  showToolDetail: boolean
}): JSX.Element {
  const { turn, index } = props
  return (
    <div className={`turn turn-${turn.role}`} data-turn-index={index}>
      <div className="turn-role">
        {turn.role === 'user' ? 'you' : 'claude'}
        {turn.role === 'assistant' && turn.model && (
          <span className="turn-model">{shortModel(turn.model)}</span>
        )}
      </div>
      <div className="turn-body">
        {turn.blocks.map((b, i) => (
          <BlockView
            key={i}
            block={b}
            markdown={turn.role === 'assistant'}
            showToolDetail={props.showToolDetail}
          />
        ))}
      </div>
    </div>
  )
}

function BlockView(props: {
  block: ContentBlock
  markdown: boolean
  showToolDetail: boolean
}): JSX.Element | null {
  const b = props.block
  if (b.kind === 'text') {
    const raw = b.text ?? ''
    const cmd = parseCommand(raw)
    if (cmd) {
      return (
        <div className="cmd-line">
          <span className="cmd-chip">
            /{cmd.name}
            {cmd.args ? ' ' + cmd.args : ''}
          </span>
        </div>
      )
    }
    const clean = cleanTags(raw)
    return props.markdown ? (
      <Markdown text={clean} />
    ) : (
      <div className="block-text">{clean}</div>
    )
  }
  if (b.kind === 'tool_use') {
    if (!props.showToolDetail) {
      return (
        <div className="block-tool compact">
          <Icon name="chevronRight" size={12} /> <b>{b.toolName}</b>
        </div>
      )
    }
    return (
      <div className="block-tool">
        <span className="block-tool-head">
          <Icon name="chevronRight" size={12} /> <b>{b.toolName}</b>
        </span>
        <pre className="tool-input">{safeJson(b.toolInput)}</pre>
      </div>
    )
  }
  if (!props.showToolDetail) return null
  return (
    <details className={`block-result ${b.isError ? 'error' : ''}`}>
      <summary>{b.isError ? 'tool error' : 'tool result'}</summary>
      <pre>{b.text}</pre>
    </details>
  )
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

// Detect a slash command, either the transcript's wrapped form
// (<command-name>/model</command-name>...) or a plainly typed "/model args".
function parseCommand(text: string): { name: string; args: string } | null {
  const wrapped = text.match(/<command-name>\s*\/?\s*([^<]*?)\s*<\/command-name>/)
  if (wrapped) {
    const name = wrapped[1].trim()
    if (!name) return null
    const am = text.match(/<command-args>\s*([^<]*?)\s*<\/command-args>/)
    return { name, args: am ? am[1].trim() : '' }
  }
  const t = text.trim()
  if (t.includes('\n')) return null
  const plain = t.match(/^\/([a-zA-Z][a-zA-Z0-9_-]*)(?:\s+(.*))?$/)
  if (plain) return { name: plain[1], args: plain[2]?.trim() ?? '' }
  return null
}

// Strip terminal ANSI color codes and transcript wrapper tags from text that
// was produced for a terminal but is rendered as HTML here.
function cleanTags(text: string): string {
  return (
    text
      // ANSI SGR sequences like ESC[1m (bold), ESC[2m (dim), ESC[22m.
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\[[0-9;]*m(?!\])/g, '')
      .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
      .replace(/<command-name>[\s\S]*?<\/command-name>/g, '')
      .replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
      .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
      .replace(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/g, '$1')
      .trim()
  )
}

function clearSelectionHighlight(): void {
  try {
    ;(CSS as unknown as { highlights?: { delete(k: string): void } }).highlights?.delete(
      'forkfield-sel'
    )
  } catch {
    // Custom Highlight API not available.
  }
}
