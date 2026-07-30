import { randomUUID } from 'crypto'
import { join } from 'path'
import { existsSync } from 'fs'
import { ensureSessionInCwd } from './history'
import type { SessionEvent, Usage, StartTurnParams } from '../shared/types'

// In a packaged app the SDK's own binary resolution points inside app.asar,
// which can't be executed. If the unpacked binary exists (packaged build),
// point the SDK at it. In dev / the WSL run there is no app.asar.unpacked, so
// this returns undefined and the SDK resolves the binary from node_modules.
function getClaudeExecutable(): string | undefined {
  const resources = process.resourcesPath
  if (!resources) return undefined
  const pkg = `claude-agent-sdk-${process.platform}-${process.arch}`
  const bin = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const p = join(resources, 'app.asar.unpacked', 'node_modules', '@anthropic-ai', pkg, bin)
  return existsSync(p) ? p : undefined
}

// The Claude Agent SDK is ESM. Load it via a runtime dynamic import that the
// CJS bundler will not rewrite, so it resolves from node_modules at runtime.
const dynamicImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>

let queryFn: ((args: any) => AsyncIterable<any>) | null = null
async function getQuery(): Promise<(args: any) => AsyncIterable<any>> {
  if (!queryFn) {
    const mod = await dynamicImport('@anthropic-ai/claude-agent-sdk')
    queryFn = mod.query
  }
  return queryFn as (args: any) => AsyncIterable<any>
}

const CONCURRENCY_GUIDANCE =
  'Other Claude sessions may read or modify files in this working directory at the ' +
  'same time as you. If a file read or write fails because of a conflict or lock, ' +
  'wait and retry: first after 5 seconds, then 10 seconds, then 30 seconds, then 2 ' +
  'minutes. If it still fails after the 2 minute retry, stop attempting the operation ' +
  'and clearly tell the user what failed and why.'

interface StreamBlock {
  type: 'text' | 'tool_use' | 'other'
  name?: string
  json: string
}

interface NodeRuntime {
  nodeId: string
  sessionId: string | null
  cwd: string
  abort: AbortController | null
  busy: boolean
  lastModel: string | null
  lastContextTokens: number
  streamed: boolean
  blocks: Map<number, StreamBlock>
}

export class SessionManager {
  private runtimes = new Map<string, NodeRuntime>()
  private pendingPermissions = new Map<string, (allow: boolean) => void>()

  constructor(private send: (event: SessionEvent) => void) {}

  resolvePermission(requestId: string, allow: boolean): void {
    const resolve = this.pendingPermissions.get(requestId)
    if (resolve) {
      resolve(allow)
      this.pendingPermissions.delete(requestId)
    }
  }

  interrupt(nodeId: string): void {
    const rt = this.runtimes.get(nodeId)
    if (rt?.abort) rt.abort.abort()
  }

  private runtime(nodeId: string, cwd: string): NodeRuntime {
    let rt = this.runtimes.get(nodeId)
    if (!rt) {
      rt = {
        nodeId,
        sessionId: null,
        cwd,
        abort: null,
        busy: false,
        lastModel: null,
        lastContextTokens: 0,
        streamed: false,
        blocks: new Map()
      }
      this.runtimes.set(nodeId, rt)
    } else {
      rt.cwd = cwd
    }
    return rt
  }

  async startTurn(params: StartTurnParams): Promise<void> {
    const rt = this.runtime(params.nodeId, params.cwd)
    if (rt.busy) return
    const resume = params.resumeSessionId ?? undefined
    await this.run(rt, params.prompt, resume, params.fork, params.model, params.bypass)
  }

