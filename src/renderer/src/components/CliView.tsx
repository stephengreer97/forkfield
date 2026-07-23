import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { CanvasNode, ContentBlock, Turn } from '../../../shared/types'
import type { PendingPermission } from '../store'
import { formatCost, formatTokens } from '../util'

interface BranchPopover {
  text: string
  turnIndex: number
  x: number
  y: number
}

export default function CliView(props: {
  node: CanvasNode
  permission?: PendingPermission
  onClose: () => void
  onSend: (nodeId: string, text: string) => void
  onBranch: (parentId: string, turnIndex: number, selection: string, question: string) => void
  onInterrupt: (nodeId: string) => void
  onRespondPermission: (nodeId: string, requestId: string, allow: boolean) => void
}): JSX.Element {
  const { node } = props
  const [input, setInput] = useState('')
  const [popover, setPopover] = useState<BranchPopover | null>(null)
  const [question, setQuestion] = useState('')
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  const questionRef = useRef<HTMLInputElement | null>(null)
  const thinking = node.status === 'thinking' || node.status === 'awaiting_permission'

  // Auto scroll to bottom as the transcript grows.
  useEffect(() => {
    const el = transcriptRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [node.turns])

  // ctrl+c interrupts a thinking node.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && (e.key === 'c' || e.key === 'C') && thinking) {
        e.preventDefault()
        props.onInterrupt(node.id)
      }
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [thinking, node.id])

  useEffect(() => {
    if (popover) questionRef.current?.focus()
  }, [popover])

  function handleMouseUp(): void {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed) return
    const text = sel.toString().trim()
    if (!text) return
    const anchor = sel.anchorNode
    const parent = anchor instanceof Element ? anchor : anchor?.parentElement ?? null
    const el = parent?.closest('[data-turn-index]') as HTMLElement | null
    if (!el) return
    const turnIndex = Number(el.getAttribute('data-turn-index'))
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    setQuestion('')
    setPopover({ text, turnIndex, x: rect.left, y: rect.bottom + 6 })
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

  function send(): void {
    const text = input.trim()
    if (!text || thinking) return
    props.onSend(node.id, text)
    setInput('')
  }

  const tokens = node.usage.input + node.usage.output + node.usage.cacheRead + node.usage.cacheWrite

  return (
    <div
      className="cli-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
    >
      <div className="cli-panel">
        <div className="cli-header">
          <div className="cli-title">
            <span className="cli-node-title">{node.title}</span>
            <span className="cli-cwd">{node.workingDirectory}</span>
          </div>
          <div className="cli-header-right">
            <span className="usage-pill">
              {formatTokens(tokens)} tok · {formatCost(node.usage.costUsd)}
            </span>
            <span className={`cli-status status-${node.status}`}>{node.status}</span>
            <button className="btn tiny ghost" onClick={props.onClose}>
              ✕
            </button>
          </div>
        </div>

        {node.seedSelection && (
          <div className="cli-seed" title="This branch was forked from a highlighted selection">
            forked from: “{node.seedSelection.slice(0, 200)}
            {node.seedSelection.length > 200 ? '…' : ''}”
          </div>
        )}

        <div className="cli-transcript" ref={transcriptRef} onMouseUp={handleMouseUp}>
          {node.turns.length === 0 && (
            <div className="cli-hint">
              Type a message below to start. Highlight any assistant text to branch off it.
            </div>
          )}
          {node.turns.map((turn, idx) => (
            <TurnView key={turn.id} turn={turn} index={idx} />
          ))}
          {thinking && <div className="cli-thinking">…</div>}
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
          <textarea
            value={input}
            placeholder="Message this node, or / for commands"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
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
            <button className="btn primary" onClick={send} disabled={!input.trim()}>
              Send
            </button>
          )}
        </div>
      </div>

      {popover && (
        <div
          className="branch-popover"
          style={{ left: popover.x, top: popover.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="branch-quote">“{popover.text.slice(0, 120)}
            {popover.text.length > 120 ? '…' : ''}”</div>
          <div className="branch-row">
            <input
              ref={questionRef}
              value={question}
              placeholder="Ask about this…"
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitBranch()
                if (e.key === 'Escape') setPopover(null)
              }}
            />
            <button className="btn tiny primary" onClick={submitBranch} disabled={!question.trim()}>
              Branch
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function TurnView(props: { turn: Turn; index: number }): JSX.Element {
  const { turn, index } = props
  return (
    <div className={`turn turn-${turn.role}`} data-turn-index={index}>
      <div className="turn-role">{turn.role === 'user' ? 'you' : 'claude'}</div>
      <div className="turn-body">
        {turn.blocks.map((b, i) => (
          <BlockView key={i} block={b} />
        ))}
      </div>
    </div>
  )
}

function BlockView(props: { block: ContentBlock }): JSX.Element {
  const b = props.block
  if (b.kind === 'text') {
    return <div className="block-text">{b.text}</div>
  }
  if (b.kind === 'tool_use') {
    return (
      <div className="block-tool">
        ▷ <b>{b.toolName}</b>
        <pre className="tool-input">{safeJson(b.toolInput)}</pre>
      </div>
    )
  }
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
