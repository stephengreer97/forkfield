import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { useStore } from './store'
import Canvas from './components/Canvas'
import CliView from './components/CliView'
import { buildBranchPrompt, descendantIds, formatCost, formatTokens } from './util'
import type { CanvasNode } from '../../shared/types'

function getNode(id: string): CanvasNode | undefined {
  return useStore.getState().canvas?.nodes.find((n) => n.id === id)
}

export default function App(): JSX.Element {
  const canvas = useStore((s) => s.canvas)
  const openNodeId = useStore((s) => s.openNodeId)
  const permissions = useStore((s) => s.permissions)
  const [menu, setMenu] = useState<{ nodeId: string; x: number; y: number } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<{ nodeId: string; count: number } | null>(
    null
  )
  const [newRootChoice, setNewRootChoice] = useState(false)
  const [resumePrompt, setResumePrompt] = useState(false)
  const [currentFilePath, setCurrentFilePath] = useState<string | null>(() =>
    localStorage.getItem('forkfield:file')
  )
  const filePathRef = useRef<string | null>(null)

  useEffect(() => {
    let mounted = true
    window.forkfield.loadCanvas().then((c) => {
      if (!mounted) return
      if (c) {
        useStore.getState().setCanvas(c)
        window.forkfield.setBypass(c.settings.bypassPermissions)
      } else {
        useStore.getState().createEmptyCanvas()
      }
    })
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    return window.forkfield.onSessionEvent((e) => useStore.getState().applyEvent(e))
  }, [])

  const saveTimer = useRef<number | null>(null)
  useEffect(() => {
    if (!canvas) return
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void window.forkfield.saveCanvas(canvas)
    }, 400)
  }, [canvas])

  const sendMessage = useCallback((nodeId: string, text: string) => {
    const node = getNode(nodeId)
    if (!node) return
    useStore.getState().appendUserTurn(nodeId, text)
    void window.forkfield.startTurn({
      nodeId,
      prompt: text,
      cwd: node.workingDirectory,
      resumeSessionId: node.sessionId,
      fork: false
    })
  }, [])

  const createBranch = useCallback(
    (parentId: string, turnIndex: number, selection: string, question: string) => {
      const parent = getNode(parentId)
      if (!parent) return
      const node = useStore.getState().addBranch(parentId, turnIndex, selection)
      if (!node) return
      const prompt = buildBranchPrompt(selection, question)
      useStore.getState().appendUserTurn(node.id, prompt)
      void window.forkfield.startTurn({
        nodeId: node.id,
        prompt,
        cwd: parent.workingDirectory,
        resumeSessionId: parent.sessionId,
        fork: true
      })
    },
    []
  )

  const onMenu = useCallback((nodeId: string, x: number, y: number) => {
    setMenu({ nodeId, x, y })
  }, [])

  const requestDelete = useCallback((nodeId: string) => {
    const c = useStore.getState().canvas
    if (!c) return
    const count = descendantIds(c.nodes, nodeId).length
    setConfirmDelete({ nodeId, count })
  }, [])

  const performDelete = useCallback((nodeId: string) => {
    const removed = useStore.getState().deleteNode(nodeId)
    for (const id of removed) window.forkfield.interrupt(id)
    setConfirmDelete(null)
  }, [])

  const respondPermission = useCallback((nodeId: string, requestId: string, allow: boolean) => {
    window.forkfield.respondPermission(requestId, allow)
    useStore.getState().clearPermission(nodeId)
  }, [])

  const interrupt = useCallback((nodeId: string) => {
    window.forkfield.interrupt(nodeId)
  }, [])

  const toggleBypass = useCallback((on: boolean) => {
    useStore.getState().setBypass(on)
    window.forkfield.setBypass(on)
  }, [])

  useEffect(() => {
    filePathRef.current = currentFilePath
    if (currentFilePath) localStorage.setItem('forkfield:file', currentFilePath)
    else localStorage.removeItem('forkfield:file')
    const name = currentFilePath ? currentFilePath.split(/[\\/]/).pop() : null
    document.title = name ? `Forkfield — ${name}` : 'Forkfield'
  }, [currentFilePath])

  const handleNew = useCallback(() => {
    useStore.getState().createEmptyCanvas()
    setCurrentFilePath(null)
  }, [])

  const handleOpen = useCallback(async () => {
    const res = await window.forkfield.openFile()
    if (!res) return
    useStore.getState().setCanvas(res.canvas)
    window.forkfield.setBypass(res.canvas.settings.bypassPermissions)
    useStore.getState().openNode(null)
    setCurrentFilePath(res.path)
  }, [])

  const handleSave = useCallback(async () => {
    const c = useStore.getState().canvas
    if (!c) return
    const path = await window.forkfield.saveFile(c, filePathRef.current)
    if (path) setCurrentFilePath(path)
  }, [])

  const handleSaveAs = useCallback(async () => {
    const c = useStore.getState().canvas
    if (!c) return
    const path = await window.forkfield.saveFile(c, null)
    if (path) setCurrentFilePath(path)
  }, [])

  useEffect(() => {
    return window.forkfield.onMenu((action) => {
      if (action === 'new') handleNew()
      else if (action === 'open') void handleOpen()
      else if (action === 'save') void handleSave()
      else if (action === 'saveAs') void handleSaveAs()
    })
  }, [handleNew, handleOpen, handleSave, handleSaveAs])

  // Adds an independent root to the existing canvas. Optionally resumes a
  // Claude session by id. Both paths prompt for the folder.
  const addNewSession = useCallback(async (resumeSessionId?: string) => {
    const dir = await window.forkfield.chooseDirectory()
    if (!dir) return
    const node = useStore.getState().addRoot(dir, resumeSessionId ?? null)
    if (node && resumeSessionId) {
      const turns = await window.forkfield.loadHistory(resumeSessionId)
      if (turns && turns.length) useStore.getState().setNodeTurns(node.id, turns)
    }
  }, [])

  if (!canvas) {
    return (
      <div className="app">
        <div className="canvas" />
      </div>
    )
  }

  const total = canvas.nodes.reduce(
    (acc, n) => ({
      tokens:
        acc.tokens + n.usage.input + n.usage.output + n.usage.cacheRead + n.usage.cacheWrite,
      cost: acc.cost + n.usage.costUsd
    }),
    { tokens: 0, cost: 0 }
  )

  const openNode = openNodeId ? canvas.nodes.find((n) => n.id === openNodeId) ?? null : null

  return (
    <div className="app">
      <TopBar
        totalTokens={total.tokens}
        totalCost={total.cost}
        bypass={canvas.settings.bypassPermissions}
        onToggleBypass={toggleBypass}
        onNewRoot={() => setNewRootChoice(true)}
      />
      <Canvas
        onOpen={(id) => useStore.getState().openNode(id)}
        onMenu={onMenu}
        onRespondPermission={respondPermission}
      />
      {canvas.nodes.length === 0 && <EmptyCanvasHint />}
      {openNode && (
        <CliView
          node={openNode}
          permission={permissions[openNode.id]}
          onClose={() => useStore.getState().openNode(null)}
          onSend={sendMessage}
          onBranch={createBranch}
          onInterrupt={interrupt}
          onRespondPermission={respondPermission}
        />
      )}
      {menu && (
        <NodeMenu
          x={menu.x}
          y={menu.y}
          isRoot={!canvas.nodes.find((n) => n.id === menu.nodeId)?.parentId}
          onOpen={() => {
            useStore.getState().openNode(menu.nodeId)
            setMenu(null)
          }}
          onMarkUnread={() => {
            useStore.getState().markUnread(menu.nodeId)
            setMenu(null)
          }}
          onMakeRoot={() => {
            useStore.getState().makeRoot(menu.nodeId)
            setMenu(null)
          }}
          onDelete={() => {
            const id = menu.nodeId
            setMenu(null)
            requestDelete(id)
          }}
          onClose={() => setMenu(null)}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete node"
          message={
            confirmDelete.count > 0
              ? `This deletes the node and its ${confirmDelete.count} descendant branch${
                  confirmDelete.count === 1 ? '' : 'es'
                }. This cannot be undone.`
              : 'This deletes the node. This cannot be undone.'
          }
          confirmLabel="Delete"
          danger
          onConfirm={() => performDelete(confirmDelete.nodeId)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
      {newRootChoice && (
        <ChoiceDialog
          title="New root session"
          onCancel={() => setNewRootChoice(false)}
          options={[
            {
              label: 'Start a new session',
              desc: 'Pick a folder and begin a fresh Claude Code session.',
              onClick: () => {
                setNewRootChoice(false)
                void addNewSession()
              }
            },
            {
              label: 'Resume a session',
              desc: 'Enter an existing Claude session id, then pick its folder.',
              onClick: () => {
                setNewRootChoice(false)
                setResumePrompt(true)
              }
            }
          ]}
        />
      )}
      {resumePrompt && (
        <PromptDialog
          title="Resume a session"
          label="Claude session id"
          placeholder="paste the session id"
          confirmLabel="Choose folder…"
          onCancel={() => setResumePrompt(false)}
          onSubmit={(id) => {
            setResumePrompt(false)
            void addNewSession(id.trim())
          }}
        />
      )}
    </div>
  )
}

function ChoiceDialog(props: {
  title: string
  options: { label: string; desc: string; onClick: () => void }[]
  onCancel: () => void
}): JSX.Element {
  return (
    <div
      className="confirm-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onCancel()
      }}
    >
      <div className="confirm-dialog">
        <h3>{props.title}</h3>
        <div className="choice-list">
          {props.options.map((o, i) => (
            <button key={i} className="choice-item" onClick={o.onClick}>
              <span className="choice-label">{o.label}</span>
              <span className="choice-desc">{o.desc}</span>
            </button>
          ))}
        </div>
        <div className="confirm-actions">
          <button className="btn" onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

function PromptDialog(props: {
  title: string
  label: string
  placeholder?: string
  confirmLabel: string
  onSubmit: (value: string) => void
  onCancel: () => void
}): JSX.Element {
  const [value, setValue] = useState('')
  return (
    <div
      className="confirm-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onCancel()
      }}
    >
      <div className="confirm-dialog">
        <h3>{props.title}</h3>
        <label className="prompt-label">{props.label}</label>
        <input
          autoFocus
          className="prompt-input"
          placeholder={props.placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && value.trim()) props.onSubmit(value)
            if (e.key === 'Escape') props.onCancel()
          }}
        />
        <div className="confirm-actions">
          <button className="btn" onClick={props.onCancel}>
            Cancel
          </button>
          <button className="btn primary" disabled={!value.trim()} onClick={() => props.onSubmit(value)}>
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function NodeMenu(props: {
  x: number
  y: number
  isRoot: boolean
  onOpen: () => void
  onMarkUnread: () => void
  onMakeRoot: () => void
  onDelete: () => void
  onClose: () => void
}): JSX.Element {
  return (
    <>
      <div
        className="menu-backdrop"
        onMouseDown={props.onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          props.onClose()
        }}
      />
      <div className="context-menu" style={{ left: props.x, top: props.y }}>
        <button className="menu-item" onClick={props.onOpen}>
          Open
        </button>
        <button className="menu-item" onClick={props.onMarkUnread}>
          Mark Unread
        </button>
        <button className="menu-item" onClick={props.onMakeRoot} disabled={props.isRoot}>
          Make Root
        </button>
        <div className="menu-sep" />
        <button className="menu-item danger" onClick={props.onDelete}>
          Delete…
        </button>
      </div>
    </>
  )
}