  private async run(
    rt: NodeRuntime,
    prompt: string,
    resume: string | undefined,
    fork: boolean,
    model: string | undefined,
    bypass: boolean
  ): Promise<void> {
    rt.busy = true
    rt.streamed = false
    rt.blocks.clear()
    const abort = new AbortController()
    rt.abort = abort
    const turnId = randomUUID()
    this.send({ type: 'status', nodeId: rt.nodeId, status: 'thinking' })

    // Make sure a resumed transcript is discoverable from this cwd. Matters for
    // worktree branches, whose cwd differs from the session's original dir.
    if (resume) ensureSessionInCwd(rt.cwd, resume)

    try {
      const query = await getQuery()
      const options: Record<string, unknown> = {
        cwd: rt.cwd,
        abortController: abort,
        appendSystemPrompt: CONCURRENCY_GUIDANCE,
        permissionMode: bypass ? 'bypassPermissions' : 'default',
        includePartialMessages: true
      }
      if (resume) options.resume = resume
      if (fork) options.forkSession = true
      if (model) options.model = model
      const claudePath = getClaudeExecutable()
      if (claudePath) options.pathToClaudeCodeExecutable = claudePath
      if (!bypass) {
        options.canUseTool = (toolName: string, input: unknown) =>
          this.askPermission(rt, toolName, input)
      }

      const stream = query({ prompt, options })
      for await (const message of stream) {
        this.handleMessage(rt, turnId, message)
      }
      this.send({ type: 'status', nodeId: rt.nodeId, status: 'complete' })
    } catch (err) {
      if (abort.signal.aborted) {
        this.send({ type: 'status', nodeId: rt.nodeId, status: 'idle' })
      } else {
        const message = err instanceof Error ? err.message : String(err)
        this.send({ type: 'error', nodeId: rt.nodeId, message })
        this.send({ type: 'status', nodeId: rt.nodeId, status: 'error' })
      }
    } finally {
      rt.busy = false
      rt.abort = null
    }
  }

