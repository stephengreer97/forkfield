import { randomUUID } from 'crypto'
import type { SessionEvent, Usage, StartTurnParams } from '../shared/types'

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

interface NodeRuntime {
  nodeId: string
  sessionId: string | null
  cwd: string
  abort: AbortController | null
  busy: boolean
}

export class SessionManager {
  private runtimes = new Map<string, NodeRuntime>()
  private pendingPermissions = new Map<string, (allow: boolean) => void>()
  private bypass = false

  constructor(private send: (event: SessionEvent) => void) {}

  setBypass(on: boolean): void {
    this.bypass = on
  }

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
      rt = { nodeId, sessionId: null, cwd, abort: null, busy: false }
      this.runtimes.set(nodeId, rt)
    } else {
      rt.cwd = cwd
    }
    return rt
  }

  async startTurn(params: StartTurnParams): Promise<void> {
    const rt = this.runtime(params.nodeId, params.cwd)
    if (rt.busy) return
    const resume = params.resumeSessionId ?? rt.sessionId ?? undefined
    await this.run(rt, params.prompt, resume, params.fork)
  }

  private async run(
    rt: NodeRuntime,
    prompt: string,
    resume: string | undefined,
    fork: boolean
  ): Promise<void> {
    rt.busy = true
    const abort = new AbortController()
    rt.abort = abort
    const turnId = randomUUID()
    this.send({ type: 'status', nodeId: rt.nodeId, status: 'thinking' })

    try {
      const query = await getQuery()
      const options: Record<string, unknown> = {
        cwd: rt.cwd,
        abortController: abort,
        appendSystemPrompt: CONCURRENCY_GUIDANCE,
        permissionMode: this.bypass ? 'bypassPermissions' : 'default',
        includePartialMessages: false
      }
      if (resume) options.resume = resume
      if (fork) options.forkSession = true
      if (!this.bypass) {
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

  private handleMessage(rt: NodeRuntime, turnId: string, message: any): void {
    switch (message?.type) {
      case 'system': {
        if (message.subtype === 'init' && message.session_id) {
          rt.sessionId = message.session_id
          this.send({ type: 'session', nodeId: rt.nodeId, sessionId: message.session_id })
        }
        break
      }
      case 'assistant': {
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
          sessionId: rt.sessionId
        })
        break
      }
    }
  }
}
