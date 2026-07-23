import { useCallback } from 'react'
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
import NodeCard, { type BranchNodeData } from './NodeCard'

const nodeTypes = { branch: NodeCard }

export default function Canvas(props: {
  onOpen: (id: string) => void
  onMenu: (id: string, x: number, y: number) => void
  onRespondPermission: (nodeId: string, requestId: string, allow: boolean) => void
}): JSX.Element | null {
  const canvas = useStore((s) => s.canvas)
  const permissions = useStore((s) => s.permissions)
  const moveNode = useStore((s) => s.moveNode)

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

  if (!canvas) return null

  const nodes: Node[] = canvas.nodes.map((n) => ({
    id: n.id,
    type: 'branch',
    position: n.position,
    data: {
      node: n,
      permission: permissions[n.id],
      onOpen: props.onOpen,
      onMenu: props.onMenu,
      onRespondPermission: props.onRespondPermission
    } satisfies BranchNodeData as unknown as Record<string, unknown>
  }))

  const edges: Edge[] = canvas.nodes
    .filter((n) => n.parentId)
    .map((n) => ({
      id: `${n.parentId}-${n.id}`,
      source: n.parentId as string,
      target: n.id,
      animated: n.status === 'thinking'
    }))

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
        <Background color="#c4cdda" gap={24} />
        <MiniMap pannable zoomable nodeColor="#c2ccd8" maskColor="rgba(233,237,243,0.6)" />
        <Controls />
      </ReactFlow>
    </div>
  )
}
