import { useCallback, useEffect, useRef } from 'react'
import type { JSX } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  type NodeChange,
  type ReactFlowInstance
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useStore } from '../store'
import { descendantIds, nodeMatches } from '../util'
import type { CanvasNode } from '../../../shared/types'
import NodeCard, { type BranchNodeData } from './NodeCard'

const nodeTypes = { branch: NodeCard }

function statusColor(status: CanvasNode['status'] | undefined, dark: boolean): string {
  switch (status) {
    case 'thinking':
      return dark ? '#5b9bff' : '#2563eb'
    case 'awaiting_permission':
      return dark ? '#e0a92e' : '#d99400'
    case 'complete':
      return dark ? '#4ade80' : '#16a34a'
    case 'error':
      return dark ? '#f87171' : '#dc2626'
    default:
      return dark ? '#435060' : '#c2ccd8'
  }
}

export default function Canvas(props: {
  onOpen: (id: string) => void
  onMenu: (id: string, x: number, y: number) => void
  onRespondPermission: (nodeId: string, requestId: string, allow: boolean) => void
  search: string
  focus?: { id: string; nonce: number } | null
  fitNonce?: number
}): JSX.Element | null {
  const canvas = useStore((s) => s.canvas)
  const permissions = useStore((s) => s.permissions)
  const moveNode = useStore((s) => s.moveNode)
  const instanceRef = useRef<ReactFlowInstance | null>(null)

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      for (const c of changes) {
        if (c.type === 'position' && c.position) {
          moveNode(c.id, c.position.x, c.position.y)
        }
      }
    },
    [moveNode]
  )

  // Place the primary root on the left, vertically centered in the viewport.
  const onInit = useCallback((instance: ReactFlowInstance) => {
    instanceRef.current = instance
    const c = useStore.getState().canvas
    if (!c) return
    const root = c.nodes.find((n) => !n.parentId) ?? c.nodes[0]
    if (!root) return
    const zoom = 0.85
    const container = document.querySelector('.canvas') as HTMLElement | null
    const h = container?.clientHeight ?? window.innerHeight
    const x = 80 - root.position.x * zoom
    const y = h / 2 - root.position.y * zoom - 70
    instance.setViewport({ x, y, zoom })
  }, [])

  // Pan/zoom to a searched node when the jump target changes.
  const focusId = props.focus?.id
  const focusNonce = props.focus?.nonce
  useEffect(() => {
    const inst = instanceRef.current
    if (!inst || !focusId) return
    const n = useStore.getState().canvas?.nodes.find((x) => x.id === focusId)
    if (!n) return
    inst.setCenter(n.position.x + 132, n.position.y + 60, { zoom: 0.95, duration: 400 })
  }, [focusId, focusNonce])

  // Fit the whole graph after a tidy layout.
  useEffect(() => {
    if (props.fitNonce === undefined) return
    instanceRef.current?.fitView({ duration: 400, padding: 0.2 })
  }, [props.fitNonce])

  if (!canvas) return null

  // Hide every descendant of a collapsed node.
  const hidden = new Set<string>()
  const hiddenCount = new Map<string, number>()
  for (const n of canvas.nodes) {
    if (n.collapsed) {
      const desc = descendantIds(canvas.nodes, n.id)
      hiddenCount.set(n.id, desc.length)
      for (const id of desc) hidden.add(id)
    }
  }

  const q = props.search.trim().toLowerCase()

  const nodes: Node[] = canvas.nodes
    .filter((n) => !hidden.has(n.id))
    .map((n) => ({
      id: n.id,
      type: 'branch',
      position: n.position,
      data: {
        node: n,
        permission: permissions[n.id],
        dim: q ? !nodeMatches(n, q) : false,
        hiddenCount: hiddenCount.get(n.id) ?? 0,
        onOpen: props.onOpen,
        onMenu: props.onMenu,
        onRespondPermission: props.onRespondPermission
      } satisfies BranchNodeData as unknown as Record<string, unknown>
    }))

  const edges: Edge[] = canvas.nodes
    .filter((n) => n.parentId && !hidden.has(n.id) && !hidden.has(n.parentId as string))
    .map((n) => ({
      id: `${n.parentId}-${n.id}`,
      source: n.parentId as string,
      target: n.id,
      animated: n.status === 'thinking'
    }))

  const theme = canvas.settings.theme
  const dark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  return (
    <div className="canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onInit={onInit}
        minZoom={0.2}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
      >
        <Background color={dark ? '#2c3540' : '#c4cdda'} gap={24} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => statusColor((n.data as unknown as BranchNodeData)?.node?.status, dark)}
          maskColor={dark ? 'rgba(18,22,28,0.65)' : 'rgba(233,237,243,0.6)'}
          style={{ background: dark ? '#1b2129' : '#ffffff' }}
        />
        <Controls />
      </ReactFlow>
    </div>
  )
}