  private async askPermission(
    rt: NodeRuntime,
    toolName: string,
    input: unknown
  ): Promise<{ behavior: 'allow'; updatedInput: unknown } | { behavior: 'deny'; message: string }> {
    const requestId = randomUUID()
    this.send({ type: 'status', nodeId: rt.nodeId, status: 'awaiting_permission' })
    this.send({ type: 'permission_request', nodeId: rt.nodeId, requestId, toolName, input })
    const allow = await new Promise<boolean>((resolve) => {
      this.pendingPermissions.set(requestId, resolve)
    })
    this.send({ type: 'status', nodeId: rt.nodeId, status: 'thinking' })
    return allow
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: 'The user denied this tool call.' }
  }

  // Raw Anthropic streaming events. content_block_start/stop bound each block,
  // deltas carry text (rendered live) or partial tool-input JSON (assembled and
  // emitted at the block's stop, preserving text/tool/text ordering).
  private handleStreamEvent(rt: NodeRuntime, turnId: string, ev: any): void {
    if (!ev) return
    switch (ev.type) {
      case 'message_start':
        rt.blocks.clear()
        break
      case 'content_block_start': {
        const cb = ev.content_block
        const type: StreamBlock['type'] =
          cb?.type === 'text' ? 'text' : cb?.type === 'tool_use' ? 'tool_use' : 'other'
        rt.blocks.set(ev.index, { type, name: cb?.name, json: '' })
        break
      }
      case 'content_block_delta': {
        const d = ev.delta
        if (d?.type === 'text_delta' && d.text) {
          rt.streamed = true
          this.send({ type: 'assistant_text', nodeId: rt.nodeId, turnId, text: d.text })
        } else if (d?.type === 'input_json_delta' && typeof d.partial_json === 'string') {
          const b = rt.blocks.get(ev.index)
          if (b) b.json += d.partial_json
        }
        break
      }
      case 'content_block_stop': {
        const b = rt.blocks.get(ev.index)
        if (b?.type === 'tool_use') {
          let input: unknown = {}
          try {
            input = b.json ? JSON.parse(b.json) : {}
          } catch {
            input = b.json
          }
          rt.streamed = true
          this.send({
            type: 'tool_use',
            nodeId: rt.nodeId,
            turnId,
            toolName: b.name ?? 'tool',
            input
          })
        }
        break
      }
    }
  }

  private handleMessage(rt: NodeRuntime, turnId: string, message: any): void {
    switch (message?.type) {
      case 'system': {
        if (message.subtype === 'init') {
          if (message.session_id) {
            rt.sessionId = message.session_id
            this.send({ type: 'session', nodeId: rt.nodeId, sessionId: message.session_id })
          }
          if (Array.isArray(message.slash_commands)) {
            this.send({
              type: 'slash_commands',
              nodeId: rt.nodeId,
              commands: message.slash_commands as string[]
            })
          }
          // The resolved model, which is the only way to learn what an alias
          // like "opus" — or the account default — actually maps to.
          if (typeof message.model === 'string' && message.model) {
            rt.lastModel = message.model
            this.send({ type: 'model', nodeId: rt.nodeId, model: message.model })
          }
        } else if (message.subtype === 'compact_boundary') {
          // Compaction replaces the conversation with a summary, so the context
          // just shrank. Without this the meter keeps showing the pre-compaction
          // size: it is fed by the last assistant message, and the newest one
          // was sent the full conversation.
          const meta = message.compact_metadata ?? {}
          const post = typeof meta.post_tokens === 'number' ? meta.post_tokens : 0
          rt.lastContextTokens = post
          this.send({
            type: 'compacted',
            nodeId: rt.nodeId,
            contextTokens: post,
            trigger: meta.trigger === 'auto' ? 'auto' : 'manual'
          })
        }
        break
      }
      case 'stream_event': {
        // Reconstruct content from the raw stream so text and tool calls appear
        // live and in their true order (the final assembled message can't tell
        // us where a tool call sits between two runs of text).
        this.handleStreamEvent(rt, turnId, message.event)
        break
      }
      case 'assistant': {
        if (message.message?.model) rt.lastModel = message.message.model
        // Each assistant message reports the whole conversation it was sent, so
        // the newest one is the current context size. The result message's usage
        // can't be used for this: it sums every request made during the turn.
        const mu = message.message?.usage
        if (mu) {
          const ctx =
            (mu.input_tokens ?? 0) +
            (mu.cache_read_input_tokens ?? 0) +
            (mu.cache_creation_input_tokens ?? 0) +
            (mu.output_tokens ?? 0)
          if (ctx) rt.lastContextTokens = ctx
        }
        // Everything was already emitted from the stream; the final message
        // would just duplicate it. Only fall back if streaming produced nothing.
        if (rt.streamed) break
        const content = message.message?.content ?? []
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            this.send({ type: 'assistant_text', nodeId: rt.nodeId, turnId, text: block.text })
          } else if (block.type === 'tool_use') {
            this.send({
              type: 'tool_use',
              nodeId: rt.nodeId,
              turnId,
              toolName: block.name,
              input: block.input
            })
          }
        }
        break
      }
      case 'user': {
        const content = message.message?.content ?? []
        for (const block of content) {
          if (block?.type === 'tool_result') {
            const text =
              typeof block.content === 'string'
                ? block.content
                : JSON.stringify(block.content)
            this.send({
              type: 'tool_result',
              nodeId: rt.nodeId,
              turnId,
              text,
              isError: !!block.is_error
            })
          }
        }
        break
      }
      case 'result': {
        if (message.session_id) rt.sessionId = message.session_id
        const u = message.usage ?? {}
        const usage: Usage = {
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cacheWrite: u.cache_creation_input_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          costUsd: message.total_cost_usd ?? 0
        }
        this.send({
          type: 'turn_done',
          nodeId: rt.nodeId,
          turnId,
          usage,
          contextTokens: rt.lastContextTokens,
          sessionId: rt.sessionId,
          model: rt.lastModel
        })
        break
      }
    }
  }
}
