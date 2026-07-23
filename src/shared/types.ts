export type NodeStatus =
  | 'idle'
  | 'thinking'
  | 'awaiting_permission'
  | 'complete'
  | 'error'

export interface Usage {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  costUsd: number
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, costUsd: 0 }
}

export type BlockKind = 'text' | 'tool_use' | 'tool_result'

export interface ContentBlock {
  kind: BlockKind
  text?: string
  toolName?: string
  toolInput?: unknown
  isError?: boolean
}

export interface Turn {
  id: string
  role: 'user' | 'assistant'
  blocks: ContentBlock[]
  usage?: Usage
  createdAt: number
}

export interface CanvasNode {
  id: string
  parentId: string | null
  branchPoint: { parentTurnIndex: number } | null
  seedSelection: string | null
  sessionId: string | null
  workingDirectory: string
  position: { x: number; y: number }
  status: NodeStatus
  turns: Turn[]
  usage: Usage
  title: string
  unread: boolean
}

export interface CanvasSettings {
  bypassPermissions: boolean
}

export interface CanvasState {
  id: string
  createdAt: number
  settings: CanvasSettings
  nodes: CanvasNode[]
}

export interface StartTurnParams {
  nodeId: string
  prompt: string
  cwd: string
  resumeSessionId: string | null
  fork: boolean
}

export type SessionEvent =
  | { type: 'status'; nodeId: string; status: NodeStatus }
  | { type: 'session'; nodeId: string; sessionId: string }
  | { type: 'assistant_text'; nodeId: string; turnId: string; text: string }
  | { type: 'tool_use'; nodeId: string; turnId: string; toolName: string; input: unknown }
  | { type: 'tool_result'; nodeId: string; turnId: string; text: string; isError: boolean }
  | { type: 'turn_done'; nodeId: string; turnId: string; usage: Usage; sessionId: string | null }
  | { type: 'permission_request'; nodeId: string; requestId: string; toolName: string; input: unknown }
  | { type: 'error'; nodeId: string; message: string }

export interface ForkfieldApi {
  chooseDirectory(): Promise<string | null>
  loadCanvas(): Promise<CanvasState | null>
  saveCanvas(state: CanvasState): Promise<void>
  startTurn(params: StartTurnParams): Promise<void>
  interrupt(nodeId: string): void
  respondPermission(requestId: string, allow: boolean): void
  setBypass(on: boolean): void
  loadHistory(sessionId: string): Promise<Turn[] | null>
  onSessionEvent(cb: (event: SessionEvent) => void): () => void
}