function ConfirmDialog(props: {
  title: string
  message: string
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}): JSX.Element {
  return (
    <div
      className="confirm-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onCancel()
      }}
    >
      <div className="confirm-dialog">
        <h3>{props.title}</h3>
        <p>{props.message}</p>
        <div className="confirm-actions">
          <button className="btn" onClick={props.onCancel}>
            Cancel
          </button>
          <button
            className={`btn ${props.danger ? 'stop' : 'primary'}`}
            onClick={props.onConfirm}
          >
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function TopBar(props: {
  totalTokens: number
  totalCost: number
  bypass: boolean
  onToggleBypass: (on: boolean) => void
  onNewRoot: () => void
}): JSX.Element {
  return (
    <div className="topbar">
      <div className="topbar-left">
        <span className="brand">Forkfield</span>
      </div>
      <div className="topbar-right">
        <span className="usage-pill" title="Total tokens and cost across all nodes">
          {formatTokens(props.totalTokens)} tok · {formatCost(props.totalCost)}
        </span>
        <label className="bypass-toggle" title="Enable --dangerously-skip-permissions for all nodes">
          <input
            type="checkbox"
            checked={props.bypass}
            onChange={(e) => props.onToggleBypass(e.target.checked)}
          />
          <span>skip permissions</span>
        </label>
        <button className="btn" onClick={props.onNewRoot}>
          New root
        </button>
      </div>
    </div>
  )
}

function EmptyCanvasHint(): JSX.Element {
  return (
    <div className="empty-hint">
      <div className="empty-hint-card">
        <h2>No sessions yet</h2>
        <p>
          Click <b>New root</b> in the top right to start a Claude Code session in a folder you
          choose. It becomes your root node, and you can branch off any response from there.
        </p>
      </div>
    </div>
  )
}
