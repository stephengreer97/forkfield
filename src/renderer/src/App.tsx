import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import { useStore } from './store'
import Canvas from './components/Canvas'
import CliView from './components/CliView'
import { buildBranchPrompt, descendantIds, formatCost, formatTokens } from './util'
import type {
  CanvasNode,
  CanvasSettings,
  Isolation,
  PermissionMode,
  ThemePref
} from '../../shared/types'

function getNode(id: string): CanvasNode | undefined {
  return useStore.getState().canvas?.nodes.find((n) => n.id === id)
}

const MODEL_OPTIONS: { label: string; value: string | null; desc: string }[] = [
  { label: 'Default', value: null, desc: 'Use the default model' },
  { label: 'Opus', value: 'opus', desc: 'Most capable' },
  { label: 'Sonnet', value: 'sonnet', desc: 'Balanced speed and quality' },
  { label: 'Haiku', value: 'haiku', desc: 'Fastest and cheapest' }
]

// Interactive built-in commands that the SDK cannot run for us, so Forkfield
// handles them natively. Everything else passes through to the SDK.
const NATIVE_COMMANDS = new Set(['model', 'clear', 'config', 'login'])

// Auto-router v1: pick a model from a cheap heuristic on the prompt.
function routeModel(text: string): string {
  const t = text.toLowerCase()
  const codey =
    text.includes('```') ||
    /\b(code|refactor|debug|implement|build|fix|bug|error|stack trace|function|class|api|sql|migrat|test|deploy|architecture|design)\b/.test(
      t
    )
  if (text.trim().length < 80 && !codey) return 'haiku'
  if (codey || text.length > 500) return 'opus'
  return 'sonnet'
}

function pickModel(
  text: string,
  node: { model?: string | null },
  settings: CanvasSettings
): string | undefined {
  if (node.model) return node.model
  if (settings.autoRouter) return routeModel(text)
  return settings.defaultModel ?? undefined
}

function effectiveBypass(node: { permissionMode?: 'ask' | 'skip' | null }, settings: CanvasSettings): boolean {
  const mode = node.permissionMode ?? settings.permissionMode
  return mode === 'skip'
}

