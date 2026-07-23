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

  useEffect(() => {
    let mounted = true
    window.branchpad.loadCanvas().then((c) => {
      if (!mounted || !c) return
      useStore.getState().setCanvas(c)
      window.branchpad.setBypass(c.settings.bypassPermissions)
    })
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    return window.branchpad.onSessionEvent((e) => useStore.getState().applyEvent(e))
  }, [])

  const saveTimer = useRef<number | null>(null)
  useEffect(() => {
    if (!canvas) return
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void window.branchpad.saveCanvas(canvas)
    }, 400)
  }, [canvas])

  const sendMessage = useCallback((nodeId: string, text: string) => {
    const node = getNode(nodeId)
    if (!node) return
    useStore.getState().appendUserTurn(nodeId, text)
    void window.branchpad.startTurn({
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
      void window.branchpad.startTurn({
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
    for (const id of removed) window.branchpad.interrupt(id)
    setConfirmDelete(null)
  }, [])

  const respondPermission = useCallback((nodeId: string, requestId: string, allow: boolean) => {
    window.branchpad.respondPermission(requestId, allow)
    useStore.getState().clearPermission(nodeId)
  }, [])

  const interrupt = useCallback((nodeId: string) => {
    window.branchpad.interrupt(nodeId)
  }, [])

  const toggleBypass = useCallback((on: boolean) => {
    useStore.getState().setBypass(on)
    window.branchpad.setBypass(on)
  }, [])

  const openFolder = useCallback(async () => {
    const dir = await window.branchpad.chooseDirectory()
    if (dir) useStore.getState().initCanvas(dir)
  }, [])

  if (!canvas) {
    return <EmptyState onOpen={openFolder} />
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
        onOpenFolder={openFolder}
      />
      <Canvas
        onOpen={(id) => useStore.getState().openNode(id)}
        onMenu={onMenu}
        onRespondPermission={respondPermission}
      />
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
  onOpenFolder: () => void
}): JSX.Element {
  return (
    <div className="topbar">
      <div className="topbar-left">
        <span className="brand">Branchpad</span>
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
        <button className="btn" onClick={props.onOpenFolder}>
          New root
        </button>
      </div>
    </div>
  )
}

function EmptyState(props: { onOpen: () => void }): JSX.Element {
  return (
    <div className="empty">
      <div className="empty-card">
        <h1>Branchpad</h1>
        <p className="empty-lead">Choose a folder to start a Claude Code session in.</p>
        <p className="empty-sub">
          Branchpad opens a Claude Code session in the folder you pick, the same as running{' '}
          <code>claude</code> in that directory. That session becomes your root node on the canvas.
          From any response you can highlight text and branch off into new sessions.
        </p>
        <button className="btn primary lg" onClick={props.onOpen}>
          Choose folder and start session
        </button>
      </div>
    </div>
  )
}
