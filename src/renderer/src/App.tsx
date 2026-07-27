import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import { useStore } from './store'
import Canvas from './components/Canvas'
import CliView from './components/CliView'
import Toaster from './components/Toaster'
import Icon from './components/Icon'
import CommandPalette, { type PaletteItem } from './components/CommandPalette'
import {
  autoTitle,
  buildBranchPrompt,
  cleanResumeId,
  descendantIds,
  formatCost,
  formatTokens,
  lastAssistantText,
  lineage,
  nodeMatches,
  tidyLayout,
  usageBreakdown
} from './util'
import {
  KEY_COMMANDS,
  comboFor,
  eventCombo,
  formatCombo,
  hasModifier,
  type KeyCommand
} from './keybindings'
import type {
  CanvasNode,
  CanvasSettings,
  Isolation,
  PermissionMode,
  ThemePref,
  Usage
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

// Interactive-only Claude Code commands. They need the terminal TUI (a pairing
// flow, a picker, an editor mode) and do nothing useful through the headless
// SDK, so Forkfield explains that instead of silently sending them.
const TERMINAL_ONLY = new Set([
  'remote-control',
  'vim',
  'terminal-setup',
  'doctor',
  'bug',
  'ide',
  'install-github-app',
  'upgrade',
  'logout',
  'mcp',
  'agents',
  'hooks',
  'statusline',
  'output-style'
])

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

// Resolve once a node has produced its first assistant token (so its prefill,
// which writes the shared context to the prompt cache, is done), or when it
// finishes/errors, or after a timeout so we never hang.
function waitForFirstToken(nodeId: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const check = (): void => {
      const node = useStore.getState().canvas?.nodes.find((n) => n.id === nodeId)
      const hasToken = !!node?.turns.some(
        (t) => t.role === 'assistant' && t.blocks.some((b) => b.kind === 'text' && !!b.text)
      )
      const settled = node?.status === 'complete' || node?.status === 'error'
      if (hasToken || settled || Date.now() - t0 > timeoutMs) {
        // Small buffer so the cache entry is committed before followers read it.
        setTimeout(resolve, 400)
        return
      }
      setTimeout(check, 150)
    }
    check()
  })
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
  const [terminalCmd, setTerminalCmd] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [diffView, setDiffView] = useState<{ title: string; text: string } | null>(null)
  const [collect, setCollect] = useState<{ nodeId: string } | null>(null)
  const [search, setSearch] = useState('')
  const [matchIndex, setMatchIndex] = useState(0)
  const [searchFocus, setSearchFocus] = useState<{ id: string; nonce: number } | null>(null)
  const [fitNonce, setFitNonce] = useState(0)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [tagPrompt, setTagPrompt] = useState<{ nodeId: string } | null>(null)
  const [confirmPromote, setConfirmPromote] = useState<{ nodeId: string } | null>(null)
  const [compareOpen, setCompareOpen] = useState(false)
  const [broadcastOpen, setBroadcastOpen] = useState(false)
  const [nodeInfo, setNodeInfo] = useState<{ nodeId: string } | null>(null)
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
      const openHere = st.openNodeId === e.nodeId && document.hasFocus()
      if (
        c.settings.notifyOnComplete &&
        !openHere &&
        'Notification' in window &&
        Notification.permission === 'granted'
      ) {
        const node = c.nodes.find((n) => n.id === e.nodeId)
        const cost = node ? formatCost(node.usage.costUsd) : ''
        const n = new Notification('Forkfield', {
          body: `${node?.title ?? 'A fork'} finished${cost ? ` · ${cost}` : ''}`,
          tag: e.nodeId
        })
        n.onclick = () => {
          window.focus()
          useStore.getState().openNode(e.nodeId)
        }
      }
      const cap = c.settings.spendCapUsd
      if (cap && !spendWarnedRef.current) {
        const spent = c.nodes.reduce((a, n) => a + n.usage.costUsd, 0)
        if (spent >= cap) {
          spendWarnedRef.current = true
          // Hard stop: interrupt everything still running so cost can't climb.
          for (const node of c.nodes) {
            if (node.status === 'thinking' || node.status === 'awaiting_permission') {
              window.forkfield.interrupt(node.id)
            }
          }
          useStore.getState().pushToast({
            kind: 'warn',
            message: `Spent ${formatCost(spent)}, past your ${formatCost(
              cap
            )} cap. Running forks were stopped.`,
            actionLabel: 'Settings',
            onAction: () => setSettingsOpen(true)
          })
        }
      }
    })
  }, [])

  // Global, rebindable keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const combo = eventCombo(e)
      if (!combo) return
      const el = document.activeElement as HTMLElement | null
      const editable =
        !!el &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      // Never steal plain keystrokes while the user is typing.
      if (editable && !hasModifier(combo)) return
      const kb = useStore.getState().canvas?.settings.keybindings ?? {}
      const match = KEY_COMMANDS.find((c) => comboFor(c.id, kb) === combo)
      if (!match) return
      e.preventDefault()
      if (match.id === 'commandPalette') setPaletteOpen((v) => !v)
      else if (match.id === 'newRoot') setNewRootChoice(true)
      else if (match.id === 'openSettings') setSettingsOpen(true)
      else if (match.id === 'focusSearch') {
        const input = document.querySelector('.topbar-search') as HTMLInputElement | null
        input?.focus()
        input?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Automation bridge (debug builds only): lets the demo driver script the app
  // over CDP without touching internals from the outside.
  useEffect(() => {
    const w = window as unknown as { __ffdebug?: boolean; __ff?: unknown }
    if (!w.__ffdebug) return
    w.__ff = {
      store: useStore,
      tidyLayout,
      openNode: (id: string | null) => useStore.getState().openNode(id),
      setTheme: (t: ThemePref) => useStore.getState().updateSettings({ theme: t })
    }
  }, [])

  // Re-arm the spend-cap hard stop whenever the cap changes.
  useEffect(() => {
    spendWarnedRef.current = false
  }, [canvas?.settings.spendCapUsd])

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
    if (cmd && TERMINAL_ONLY.has(cmd[1].toLowerCase())) {
      useStore.getState().appendUserTurn(nodeId, text)
      setTerminalCmd(cmd[1].toLowerCase())
      return
    }
    if (overSpendCap()) return
    const settings = useStore.getState().canvas!.settings
    if (concurrentThinking() >= settings.maxConcurrent) {
      useStore.getState().pushToast({
        kind: 'warn',
        message: `${settings.maxConcurrent} forks already running. Wait, or raise the limit.`,
        actionLabel: 'Settings',
        onAction: () => setSettingsOpen(true)
      })
      return
    }
    // Name the node from its first real prompt.
    if (node.turns.length === 0) {
      useStore.getState().setNodeTitle(nodeId, autoTitle(text), true)
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

  // Create one branch node, name it, give it a worktree if isolation is on,
  // and kick off its first turn. Shared by single-branch and fan-out flows.
  const spawnBranch = useCallback(
    async (
      parentId: string,
      turnIndex: number,
      selection: string,
      question: string,
      promptOverride?: string
    ): Promise<CanvasNode | null> => {
      const parent = getNode(parentId)
      if (!parent) return null
      const settings = useStore.getState().canvas!.settings
      const node = useStore.getState().addBranch(parentId, turnIndex, selection)
      if (!node) return null
      useStore.getState().setNodeTitle(node.id, autoTitle(question), true)
      if (parent.model) useStore.getState().setNodeModel(node.id, parent.model)

      // In worktree mode, give the branch its own isolated checkout so it
      // can't collide with sibling branches. Falls back to the shared folder
      // when the parent dir is not a git repo.
      let cwd = parent.workingDirectory
      if (settings.isolation === 'worktree') {
        const wt = await window.forkfield.createWorktree(parent.workingDirectory, node.id)
        if (wt) {
          useStore.getState().setNodeWorktree(node.id, wt)
          cwd = wt.path
        } else {
          useStore.getState().pushToast({
            kind: 'info',
            message: 'Not a git repo, so this fork shares the parent folder.'
          })
        }
      }

      const prompt = promptOverride ?? buildBranchPrompt(selection, question)
      useStore.getState().appendUserTurn(node.id, prompt)
      void window.forkfield.startTurn({
        nodeId: node.id,
        prompt,
        cwd,
        resumeSessionId: parent.sessionId,
        fork: true,
        model:
          parent.model ??
          (settings.autoRouter ? routeModel(question) : settings.defaultModel ?? undefined),
        bypass: effectiveBypass(parent, settings)
      })
      return node
    },
    []
  )

  const overSpendCap = useCallback((): boolean => {
    const c = useStore.getState().canvas
    if (!c?.settings.spendCapUsd) return false
    const spent = c.nodes.reduce((a, n) => a + n.usage.costUsd, 0)
    if (spent >= c.settings.spendCapUsd) {
      useStore.getState().pushToast({
        kind: 'warn',
        message: `Spend cap of ${formatCost(c.settings.spendCapUsd)} reached. Raise it to continue.`,
        actionLabel: 'Settings',
        onAction: () => setSettingsOpen(true)
      })
      return true
    }
    return false
  }, [])

  const overCap = useCallback(
    (extra: number): boolean => {
      if (overSpendCap()) return true
      const settings = useStore.getState().canvas!.settings
      if (concurrentThinking() + extra > settings.maxConcurrent) {
        useStore.getState().pushToast({
          kind: 'warn',
          message: `That exceeds your limit of ${settings.maxConcurrent} concurrent forks.`,
          actionLabel: 'Settings',
          onAction: () => setSettingsOpen(true)
        })
        return true
      }
      return false
    },
    [overSpendCap]
  )

  const createBranch = useCallback(
    (parentId: string, turnIndex: number, selection: string, question: string) => {
      if (overCap(1)) return
      const switchOnBranch = useStore.getState().canvas!.settings.switchOnBranch
      if (!switchOnBranch) {
        // Create it and keep working where you are.
        void spawnBranch(parentId, turnIndex, selection, question)
        return
      }
      // Animated: collapse current, reveal the new node, enter it.
      setBranchAnim('collapse')
      window.setTimeout(() => {
        void spawnBranch(parentId, turnIndex, selection, question).then((node) => {
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
        })
      }, 200)
    },
    [overCap, spawnBranch]
  )

  const createFanOut = useCallback(
    (parentId: string, turnIndex: number, selection: string, questions: string[]) => {
      const qs = questions.map((q) => q.trim()).filter(Boolean)
      if (qs.length === 0) return
      if (overCap(qs.length)) return
      // Cache-aware fan-out: launch the first fork alone so it writes the shared
      // parent context into the server-side prompt cache, wait until it starts
      // responding (prefill done = cache written), then release the rest. They
      // read that cache instead of each re-writing the same big context.
      void (async () => {
        const first = await spawnBranch(parentId, turnIndex, selection, qs[0])
        if (!first || qs.length === 1) return
        await waitForFirstToken(first.id, 25000)
        for (let i = 1; i < qs.length; i++) {
          void spawnBranch(parentId, turnIndex, selection, qs[i])
        }
      })()
    },
    [overCap, spawnBranch]
  )

  const onMenu = useCallback((nodeId: string, x: number, y: number) => {
    setMenu({ nodeId, x, y })
  }, [])

  const doDelete = useCallback((nodeId: string) => {
    const before = useStore.getState().canvas?.nodes ?? []
    const title = before.find((n) => n.id === nodeId)?.title ?? 'node'
    const removed = useStore.getState().deleteNode(nodeId)
    const removedSet = new Set(removed)
    const snapshot = before.filter((n) => removedSet.has(n.id))
    const worktrees = snapshot.map((n) => n.worktree).filter((w): w is NonNullable<typeof w> => !!w)
    for (const id of removed) window.forkfield.interrupt(id)

    // Defer worktree teardown so Undo can bring the nodes back intact.
    const timer = window.setTimeout(() => {
      for (const wt of worktrees) void window.forkfield.removeWorktree(wt)
    }, 6500)

    const extra = snapshot.length - 1
    useStore.getState().pushToast({
      kind: 'info',
      message: `Deleted ${title}${extra > 0 ? ` and ${extra} fork${extra === 1 ? '' : 's'}` : ''}`,
      actionLabel: 'Undo',
      onAction: () => {
        window.clearTimeout(timer)
        useStore.getState().restoreNodes(snapshot)
      }
    })
  }, [])

  const requestDelete = useCallback(
    (nodeId: string) => {
      const c = useStore.getState().canvas
      if (!c) return
      if (!c.settings.confirmDelete) {
        doDelete(nodeId)
        return
      }
      const count = descendantIds(c.nodes, nodeId).length
      setConfirmDelete({ nodeId, count })
    },
    [doDelete]
  )

  const performDelete = useCallback(
    (nodeId: string) => {
      doDelete(nodeId)
      setConfirmDelete(null)
    },
    [doDelete]
  )

  const respondPermission = useCallback((nodeId: string, requestId: string, allow: boolean) => {
    window.forkfield.respondPermission(requestId, allow)
    useStore.getState().clearPermission(nodeId)
  }, [])

  const interrupt = useCallback((nodeId: string) => {
    window.forkfield.interrupt(nodeId)
  }, [])

  const showDiff = useCallback((nodeId: string) => {
    const node = useStore.getState().canvas?.nodes.find((n) => n.id === nodeId)
    if (!node?.worktree) return
    setDiffView({ title: node.title, text: 'Loading diff…' })
    void window.forkfield.gitDiff(node.worktree).then((text) => {
      setDiffView({ title: node.title, text: text.trim() || 'No changes yet.' })
    })
  }, [])

  const openInEditor = useCallback((nodeId: string) => {
    const node = useStore.getState().canvas?.nodes.find((n) => n.id === nodeId)
    if (!node?.worktree) return
    const cmd = useStore.getState().canvas!.settings.editorCommand || 'code'
    void window.forkfield.openInEditor(cmd, node.worktree.path).then((r) => {
      useStore.getState().pushToast({ kind: r.ok ? 'success' : 'warn', message: r.message })
    })
  }, [])

  const promoteBranch = useCallback((nodeId: string) => {
    setConfirmPromote({ nodeId })
  }, [])

  const doPromote = useCallback((nodeId: string) => {
    setConfirmPromote(null)
    const node = useStore.getState().canvas?.nodes.find((n) => n.id === nodeId)
    if (!node?.worktree) return
    void window.forkfield.promoteWorktree(node.worktree).then((r) => {
      useStore.getState().pushToast({ kind: r.ok ? 'success' : 'warn', message: r.message })
    })
  }, [])

  const openCollect = useCallback((nodeId: string) => {
    setCollect({ nodeId })
  }, [])

  const doTidy = useCallback(() => {
    const c = useStore.getState().canvas
    if (!c) return
    useStore.getState().setNodePositions(tidyLayout(c.nodes))
    setFitNonce((n) => n + 1)
  }, [])

  const mergeFindings = useCallback(
    (parentId: string) => {
      const c = useStore.getState().canvas
      if (!c) return
      const parent = c.nodes.find((n) => n.id === parentId)
      if (!parent) return
      const children = c.nodes.filter((n) => n.parentId === parentId)
      const sections = children
        .map((ch, i) => `## Fork ${i + 1}: ${ch.title}\n\n${lastAssistantText(ch)}`)
        .join('\n\n')
      const prompt =
        'I explored several forks from this point, each answering the same question a ' +
        'different way. Here is the final result from each fork:\n\n' +
        sections +
        '\n\nSynthesize these into a single answer: note where they agree, call out where ' +
        'they disagree and which is stronger, and give a clear recommendation.'
      setCollect(null)
      if (overCap(1)) return
      const turnIndex = Math.max(0, parent.turns.length - 1)
      void spawnBranch(parentId, turnIndex, '', 'Merged findings', prompt).then((node) => {
        if (node) useStore.getState().openNode(node.id)
      })
    },
    [overCap, spawnBranch]
  )


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
  const addNewSession = useCallback(async (rawResume?: string) => {
    const resumeSessionId = rawResume ? cleanResumeId(rawResume) : undefined
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

  const totalUsage = canvas.nodes.reduce(
    (acc, n) => ({
      input: acc.input + n.usage.input,
      output: acc.output + n.usage.output,
      cacheWrite: acc.cacheWrite + n.usage.cacheWrite,
      cacheRead: acc.cacheRead + n.usage.cacheRead,
      costUsd: acc.costUsd + n.usage.costUsd
    }),
    { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, costUsd: 0 }
  )
  const total = {
    tokens: totalUsage.input + totalUsage.output + totalUsage.cacheRead + totalUsage.cacheWrite,
    cost: totalUsage.costUsd
  }

  const openNode = openNodeId ? canvas.nodes.find((n) => n.id === openNodeId) ?? null : null

  const q = search.trim().toLowerCase()
  const matches = q ? canvas.nodes.filter((n) => nodeMatches(n, q)) : []
  const matchPos = matches.length ? Math.min(matchIndex, matches.length - 1) : 0
  const jumpTo = (i: number): void => {
    if (matches.length === 0) return
    const idx = ((i % matches.length) + matches.length) % matches.length
    setMatchIndex(idx)
    setSearchFocus({ id: matches[idx].id, nonce: Date.now() })
  }

  const leafNodes = canvas.nodes.filter(
    (n) => !canvas.nodes.some((c) => c.parentId === n.id)
  )

  const paletteItems: PaletteItem[] = [
    { id: 'cmd-newroot', label: 'New root session', icon: 'plus', run: () => setNewRootChoice(true) },
    { id: 'cmd-tidy', label: 'Tidy layout', icon: 'tidy', run: doTidy },
    {
      id: 'cmd-broadcast',
      label: 'Broadcast prompt to leaves',
      icon: 'send',
      run: () => setBroadcastOpen(true)
    },
    {
      id: 'cmd-compare',
      label: 'Compare two nodes',
      icon: 'diff',
      run: () => setCompareOpen(true)
    },
    { id: 'cmd-settings', label: 'Open settings', icon: 'settings', run: () => setSettingsOpen(true) },
    {
      id: 'cmd-theme',
      label: 'Toggle light / dark theme',
      icon: 'command',
      run: () =>
        useStore
          .getState()
          .updateSettings({ theme: canvas.settings.theme === 'dark' ? 'light' : 'dark' })
    },
    ...canvas.nodes.map((n) => ({
      id: 'go-' + n.id,
      label: n.title,
      hint: 'Open node',
      icon: 'branch' as const,
      run: () => useStore.getState().openNode(n.id)
    }))
  ]

  return (
    <div className="app">
      <TopBar
        totalTokens={total.tokens}
        totalCost={total.cost}
        totalUsage={totalUsage}
        search={search}
        onSearch={(v) => {
          setSearch(v)
          setMatchIndex(0)
        }}
        matchCount={matches.length}
        matchPos={matchPos}
        onJumpNext={() => jumpTo(matchPos + 1)}
        onJumpPrev={() => jumpTo(matchPos - 1)}
        onOpenPalette={() => setPaletteOpen(true)}
        onTidy={doTidy}
        onNewRoot={() => setNewRootChoice(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <Canvas
        onOpen={(id) => useStore.getState().openNode(id)}
        onMenu={onMenu}
        onRespondPermission={respondPermission}
        search={search}
        focus={searchFocus}
        fitNonce={fitNonce}
      />
      {canvas.nodes.length === 0 && (
        <EmptyCanvasHint onNewRoot={() => setNewRootChoice(true)} />
      )}
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
          onFanOut={createFanOut}
          onInterrupt={interrupt}
          onRespondPermission={respondPermission}
          onShowDiff={showDiff}
          onOpenEditor={openInEditor}
          onPromote={promoteBranch}
          lineage={lineage(canvas.nodes, openNode.id)}
          onNavigate={(id) => useStore.getState().openNode(id)}
        />
      )}
      {menu && (
        <NodeMenu
          x={menu.x}
          y={menu.y}
          isRoot={!canvas.nodes.find((n) => n.id === menu.nodeId)?.parentId}
          childCount={descendantIds(canvas.nodes, menu.nodeId).length}
          directChildCount={canvas.nodes.filter((n) => n.parentId === menu.nodeId).length}
          collapsed={!!canvas.nodes.find((n) => n.id === menu.nodeId)?.collapsed}
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
          onToggleCollapse={() => {
            useStore.getState().toggleCollapse(menu.nodeId)
            setMenu(null)
          }}
          onCollectFindings={() => {
            const id = menu.nodeId
            setMenu(null)
            openCollect(id)
          }}
          onAddTag={() => {
            const id = menu.nodeId
            setMenu(null)
            setTagPrompt({ nodeId: id })
          }}
          onInfo={() => {
            const id = menu.nodeId
            setMenu(null)
            setNodeInfo({ nodeId: id })
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
              ? `This deletes the node and its ${confirmDelete.count} descendant fork${
                  confirmDelete.count === 1 ? '' : 's'
                }. This cannot be undone.`
              : 'This deletes the node. This cannot be undone.'
          }
          confirmLabel="Delete"
          danger
          onConfirm={() => performDelete(confirmDelete.nodeId)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
      {confirmPromote && (
        <ConfirmDialog
          title="Promote fork"
          message="This merges this fork's commits into the branch checked out in the main repo folder. Make sure that folder has no uncommitted work you might lose."
          confirmLabel="Merge"
          onConfirm={() => doPromote(confirmPromote.nodeId)}
          onCancel={() => setConfirmPromote(null)}
        />
      )}
      {tagPrompt && (
        <PromptDialog
          title="Add a tag"
          label="Tag"
          placeholder="e.g. experiment, keep, wip"
          confirmLabel="Add tag"
          onCancel={() => setTagPrompt(null)}
          onSubmit={(t) => {
            useStore.getState().addTag(tagPrompt.nodeId, t)
            setTagPrompt(null)
          }}
        />
      )}
      {nodeInfo && canvas && (
        (() => {
          const n = canvas.nodes.find((x) => x.id === nodeInfo.nodeId)
          return n ? (
            <NodeInfoDialog
              node={n}
              onRename={(newTitle) => {
                useStore.getState().setNodeTitle(nodeInfo.nodeId, newTitle)
                setNodeInfo(null)
              }}
              onCancel={() => setNodeInfo(null)}
            />
          ) : null
        })()
      )}
      {compareOpen && (
        <CompareDialog nodes={canvas.nodes} onClose={() => setCompareOpen(false)} />
      )}
      {broadcastOpen && (
        <PromptDialog
          title="Broadcast to leaves"
          label={`Send to ${leafNodes.length} leaf node${leafNodes.length === 1 ? '' : 's'}`}
          placeholder="Type a prompt to send to every leaf…"
          confirmLabel="Broadcast"
          onCancel={() => setBroadcastOpen(false)}
          onSubmit={(text) => {
            setBroadcastOpen(false)
            if (!text.trim()) return
            if (overCap(leafNodes.length)) return
            for (const n of leafNodes) sendMessage(n.id, text.trim())
          }}
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
          placeholder="session id (or paste the full claude --resume … command)"
          confirmLabel="Choose folder…"
          onCancel={() => setResumePrompt(false)}
          onSubmit={(id) => {
            setResumePrompt(false)
            void addNewSession(id)
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
      {diffView && <DiffDialog view={diffView} onClose={() => setDiffView(null)} />}
      {collect && (
        <CollectDialog
          parent={canvas.nodes.find((n) => n.id === collect.nodeId) ?? null}
          branches={canvas.nodes.filter((n) => n.parentId === collect.nodeId)}
          onMerge={() => mergeFindings(collect.nodeId)}
          onClose={() => setCollect(null)}
        />
      )}
      {paletteOpen && (
        <CommandPalette items={paletteItems} onClose={() => setPaletteOpen(false)} />
      )}
      <Toaster />
    </div>
  )
}

function CollectDialog(props: {
  parent: CanvasNode | null
  branches: CanvasNode[]
  onMerge: () => void
  onClose: () => void
}): JSX.Element {
  return (
    <div
      className="confirm-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
    >
      <div className="diff-dialog">
        <div className="diff-header">
          <h3>Findings · {props.parent?.title ?? 'node'}</h3>
          <button className="btn tiny ghost icon-btn" onClick={props.onClose}>
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="collect-body">
          {props.branches.map((ch, i) => (
            <div key={ch.id} className="collect-item">
              <div className="collect-item-title">
                Fork {i + 1}: {ch.title}
                <span className={`cli-status status-${ch.status}`}>{ch.status}</span>
              </div>
              <div className="collect-item-text">{lastAssistantText(ch)}</div>
            </div>
          ))}
        </div>
        <div className="confirm-actions">
          <button className="btn" onClick={props.onClose}>
            Close
          </button>
          <button className="btn primary" onClick={props.onMerge}>
            Merge into new fork
          </button>
        </div>
      </div>
    </div>
  )
}

function DiffDialog(props: {
  view: { title: string; text: string }
  onClose: () => void
}): JSX.Element {
  return (
    <div
      className="confirm-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
    >
      <div className="diff-dialog">
        <div className="diff-header">
          <h3>Changes · {props.view.title}</h3>
          <button className="btn tiny ghost icon-btn" onClick={props.onClose}>
            <Icon name="close" size={14} />
          </button>
        </div>
        <pre className="diff-body">{props.view.text}</pre>
      </div>
    </div>
  )
}

function ComparePane(props: { node: CanvasNode | null }): JSX.Element {
  const n = props.node
  return (
    <div className="compare-pane">
      {!n ? (
        <div className="compare-empty">Pick a node</div>
      ) : n.turns.length === 0 ? (
        <div className="compare-empty">No messages yet</div>
      ) : (
        n.turns.map((t) => (
          <div key={t.id} className={`compare-turn turn-${t.role}`}>
            <div className="compare-role">{t.role === 'user' ? 'you' : 'claude'}</div>
            <div className="compare-text">
              {t.blocks
                .filter((b) => b.kind === 'text' && b.text)
                .map((b) => b.text)
                .join('\n') || <span className="compare-empty">(tool activity)</span>}
            </div>
          </div>
        ))
      )}
    </div>
  )
}

function CompareDialog(props: { nodes: CanvasNode[]; onClose: () => void }): JSX.Element {
  const n = props.nodes
  const [a, setA] = useState(n.length >= 2 ? n[n.length - 2].id : n[0]?.id ?? '')
  const [b, setB] = useState(n[n.length - 1]?.id ?? '')
  const nodeA = n.find((x) => x.id === a) ?? null
  const nodeB = n.find((x) => x.id === b) ?? null
  const options = n.map((x) => (
    <option key={x.id} value={x.id}>
      {x.title}
    </option>
  ))
  return (
    <div
      className="confirm-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
    >
      <div className="compare-dialog">
        <div className="diff-header">
          <h3>Compare nodes</h3>
          <button className="btn tiny ghost icon-btn" onClick={props.onClose}>
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="compare-cols">
          <div className="compare-col">
            <select className="config-select" value={a} onChange={(e) => setA(e.target.value)}>
              {options}
            </select>
            <ComparePane node={nodeA} />
          </div>
          <div className="compare-col">
            <select className="config-select" value={b} onChange={(e) => setB(e.target.value)}>
              {options}
            </select>
            <ComparePane node={nodeB} />
          </div>
        </div>
      </div>
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

function NodeInfoDialog(props: {
  node: CanvasNode
  onRename: (newTitle: string) => void
  onCancel: () => void
}): JSX.Element {
  const [isRenaming, setIsRenaming] = useState(false)
  const [newTitle, setNewTitle] = useState(props.node.title)
  const copy = (text: string) => navigator.clipboard.writeText(text)

  return (
    <div
      className="confirm-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onCancel()
      }}
    >
      <div className="confirm-dialog">
        <h3>Node info</h3>
        {isRenaming ? (
          <>
            <label className="prompt-label">Rename node</label>
            <input
              autoFocus
              className="prompt-input"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newTitle.trim()) {
                  props.onRename(newTitle)
                  setIsRenaming(false)
                }
                if (e.key === 'Escape') setIsRenaming(false)
              }}
            />
          </>
        ) : (
          <>
            <div className="info-row">
              <span className="info-label">Session ID:</span>
              <div className="info-value">
                <span className="info-text">{props.node.sessionId || '(not yet created)'}</span>
                {props.node.sessionId && (
                  <button className="info-copy" title="Copy" onClick={() => copy(props.node.sessionId!)}>
                    <Icon name="copy" size={14} />
                  </button>
                )}
              </div>
            </div>
            <div className="info-row">
              <span className="info-label">Folder:</span>
              <div className="info-value">
                <span className="info-text">{props.node.workingDirectory}</span>
                <button className="info-copy" title="Copy" onClick={() => copy(props.node.workingDirectory)}>
                  <Icon name="copy" size={14} />
                </button>
              </div>
            </div>
          </>
        )}
        <div className="confirm-actions">
          <button className="btn" onClick={props.onCancel}>
            {isRenaming ? 'Cancel' : 'Close'}
          </button>
          {!isRenaming && (
            <button className="btn primary" onClick={() => setIsRenaming(true)}>
              Rename…
            </button>
          )}
          {isRenaming && (
            <button
              className="btn primary"
              disabled={!newTitle.trim()}
              onClick={() => {
                if (newTitle.trim()) {
                  props.onRename(newTitle)
                  setIsRenaming(false)
                }
              }}
            >
              Rename
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function NodeMenu(props: {
  x: number
  y: number
  isRoot: boolean
  childCount: number
  directChildCount: number
  collapsed: boolean
  onOpen: () => void
  onMarkUnread: () => void
  onMakeRoot: () => void
  onToggleCollapse: () => void
  onCollectFindings: () => void
  onAddTag: () => void
  onInfo: () => void
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
        <button
          className="menu-item"
          onClick={props.onToggleCollapse}
          disabled={props.childCount === 0}
        >
          {props.collapsed ? 'Expand subtree' : 'Collapse subtree'}
        </button>
        <button
          className="menu-item"
          onClick={props.onCollectFindings}
          disabled={props.directChildCount < 2}
        >
          Collect findings…
        </button>
        <button className="menu-item" onClick={props.onAddTag}>
          Add tag…
        </button>
        <button className="menu-item" onClick={props.onInfo}>
          Info…
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
  totalUsage: Usage
  search: string
  onSearch: (q: string) => void
  matchCount: number
  matchPos: number
  onJumpNext: () => void
  onJumpPrev: () => void
  onOpenPalette: () => void
  onTidy: () => void
  onNewRoot: () => void
  onOpenSettings: () => void
}): JSX.Element {
  const hasQuery = props.search.trim().length > 0
  return (
    <div className="topbar">
      <div className="topbar-left">
        <span className="brand">Forkfield</span>
      </div>
      <div className="topbar-right">
        <div className={`topbar-searchbox${hasQuery ? ' active' : ''}`}>
          <Icon name="search" size={14} className="search-lead" />
          <input
            className="topbar-search"
            type="search"
            placeholder="Search nodes…"
            value={props.search}
            onChange={(e) => props.onSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                if (e.shiftKey) props.onJumpPrev()
                else props.onJumpNext()
              }
            }}
          />
          {hasQuery && (
            <span className="search-nav">
              <span className="search-count">
                {props.matchCount ? `${props.matchPos + 1}/${props.matchCount}` : '0/0'}
              </span>
              <button
                className="search-navbtn"
                title="Previous match (Shift+Enter)"
                disabled={!props.matchCount}
                onClick={props.onJumpPrev}
              >
                <Icon name="chevronLeft" size={13} />
              </button>
              <button
                className="search-navbtn"
                title="Next match (Enter)"
                disabled={!props.matchCount}
                onClick={props.onJumpNext}
              >
                <Icon name="chevronRight" size={13} />
              </button>
            </span>
          )}
        </div>
        <button
          className="btn icon-btn"
          title="Command palette (Ctrl+K)"
          onClick={props.onOpenPalette}
        >
          <Icon name="command" size={15} />
        </button>
        <button className="btn icon-btn" title="Tidy layout" onClick={props.onTidy}>
          <Icon name="tidy" size={15} />
        </button>
        <span
          className="usage-pill"
          title={'Whole canvas, all nodes, all time:\n' + usageBreakdown(props.totalUsage)}
        >
          {formatTokens(props.totalTokens)} tok · {formatCost(props.totalCost)}
        </span>
        <button className="btn" onClick={props.onNewRoot}>
          <Icon name="plus" size={14} />
          New root
        </button>
        <button className="btn icon-btn" title="Settings" onClick={props.onOpenSettings}>
          <Icon name="settings" size={15} />
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

function KeybindingRow(props: {
  cmd: KeyCommand
  combo: string
  overridden: boolean
  onRebind: (combo: string) => void
  onReset: () => void
}): JSX.Element {
  const [recording, setRecording] = useState(false)
  return (
    <SettingsRow label={props.cmd.label}>
      {recording ? (
        <button
          className="config-select recording"
          autoFocus
          onBlur={() => setRecording(false)}
          onKeyDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
            if (e.key === 'Escape') {
              setRecording(false)
              return
            }
            const combo = eventCombo(e.nativeEvent)
            // Require a modifier so shortcuts can't clash with plain typing.
            if (!combo || !hasModifier(combo)) return
            props.onRebind(combo)
            setRecording(false)
          }}
        >
          Press keys…
        </button>
      ) : (
        <>
          <button className="config-select" onClick={() => setRecording(true)}>
            {formatCombo(props.combo)}
          </button>
          {props.overridden && (
            <button
              className="btn tiny ghost icon-btn"
              title="Reset to default"
              onClick={props.onReset}
            >
              <Icon name="undo" size={13} />
            </button>
          )}
        </>
      )}
    </SettingsRow>
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
          <SettingsRow label="Max concurrent forks">
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
          <SettingsRow label="Notify when a background fork finishes">
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
          <SettingsRow label="Enter the new node when forking">
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
          <SettingsRow
            label="Fork isolation"
            hint="Worktree gives each fork its own checkout in a git repo"
          >
            <select
              value={s.isolation}
              onChange={(e) => set({ isolation: e.target.value as Isolation })}
            >
              <option value="shared">Shared folder</option>
              <option value="worktree">Git worktree per fork</option>
            </select>
          </SettingsRow>
          <SettingsRow label="Editor command" hint="Used by “Open in editor” on worktree forks">
            <input
              type="text"
              className="config-select editor-cmd"
              value={s.editorCommand}
              placeholder="code"
              onChange={(e) => set({ editorCommand: e.target.value })}
            />
          </SettingsRow>
          <div className="settings-subhead">Keyboard shortcuts</div>
          {KEY_COMMANDS.map((cmd) => (
            <KeybindingRow
              key={cmd.id}
              cmd={cmd}
              combo={comboFor(cmd.id, s.keybindings)}
              overridden={!!s.keybindings[cmd.id]}
              onRebind={(combo) => set({ keybindings: { ...s.keybindings, [cmd.id]: combo } })}
              onReset={() => {
                const next = { ...s.keybindings }
                delete next[cmd.id]
                set({ keybindings: next })
              }}
            />
          ))}
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

function EmptyCanvasHint(props: { onNewRoot: () => void }): JSX.Element {
  return (
    <div className="empty-hint">
      <div className="empty-hint-card">
        <svg
          className="empty-art"
          viewBox="0 0 220 120"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path className="empty-edge" d="M46 60h34c10 0 14-30 24-30h30" />
          <path className="empty-edge" d="M46 60h34c10 0 14 30 24 30h30" />
          <rect x="16" y="46" width="30" height="28" rx="6" />
          <rect x="134" y="16" width="30" height="28" rx="6" />
          <rect x="134" y="76" width="30" height="28" rx="6" />
        </svg>
        <h2>Start a forking session</h2>
        <p>
          A root node is a full Claude Code session in a folder you choose. Highlight any part of a
          response to fork a new line of inquiry that inherits the context, and run forks side by
          side.
        </p>
        <button className="btn primary lg" onClick={props.onNewRoot}>
          <Icon name="plus" size={16} />
          New root session
        </button>
      </div>
    </div>
  )
}
