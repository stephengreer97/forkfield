import { create } from 'zustand'
import type {
  CanvasNode,
  CanvasSettings,
  CanvasState,
  PermissionMode,
  SessionEvent,
  Turn,
  Usage,
  Worktree
} from '../../shared/types'
import { defaultSettings, emptyUsage } from '../../shared/types'
import { childCount, descendantIds } from './util'

export interface PendingPermission {
  requestId: string
  toolName: string
  input: unknown
}

export type ToastKind = 'info' | 'warn' | 'success'
export interface Toast {
  id: string
  kind: ToastKind
  message: string
  actionLabel?: string
  onAction?: () => void
  duration?: number
}

interface Store {
  canvas: CanvasState | null
  openNodeId: string | null
  permissions: Record<string, PendingPermission | undefined>
  toasts: Toast[]
  pushToast(t: Omit<Toast, 'id'>): void
  dismissToast(id: string): void

  setCanvas(c: CanvasState | null): void
  createEmptyCanvas(): void
  initCanvas(dir: string): string
  addRoot(dir: string, resumeSessionId?: string | null): CanvasNode | null
  openNode(id: string | null): void
  updateSettings(patch: Partial<CanvasSettings>): void
  setNodePermission(nodeId: string, mode: PermissionMode | null): void

  addBranch(
    parentId: string,
    parentTurnIndex: number,
    selection: string
  ): CanvasNode | null
  appendUserTurn(nodeId: string, text: string): void
  setNodeTurns(nodeId: string, turns: Turn[]): void
  setNodeModel(nodeId: string, model: string | null): void
  setNodeWorktree(nodeId: string, wt: Worktree): void
  setNodeTitle(nodeId: string, title: string, auto?: boolean): void
  toggleCollapse(nodeId: string): void
  clearNodeSession(nodeId: string): void
  moveNode(nodeId: string, x: number, y: number): void
  setNodePositions(positions: Record<string, { x: number; y: number }>): void
  deleteNode(nodeId: string): string[]
  restoreNodes(nodes: CanvasNode[]): void
  addTag(nodeId: string, tag: string): void
  removeTag(nodeId: string, tag: string): void
  clearPermission(nodeId: string): void
  markUnread(nodeId: string): void
  makeRoot(nodeId: string): void

  applyEvent(e: SessionEvent): void
}

function uuid(): string {
  return crypto.randomUUID()
}

function replaceNode(
  canvas: CanvasState,
  id: string,
  updater: (n: CanvasNode) => CanvasNode
): CanvasState {
  const nodes = canvas.nodes.map((n) => (n.id === id ? updater(structuredClone(n)) : n))
  return { ...canvas, nodes }
}

function ensureAssistantTurn(node: CanvasNode, turnId: string): Turn {
  let turn = node.turns.find((t) => t.id === turnId && t.role === 'assistant')
  if (!turn) {
    turn = { id: turnId, role: 'assistant', blocks: [], createdAt: Date.now() }
    node.turns.push(turn)
  }
  return turn
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
    costUsd: a.costUsd + b.costUsd
  }
}