function concurrentThinking(): number {
  const c = useStore.getState().canvas
  if (!c) return 0
  return c.nodes.filter((n) => n.status === 'thinking' || n.status === 'awaiting_permission').length
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
  const [modelPicker, setModelPicker] = useState<{ nodeId: string } | null>(null)
  const [branchAnim, setBranchAnim] = useState<'collapse' | 'enter' | null>(null)
  const [confirmClear, setConfirmClear] = useState<{ nodeId: string } | null>(null)
  const [configDialog, setConfigDialog] = useState<{ nodeId: string } | null>(null)
  const [loginInfo, setLoginInfo] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [currentFilePath, setCurrentFilePath] = useState<string | null>(() =>
    localStorage.getItem('forkfield:file')
  )
  const filePathRef = useRef<string | null>(null)
  const spendWarnedRef = useRef(false)

  useEffect(() => {
    let mounted = true
    window.forkfield.loadCanvas().then((c) => {
      if (!mounted) return
      if (c) {
        useStore.getState().setCanvas(c)
      } else {
        useStore.getState().createEmptyCanvas()
      }
    })
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      void Notification.requestPermission().catch(() => undefined)
    }
    return window.forkfield.onSessionEvent((e) => {
      useStore.getState().applyEvent(e)
      if (e.type !== 'turn_done') return
      const st = useStore.getState()
      const c = st.canvas
      if (!c) return
      if (c.settings.notifyOnComplete && st.openNodeId !== e.nodeId && 'Notification' in window) {
        const node = c.nodes.find((n) => n.id === e.nodeId)
        if (Notification.permission === 'granted') {
          new Notification('Forkfield', { body: `${node?.title ?? 'A branch'} finished` })
        }
      }
      const cap = c.settings.spendCapUsd
      if (cap && !spendWarnedRef.current) {
        const spent = c.nodes.reduce((a, n) => a + n.usage.costUsd, 0)
        if (spent >= cap) {
          spendWarnedRef.current = true
          setNotice(
            `This canvas has spent ${formatCost(spent)}, past your ${formatCost(
              cap
            )} cap. Raise or clear the cap in Settings.`
          )
        }
      }
    })
  }, [])

  // Apply theme and font scale to the document.
  useEffect(() => {
    const s = canvas?.settings
    const root = document.documentElement
    const theme = s?.theme ?? 'light'
    const resolved =
      theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : theme
    root.setAttribute('data-theme', resolved)
    root.style.setProperty('--font-scale', String(s?.fontScale ?? 1))
  }, [canvas?.settings.theme, canvas?.settings.fontScale])

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
    // Interactive built-ins are handled by Forkfield; the rest go to the SDK.
    const cmd = text.trim().match(/^\/([a-zA-Z][\w-]*)(?:\s+(.+))?$/)
    if (cmd && NATIVE_COMMANDS.has(cmd[1].toLowerCase())) {
      const name = cmd[1].toLowerCase()
      const arg = cmd[2]?.trim()
      useStore.getState().appendUserTurn(nodeId, text)
      if (name === 'model') {
        if (arg) useStore.getState().setNodeModel(nodeId, arg)
        else setModelPicker({ nodeId })
      } else if (name === 'clear') {
        setConfirmClear({ nodeId })
      } else if (name === 'config') {
        setConfigDialog({ nodeId })
      } else if (name === 'login') {
        setLoginInfo(true)
      }
      return
    }
    const settings = useStore.getState().canvas!.settings
    if (concurrentThinking() >= settings.maxConcurrent) {
      setNotice(
        `You have ${settings.maxConcurrent} branches running (the concurrency limit). Wait for one to finish, or raise the limit in Settings.`
      )
      return
    }
    useStore.getState().appendUserTurn(nodeId, text)
    void window.forkfield.startTurn({
      nodeId,
      prompt: text,
      cwd: node.workingDirectory,
      resumeSessionId: node.sessionId,
      fork: false,
      model: pickModel(text, node, settings),
      bypass: effectiveBypass(node, settings)
    })
  }, [])

  const createBranch = useCallback(
    (parentId: string, turnIndex: number, selection: string, question: string) => {
      const parent = getNode(parentId)
      if (!parent) return
      const settings = useStore.getState().canvas!.settings
      if (concurrentThinking() >= settings.maxConcurrent) {
        setNotice(
          `You have ${settings.maxConcurrent} branches running (the concurrency limit). Wait for one to finish, or raise the limit in Settings.`
        )
        return
      }
      const startBranch = (): CanvasNode | null => {
        const node = useStore.getState().addBranch(parentId, turnIndex, selection)
        if (!node) return null
        if (parent.model) useStore.getState().setNodeModel(node.id, parent.model)
        const prompt = buildBranchPrompt(selection, question)
        useStore.getState().appendUserTurn(node.id, prompt)
        void window.forkfield.startTurn({
          nodeId: node.id,
          prompt,
          cwd: parent.workingDirectory,
          resumeSessionId: parent.sessionId,
          fork: true,
          model:
            parent.model ??
            (settings.autoRouter ? routeModel(question) : settings.defaultModel ?? undefined),
          bypass: effectiveBypass(parent, settings)
        })
        return node
      }
      if (!settings.switchOnBranch) {
        // Create it and keep working where you are.
        startBranch()
        return
      }
      // Animated: collapse current, reveal the new node, enter it.
      setBranchAnim('collapse')
      window.setTimeout(() => {
        const node = startBranch()
        if (!node) {
          setBranchAnim(null)
          return
        }
        useStore.getState().openNode(null)
        setBranchAnim(null)
        window.setTimeout(() => {
          useStore.getState().openNode(node.id)
          setBranchAnim('enter')
          window.setTimeout(() => setBranchAnim(null), 260)
        }, 260)
      }, 200)
    },
    []
  )

  const onMenu = useCallback((nodeId: string, x: number, y: number) => {
    setMenu({ nodeId, x, y })
  }, [])

  const requestDelete = useCallback((nodeId: string) => {
    const c = useStore.getState().canvas
    if (!c) return
    if (!c.settings.confirmDelete) {
      const removed = useStore.getState().deleteNode(nodeId)
      for (const id of removed) window.forkfield.interrupt(id)
      return
    }
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
        onNewRoot={() => setNewRootChoice(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <Canvas
        onOpen={(id) => useStore.getState().openNode(id)}
        onMenu={onMenu}
        onRespondPermission={respondPermission}
      />
      {canvas.nodes.length === 0 && <EmptyCanvasHint />}
      {openNode && (
        <CliView
          key={openNode.id}
          node={openNode}
          anim={branchAnim}
          showToolDetail={canvas.settings.showToolDetail}
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
      {modelPicker && (
        <ChoiceDialog
          title="Choose model for this node"
          onCancel={() => setModelPicker(null)}
          options={MODEL_OPTIONS.map((m) => ({
            label: m.label,
            desc: m.desc,
            onClick: () => {
              useStore.getState().setNodeModel(modelPicker.nodeId, m.value)
              setModelPicker(null)
            }
          }))}
        />
      )}
      {confirmClear && (
        <ConfirmDialog
          title="Clear conversation"
          message="This clears this node's transcript and starts a fresh Claude session in the same folder on your next message. This cannot be undone."
          confirmLabel="Clear"
          danger
          onConfirm={() => {
            window.forkfield.interrupt(confirmClear.nodeId)
            useStore.getState().clearNodeSession(confirmClear.nodeId)
            setConfirmClear(null)
          }}
          onCancel={() => setConfirmClear(null)}
        />
      )}
      {configDialog && (
        <ConfigDialog
          node={canvas.nodes.find((n) => n.id === configDialog.nodeId) ?? null}
          onChangeModel={() => {
            const id = configDialog.nodeId
            setConfigDialog(null)
            setModelPicker({ nodeId: id })
          }}
          onChangePermission={(mode) =>
            useStore.getState().setNodePermission(configDialog.nodeId, mode)
          }
          onOpenSettings={() => {
            setConfigDialog(null)
            setSettingsOpen(true)
          }}
          onClose={() => setConfigDialog(null)}
        />
      )}
      {loginInfo && (
        <ConfirmDialog
          title="Sign in"
          message="Forkfield uses your existing Claude Code login. To sign in or switch accounts, run 'claude' (or 'ant auth login') in a terminal, then start a new session here."
          confirmLabel="OK"
          onConfirm={() => setLoginInfo(false)}
          onCancel={() => setLoginInfo(false)}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          settings={canvas.settings}
          onChange={(patch) => useStore.getState().updateSettings(patch)}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {notice && (
        <ConfirmDialog
          title="Heads up"
          message={notice}
          confirmLabel="OK"
          onConfirm={() => setNotice(null)}
          onCancel={() => setNotice(null)}
        />
      )}
    </div>
  )
}

function ConfigDialog(props: {
  node: CanvasNode | null
  onChangeModel: () => void
  onChangePermission: (mode: 'ask' | 'skip' | null) => void
  onOpenSettings: () => void
  onClose: () => void
}): JSX.Element | null {
  if (!props.node) return null
  const node = props.node
  return (
    <div
      className="confirm-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
    >
      <div className="confirm-dialog">
        <h3>Node settings</h3>
        <div className="config-row">
          <span className="config-label">Folder</span>
          <span className="config-value">{node.workingDirectory}</span>
        </div>
        <div className="config-row">
          <span className="config-label">Model</span>
          <span className="config-value">
            {node.model ?? 'default'}
            <button className="btn tiny" style={{ marginLeft: 8 }} onClick={props.onChangeModel}>
              Change
            </button>
          </span>
        </div>
        <div className="config-row">
          <span className="config-label">Permissions</span>
          <select
            className="config-select"
            value={node.permissionMode ?? 'default'}
            onChange={(e) =>
              props.onChangePermission(
                e.target.value === 'default' ? null : (e.target.value as 'ask' | 'skip')
              )
            }
          >
            <option value="default">Use global default</option>
            <option value="ask">Ask each time</option>
            <option value="skip">Skip (dangerous)</option>
          </select>
        </div>
        <div className="confirm-actions">
          <button className="btn" onClick={props.onOpenSettings}>
            All settings…
          </button>
          <button className="btn primary" onClick={props.onClose}>
            Done
          </button>
        </div>
      </div>
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
  onNewRoot: () => void
  onOpenSettings: () => void
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
        <button className="btn" onClick={props.onNewRoot}>
          New root
        </button>
        <button className="btn" title="Settings" onClick={props.onOpenSettings}>
          ⚙
        </button>
      </div>
    </div>
  )
}

function SettingsRow(props: { label: string; hint?: string; children: ReactNode }): JSX.Element {
  return (
    <div className="settings-row">
      <div className="settings-row-label">
        <span>{props.label}</span>
        {props.hint && <span className="settings-hint">{props.hint}</span>}
      </div>
      <div className="settings-row-control">{props.children}</div>
    </div>
  )
}

function SettingsDialog(props: {
  settings: CanvasSettings
  onChange: (patch: Partial<CanvasSettings>) => void
  onClose: () => void
}): JSX.Element {
  const s = props.settings
  const set = props.onChange
  return (
    <div
      className="confirm-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
    >
      <div className="settings-dialog">
        <h3>Settings</h3>
        <div className="settings-body">
          <SettingsRow label="Default permissions">
            <select
              value={s.permissionMode}
              onChange={(e) => set({ permissionMode: e.target.value as PermissionMode })}
            >
              <option value="ask">Ask each time</option>
              <option value="skip">Skip (dangerous)</option>
            </select>
          </SettingsRow>
          <SettingsRow label="Auto-switch model by complexity">
            <input
              type="checkbox"
              checked={s.autoRouter}
              onChange={(e) => set({ autoRouter: e.target.checked })}
            />
          </SettingsRow>
          <SettingsRow
            label="Default model"
            hint={s.autoRouter ? 'Ignored while auto-switch is on' : undefined}
          >
            <select
              value={s.defaultModel ?? 'default'}
              disabled={s.autoRouter}
              onChange={(e) =>
                set({ defaultModel: e.target.value === 'default' ? null : e.target.value })
              }
            >
              <option value="default">Default</option>
              <option value="opus">Opus</option>
              <option value="sonnet">Sonnet</option>
              <option value="haiku">Haiku</option>
            </select>
          </SettingsRow>
          <SettingsRow label="Max concurrent branches">
            <input
              type="number"
              min={1}
              max={20}
              value={s.maxConcurrent}
              onChange={(e) => set({ maxConcurrent: Math.max(1, Number(e.target.value) || 1) })}
            />
          </SettingsRow>
          <SettingsRow label="Spend cap (USD, blank = none)">
            <input
              type="number"
              min={0}
              step={0.5}
              value={s.spendCapUsd ?? ''}
              onChange={(e) =>
                set({
                  spendCapUsd: e.target.value === '' ? null : Math.max(0, Number(e.target.value) || 0)
                })
              }
            />
          </SettingsRow>
          <SettingsRow label="Theme">
            <select value={s.theme} onChange={(e) => set({ theme: e.target.value as ThemePref })}>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
              <option value="system">System</option>
            </select>
          </SettingsRow>
          <SettingsRow label="Font size">
            <select
              value={String(s.fontScale)}
              onChange={(e) => set({ fontScale: Number(e.target.value) })}
            >
              <option value="0.9">Small</option>
              <option value="1">Normal</option>
              <option value="1.15">Large</option>
              <option value="1.3">Larger</option>
            </select>
          </SettingsRow>
          <SettingsRow label="Notify when a background branch finishes">
            <input
              type="checkbox"
              checked={s.notifyOnComplete}
              onChange={(e) => set({ notifyOnComplete: e.target.checked })}
            />
          </SettingsRow>
          <SettingsRow label="Confirm before deleting a node">
            <input
              type="checkbox"
              checked={s.confirmDelete}
              onChange={(e) => set({ confirmDelete: e.target.checked })}
            />
          </SettingsRow>
          <SettingsRow label="Enter the new node when branching">
            <input
              type="checkbox"
              checked={s.switchOnBranch}
              onChange={(e) => set({ switchOnBranch: e.target.checked })}
            />
          </SettingsRow>
          <SettingsRow label="Show tool-call detail">
            <input
              type="checkbox"
              checked={s.showToolDetail}
              onChange={(e) => set({ showToolDetail: e.target.checked })}
            />
          </SettingsRow>
          <SettingsRow label="Branch isolation" hint="Worktree activates once git support lands">
            <select
              value={s.isolation}
              onChange={(e) => set({ isolation: e.target.value as Isolation })}
            >
              <option value="shared">Shared folder</option>
              <option value="worktree">Git worktree per branch</option>
            </select>
          </SettingsRow>
        </div>
        <div className="confirm-actions">
          <button className="btn primary" onClick={props.onClose}>
            Done
          </button>
        </div>
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
