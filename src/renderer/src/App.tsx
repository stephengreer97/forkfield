import { useCallback, useEffect, useRef } from 'react'
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

  const doDelete = useCallback((nodeId: string) => {
    const state = useStore.getState()
    const c = state.canvas
    if (!c) return
    const kids = descendantIds(c.nodes, nodeId)
    const msg = kids.length
      ? `Delete this node and its ${kids.length} descendant branch${
          kids.length === 1 ? '' : 'es'
        }? This cannot be undone.`
      : 'Delete this node? This cannot be undone.'
    if (!window.confirm(msg)) return
    const removed = state.deleteNode(nodeId)
    for (const id of removed) window.branchpad.interrupt(id)
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
      <Canvas onOpen={(id) => useStore.getState().openNode(id)} onDelete={doDelete} onRespondPermission={respondPermission} />
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
        <p>A branching canvas for Claude Code. Choose a folder to open your first session in.</p>
        <button className="btn primary" onClick={props.onOpen}>
          Open a folder
        </button>
      </div>
    </div>
  )
}