export const useStore = create<Store>((set, get) => ({
  canvas: null,
  openNodeId: null,
  permissions: {},
  toasts: [],

  pushToast(t) {
    set((s) => ({ toasts: [...s.toasts, { ...t, id: uuid() }] }))
  },

  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },

  setCanvas(c) {
    if (c) {
      const legacy = c.settings as unknown as { bypassPermissions?: boolean }
      c = {
        ...c,
        settings: {
          ...defaultSettings(),
          ...c.settings,
          ...(legacy?.bypassPermissions ? { permissionMode: 'skip' as PermissionMode } : {})
        }
      }
    }
    set({ canvas: c })
  },

  createEmptyCanvas() {
    set({
      canvas: {
        id: uuid(),
        createdAt: Date.now(),
        settings: defaultSettings(),
        nodes: []
      },
      openNodeId: null
    })
  },

  initCanvas(dir) {
    const rootId = uuid()
    const root: CanvasNode = {
      id: rootId,
      parentId: null,
      branchPoint: null,
      seedSelection: null,
      sessionId: null,
      workingDirectory: dir,
      position: { x: 80, y: 120 },
      status: 'idle',
      turns: [],
      usage: emptyUsage(),
      title: 'Root',
      unread: false
    }
    const canvas: CanvasState = {
      id: uuid(),
      createdAt: Date.now(),
      settings: defaultSettings(),
      nodes: [root]
    }
    set({ canvas, openNodeId: rootId })
    return rootId
  },

  addRoot(dir, resumeSessionId = null) {
    const { canvas } = get()
    if (!canvas) return null
    const maxY = canvas.nodes.reduce((m, n) => Math.max(m, n.position.y), 0)
    const node: CanvasNode = {
      id: uuid(),
      parentId: null,
      branchPoint: null,
      seedSelection: null,
      sessionId: resumeSessionId,
      workingDirectory: dir,
      position: { x: 80, y: canvas.nodes.length ? maxY + 300 : 120 },
      status: 'idle',
      turns: [],
      usage: emptyUsage(),
      title: resumeSessionId ? 'Resumed' : 'Root',
      unread: false
    }
    set({ canvas: { ...canvas, nodes: [...canvas.nodes, node] }, openNodeId: node.id })
    return node
  },

  openNode(id) {
    set((s) => {
      if (id && s.canvas) {
        return {
          openNodeId: id,
          canvas: replaceNode(s.canvas, id, (n) => {
            n.unread = false
            return n
          })
        }
      }
      return { openNodeId: id }
    })
  },

  updateSettings(patch) {
    set((s) =>
      s.canvas
        ? { canvas: { ...s.canvas, settings: { ...s.canvas.settings, ...patch } } }
        : s
    )
  },

  setNodePermission(nodeId, mode) {
    set((s) =>
      s.canvas
        ? {
            canvas: replaceNode(s.canvas, nodeId, (n) => {
              n.permissionMode = mode
              return n
            })
          }
        : s
    )
  },

  addBranch(parentId, parentTurnIndex, selection) {
    const { canvas } = get()
    if (!canvas) return null
    const parent = canvas.nodes.find((n) => n.id === parentId)
    if (!parent) return null

    const index = childCount(canvas.nodes, parentId)
    const node: CanvasNode = {
      id: uuid(),
      parentId,
      branchPoint: { parentTurnIndex },
      seedSelection: selection,
      sessionId: null,
      workingDirectory: parent.workingDirectory,
      position: {
        x: parent.position.x + 440,
        y: parent.position.y + index * 280
      },
      status: 'idle',
      turns: [],
      usage: emptyUsage(),
      title: 'Branch',
      unread: false
    }
    set({ canvas: { ...canvas, nodes: [...canvas.nodes, node] } })
    return node
  },

  appendUserTurn(nodeId, text) {
    set((s) => {
      if (!s.canvas) return s
      return {
        canvas: replaceNode(s.canvas, nodeId, (n) => {
          n.turns.push({
            id: uuid(),
            role: 'user',
            blocks: [{ kind: 'text', text }],
            createdAt: Date.now()
          })
          return n
        })
      }
    })
  },

  setNodeTurns(nodeId, turns) {
    set((s) =>
      s.canvas
        ? {
            canvas: replaceNode(s.canvas, nodeId, (n) => {
              n.turns = turns
              return n
            })
          }
        : s
    )
  },

  setNodeModel(nodeId, model) {
    set((s) =>
      s.canvas
        ? {
            canvas: replaceNode(s.canvas, nodeId, (n) => {
              n.model = model
              return n
            })
          }
        : s
    )
  },

  setNodeWorktree(nodeId, wt) {
    set((s) =>
      s.canvas
        ? {
            canvas: replaceNode(s.canvas, nodeId, (n) => {
              n.worktree = wt
              n.workingDirectory = wt.path
              return n
            })
          }
        : s
    )
  },

  setNodeTitle(nodeId, title, auto = false) {
    set((s) =>
      s.canvas
        ? {
            canvas: replaceNode(s.canvas, nodeId, (n) => {
              n.title = title
              n.autoTitled = auto
              return n
            })
          }
        : s
    )
  },

  toggleCollapse(nodeId) {
    set((s) =>
      s.canvas
        ? {
            canvas: replaceNode(s.canvas, nodeId, (n) => {
              n.collapsed = !n.collapsed
              return n
            })
          }
        : s
    )
  },

  clearNodeSession(nodeId) {
    set((s) =>
      s.canvas
        ? {
            canvas: replaceNode(s.canvas, nodeId, (n) => {
              n.turns = []
              n.sessionId = null
              n.status = 'idle'
              return n
            })
          }
        : s
    )
  },

  moveNode(nodeId, x, y) {
    set((s) => {
      if (!s.canvas) return s
      return {
        canvas: replaceNode(s.canvas, nodeId, (n) => {
          n.position = { x, y }
          return n
        })
      }
    })
  },

  setNodePositions(positions) {
    set((s) => {
      if (!s.canvas) return s
      const nodes = s.canvas.nodes.map((n) =>
        positions[n.id] ? { ...n, position: positions[n.id] } : n
      )
      return { canvas: { ...s.canvas, nodes } }
    })
  },

  deleteNode(nodeId) {
    const { canvas } = get()
    if (!canvas) return []
    const removed = new Set<string>([nodeId, ...descendantIds(canvas.nodes, nodeId)])
    const nodes = canvas.nodes.filter((n) => !removed.has(n.id))
    const permissions = { ...get().permissions }
    for (const id of removed) delete permissions[id]
    const openNodeId = removed.has(get().openNodeId ?? '') ? null : get().openNodeId
    set({ canvas: { ...canvas, nodes }, permissions, openNodeId })
    return [...removed]
  },

  restoreNodes(nodes) {
    set((s) => {
      if (!s.canvas) return s
      const have = new Set(s.canvas.nodes.map((n) => n.id))
      const add = nodes.filter((n) => !have.has(n.id))
      if (add.length === 0) return s
      return { canvas: { ...s.canvas, nodes: [...s.canvas.nodes, ...add] } }
    })
  },

  addTag(nodeId, tag) {
    const t = tag.trim()
    if (!t) return
    set((s) =>
      s.canvas
        ? {
            canvas: replaceNode(s.canvas, nodeId, (n) => {
              const tags = n.tags ?? []
              if (!tags.includes(t)) n.tags = [...tags, t]
              return n
            })
          }
        : s
    )
  },

  removeTag(nodeId, tag) {
    set((s) =>
      s.canvas
        ? {
            canvas: replaceNode(s.canvas, nodeId, (n) => {
              n.tags = (n.tags ?? []).filter((x) => x !== tag)
              return n
            })
          }
        : s
    )
  },

  clearPermission(nodeId) {
    set((s) => {
      if (!s.permissions[nodeId]) return s
      const permissions = { ...s.permissions }
      delete permissions[nodeId]
      return { permissions }
    })
  },

  markUnread(nodeId) {
    set((s) =>
      s.canvas
        ? {
            canvas: replaceNode(s.canvas, nodeId, (n) => {
              n.unread = true
              return n
            })
          }
        : s
    )
  },

  makeRoot(nodeId) {
    set((s) =>
      s.canvas
        ? {
            canvas: replaceNode(s.canvas, nodeId, (n) => {
              n.parentId = null
              n.branchPoint = null
              n.seedSelection = null
              n.position = { x: 80, y: n.position.y }
              n.title = 'Root'
              return n
            })
          }
        : s
    )
  },

  applyEvent(e) {
    set((s) => {
      if (!s.canvas) return s
      const canvas = s.canvas
      const has = canvas.nodes.some((n) => n.id === e.nodeId)
      if (!has) return s

      switch (e.type) {
        case 'status': {
          const permissions =
            e.status !== 'awaiting_permission' && s.permissions[e.nodeId]
              ? (() => {
                  const p = { ...s.permissions }
                  delete p[e.nodeId]
                  return p
                })()
              : s.permissions
          return {
            permissions,
            canvas: replaceNode(canvas, e.nodeId, (n) => {
              n.status = e.status
              return n
            })
          }
        }
        case 'session':
          return {
            canvas: replaceNode(canvas, e.nodeId, (n) => {
              n.sessionId = e.sessionId
              return n
            })
          }
        case 'assistant_text':
          return {
            canvas: replaceNode(canvas, e.nodeId, (n) => {
              const turn = ensureAssistantTurn(n, e.turnId)
              const last = turn.blocks[turn.blocks.length - 1]
              if (last && last.kind === 'text') {
                last.text = (last.text ?? '') + e.text
              } else {
                turn.blocks.push({ kind: 'text', text: e.text })
              }
              return n
            })
          }
        case 'tool_use':
          return {
            canvas: replaceNode(canvas, e.nodeId, (n) => {
              const turn = ensureAssistantTurn(n, e.turnId)
              turn.blocks.push({ kind: 'tool_use', toolName: e.toolName, toolInput: e.input })
              return n
            })
          }
        case 'tool_result':
          return {
            canvas: replaceNode(canvas, e.nodeId, (n) => {
              const turn = ensureAssistantTurn(n, e.turnId)
              turn.blocks.push({ kind: 'tool_result', text: e.text, isError: e.isError })
              return n
            })
          }
        case 'turn_done':
          return {
            canvas: replaceNode(canvas, e.nodeId, (n) => {
              n.usage = addUsage(n.usage, e.usage)
              if (e.sessionId) n.sessionId = e.sessionId
              if (e.nodeId !== s.openNodeId) n.unread = true
              const turn = n.turns.find((t) => t.id === e.turnId)
              if (turn) {
                turn.usage = e.usage
                if (e.model) turn.model = e.model
              }
              return n
            })
          }
        case 'permission_request':
          return {
            permissions: {
              ...s.permissions,
              [e.nodeId]: { requestId: e.requestId, toolName: e.toolName, input: e.input }
            }
          }
        case 'slash_commands':
          return {
            canvas: replaceNode(canvas, e.nodeId, (n) => {
              n.slashCommands = e.commands
              return n
            })
          }
        case 'error':
          return {
            canvas: replaceNode(canvas, e.nodeId, (n) => {
              n.turns.push({
                id: uuid(),
                role: 'assistant',
                blocks: [{ kind: 'text', text: '⚠️ ' + e.message }],
                createdAt: Date.now()
              })
              return n
            })
          }
        default:
          return s
      }
    })
  }
}))
