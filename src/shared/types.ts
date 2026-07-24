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
  model?: string | null
  slashCommands?: string[]
  permissionMode?: PermissionMode | null
  worktree?: Worktree | null
}

export interface Worktree {
  path: string
  branch: string
  baseRef: string
  repoRoot: string
}

export type PermissionMode = 'ask' | 'skip'
export type ThemePref = 'light' | 'dark' | 'system'
export type Isolation = 'shared' | 'worktree'

export interface CanvasSettings {
  permissionMode: PermissionMode
  autoRouter: boolean
  defaultModel: string | null
  maxConcurrent: number
  spendCapUsd: number | null
  isolation: Isolation
  theme: ThemePref
  notifyOnComplete: boolean
  confirmDelete: boolean
  switchOnBranch: boolean
  showToolDetail: boolean
  fontScale: number
}

export function defaultSettings(): CanvasSettings {
  return {
    permissionMode: 'ask',
    autoRouter: false,
    defaultModel: null,
    maxConcurrent: 4,
    spendCapUsd: null,
    isolation: 'shared',
    theme: 'light',
    notifyOnComplete: true,
    confirmDelete: true,
    switchOnBranch: true,
    showToolDetail: true,
    fontScale: 1
  }
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
  model?: string
  bypass: boolean
}

export type SessionEvent =
  | { type: 'status'; nodeId: string; status: NodeStatus }
  | { type: 'session'; nodeId: string; sessionId: string }
  | { type: 'assistant_text'; nodeId: string; turnId: string; text: string }
  | { type: 'tool_use'; nodeId: string; turnId: string; toolName: string; input: unknown }
  | { type: 'tool_result'; nodeId: string; turnId: string; text: string; isError: boolean }
  | { type: 'turn_done'; nodeId: string; turnId: string; usage: Usage; sessionId: string | null }
  | { type: 'permission_request'; nodeId: string; requestId: string; toolName: string; input: unknown }
  | { type: 'slash_commands'; nodeId: string; commands: string[] }
  | { type: 'error'; nodeId: string; message: string }

export interface ForkfieldApi {
  chooseDirectory(): Promise<string | null>
  loadCanvas(): Promise<CanvasState | null>
  saveCanvas(state: CanvasState): Promise<void>
  startTurn(params: StartTurnParams): Promise<void>
  interrupt(nodeId: string): void
  respondPermission(requestId: string, allow: boolean): void
  loadHistory(sessionId: string): Promise<Turn[] | null>
  saveFile(canvas: CanvasState, path?: string | null): Promise<string | null>
  openFile(): Promise<{ path: string; canvas: CanvasState } | null>
  onMenu(cb: (action: string) => void): () => void
  onSessionEvent(cb: (event: SessionEvent) => void): () => void
  isGitRepo(dir: string): Promise<boolean>
  createWorktree(baseDir: string, nodeId: string): Promise<Worktree | null>
  removeWorktree(wt: Worktree): Promise<void>
  gitDiff(wt: Worktree): Promise<string>
}
