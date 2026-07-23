import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { JSX } from 'react'
import type { CanvasNode, NodeStatus } from '../../../shared/types'
import type { PendingPermission } from '../store'
import { formatCost, formatTokens, nodePreview } from '../util'

export interface BranchNodeData {
  node: CanvasNode
  permission?: PendingPermission
  onOpen: (id: string) => void
  onDelete: (id: string) => void
  onRespondPermission: (nodeId: string, requestId: string, allow: boolean) => void
}

const STATUS_LABEL: Record<NodeStatus, string> = {
  idle: 'idle',
  thinking: 'thinking…',
  awaiting_permission: 'needs permission',
  complete: 'done',
  error: 'error'
}

export default function NodeCard({ data }: NodeProps): JSX.Element {
  const d = data as unknown as BranchNodeData
  const n = d.node
  const tokens = n.usage.input + n.usage.output + n.usage.cacheRead + n.usage.cacheWrite

  return (
    <div
      className={`node-card status-${n.status}`}
      onClick={() => d.onOpen(n.id)}
      onContextMenu={(e) => {
        e.preventDefault()
        d.onDelete(n.id)
      }}
    >
      <Handle type="target" position={Position.Left} />
      <div className="node-head">
        <span className="node-title">{n.title}</span>
        <span className={`node-status status-${n.status}`}>{STATUS_LABEL[n.status]}</span>
      </div>
      <div className="node-preview">
        {n.status === 'thinking' && n.turns.length === 0 ? '…' : nodePreview(n)}
      </div>
      {d.permission && (
        <div className="node-permission" onClick={(e) => e.stopPropagation()}>
          <div className="perm-tool">
            Run <b>{d.permission.toolName}</b>?
          </div>
          <div className="perm-actions">
            <button
              className="btn tiny"
              onClick={() => d.onRespondPermission(n.id, d.permission!.requestId, true)}
            >
              Allow
            </button>
            <button
              className="btn tiny ghost"
              onClick={() => d.onRespondPermission(n.id, d.permission!.requestId, false)}
            >
              Deny
            </button>
          </div>
        </div>
      )}
      <div className="node-foot">
        <span className="node-usage">
          {formatTokens(tokens)} tok · {formatCost(n.usage.costUsd)}
        </span>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
