# Branchpad Technical Spec

Working name: **Branchpad** (rename freely; it is only used as the repo folder name so far).

## 1. Goal

Talking to Claude in a linear CLI is limiting. A single response may have ten points, and you may want to follow up on four of them separately. Branchpad replaces the single scrolling thread with an infinite canvas where any response can spawn a branch. You highlight text in a response, spawn a branch anchored to that selection, and keep exploring. Branches run concurrently. Every node is a full Claude Code session, so all Claude Code functionality is preserved.

## 2. Core concepts

- **Canvas:** an infinite, pannable, zoomable surface. Nodes grow left to right as you branch.
- **Node:** one Claude Code session, shown on the canvas as a small preview. A node is a live CLI you can keep talking to indefinitely. It grows downward as a normal linear conversation and rightward only when you branch off one of its responses.
- **Branch:** a fork of a node's session at a specific response, seeded with highlighted text. The branch inherits the parent's full context up to that point.
- **CLI view:** clicking a node opens a large view (about 90 percent of the screen) that is the interactive CLI for that node. Clicking outside it or the X returns to the canvas.

## 3. Architecture

Electron desktop app, all Node and TypeScript.

- **Main process (Node):** owns the Claude Agent SDK. One session per node. Forks sessions on branch. Streams session events to the renderer over IPC. Enforces the permission mode and surfaces permission requests.
- **Renderer (React + React Flow):** the canvas. Renders node previews, left to right edges, pan, zoom, drag. Hosts the CLI overlay, the command bar, and the token displays.
- **Canvas UI library:** React Flow (xyflow) for the node graph, pan, zoom, and layout.
- **Agent runtime:** Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`). It provides the full Claude Code harness: file tools, bash, search, MCP, slash commands, permissions, streaming, and session fork and resume.

## 4. Data model

```
Canvas {
  id: string
  createdAt: number
  settings: {
    bypassPermissions: boolean   // global --dangerously-skip-permissions toggle
  }
  nodes: Node[]
}

Node {
  id: string
  parentId: string | null
  branchPoint: { parentTurnIndex: number } | null  // which parent turn this forked from
  seedSelection: string | null                      // highlighted text that seeded this branch
  sessionId: string                                 // Agent SDK session id
  workingDirectory: string
  position: { x: number, y: number }
  status: NodeStatus
  turns: Turn[]
  usage: Usage                                      // aggregated across turns
}

Turn {
  role: 'user' | 'assistant'
  blocks: ContentBlock[]        // text, tool_use, tool_result, thinking, etc.
  usage: Usage                  // per turn billing
  createdAt: number
}

Usage {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  estimatedCostUsd: number
}
```

Edges are derived from `parentId`, so they are not stored separately.

## 5. Session and branching model

- The root node starts a fresh session in the chosen working directory.
- Continuing a conversation in a node is a normal send into that node's existing session. The node grows downward.
- Branching forks the parent session. A branch point is the parent node up to and including a specific turn. The fork inherits that entire context. The highlighted span becomes the branch's opening user turn on top of the inherited context.
- Forking shares the parent's cached prefix, so a branch is about as cheap as asking that follow up with the parent context, and it never carries sibling branches' content.

## 6. Node state machine

States and their canvas appearance:

- `idle`: no active turn. Neutral preview.
- `thinking`: a turn is streaming. Animated progress indicator (the `...`).
- `awaiting_permission`: a tool call needs approval. **Yellow glow.**
- `complete`: the last turn finished. **Green glow.**
- `error`: the last turn failed. Error styling with the reason.

Transitions:

- `idle` to `thinking` on send.
- `thinking` to `awaiting_permission` when a tool needs approval (only when bypass is off).
- `awaiting_permission` to `thinking` on approve, or back toward `idle` on deny.
- `thinking` to `complete` on turn end.
- `thinking` to `error` on failure.
- `complete` or `error` to `thinking` again when you send another message, since a node is a continuing CLI.

## 7. Interaction

- **Preview vs CLI:** nodes are previews on the canvas. Clicking a node opens the CLI view at about 90 percent of the screen. Clicking outside it or the X returns to the canvas.
- **Branching:** select text inside a response, and a branch action forks the node at that turn and places a child node to the right, seeded with the selection.
- **Interrupt:** select a thinking node and press ctrl+c to cancel that node's current turn. The node returns to `idle`.
- **Delete:** right click a node for a destructive confirm. The confirm states that the action cannot be undone and that it will also delete every descendant branch, including the count of descendants. On confirm, the node and all descendant sessions are torn down and the subtree is removed. Deletion is blocked, or requires interrupting first, if the node or any descendant is thinking.
- **Command bar:** a text input at the bottom routes input, including slash commands, to the focused node.

## 8. Permissions

- When bypass is off and a tool call needs approval, the node enters `awaiting_permission` with a yellow glow and shows the request. Approving or denying resolves it.
- A global UI toggle enables `--dangerously-skip-permissions` (bypass permission mode). When on, it stays on and applies to every existing node and every future node. It is stored in `Canvas.settings.bypassPermissions` and reapplied on reload.

## 9. Concurrency and filesystem

For now there is no workspace isolation. All nodes share the working directory, so concurrent branches can touch the same files at the same time. This is handled by making each session aware of the possibility rather than by locking or isolating.

Each session receives injected guidance along these lines:

> Other Claude sessions may read or modify files in this working directory at the same time as you. If a file read or write fails because of a conflict or lock, wait and retry: first after 5 seconds, then 10 seconds, then 30 seconds, then 2 minutes. If it still fails after the 2 minute retry, stop attempting the operation and clearly tell the user what failed and why.

Claude performs the retries and the backoff. The app does not intercept or auto retry tool calls. When Claude gives up, its message surfaces in that node as normal output. Git worktree isolation per branch is a possible later improvement.

## 10. Persistence and reload

- The canvas structure, per node transcripts, positions, settings, and session ids are persisted to disk.
- On reload, the canvas is rebuilt and each node's session is resumed by its stored session id. If a session cannot be resumed, the transcript is replayed to recreate context so branching still works.
- Persistence is incremental so a crash does not lose the tree.

## 11. Token and cost visibility

Numbers come from the real per turn usage returned by the API, not estimates.

- **Node preview badge:** cumulative tokens and estimated cost for that node's session, so expensive branches are visible at a glance.
- **CLI view per turn line:** input, output, cache write, and cache read tokens per turn. This makes the shared root being served from cache on child branches visible, which is the concrete proof that branching is cheap.
- **Canvas header total:** a running total across all nodes for the session, summed from actual per turn usage so shared cached context is never double counted.
- **Pricing:** a small config maps model id to input, output, cache write, and cache read prices so cost estimates track the model in use.
- **Optional later:** color a node badge when a branch crosses a spend threshold you set.

## 12. Startup

- An empty canvas prompts you to choose a directory. The root node opens in that directory.

## 13. IPC contract (draft)

Renderer to main:

- `node:createRoot(directory)` returns the new root node.
- `node:send(nodeId, text)` sends a turn into a node's session.
- `node:branch(parentNodeId, turnIndex, selection)` forks and creates a child node.
- `node:interrupt(nodeId)` cancels the current turn.
- `node:delete(nodeId)` tears down the node and all descendants.
- `settings:setBypassPermissions(enabled)`.
- `permission:respond(nodeId, requestId, allow)`.
- `canvas:save()` and `canvas:load()`.

Main to renderer:

- `session:event(nodeId, event)` streams turn events (text deltas, tool use, tool result, thinking, usage, done, error).
- `permission:request(nodeId, requestId, detail)` when a tool needs approval.
- `node:statusChanged(nodeId, status)`.

## 14. Build order

1. Electron shell with a single Agent SDK session streaming into one React Flow node. Prove the SDK wiring and streaming.
2. Node states: thinking indicator, yellow glow for permission, green glow for complete, the CLI overlay at 90 percent, click out or X to close.
3. Highlight to branch: selection capture, session fork, child node placement, left to right layout.
4. Concurrency guidance injection, interrupt with ctrl+c, right click delete with cascade confirm.
5. Persistence and reload.
6. Token and cost displays.

## 15. Deferred

- Git worktree isolation per branch.
- Context growth and compaction on deep branches.
- Per node model or effort selection.
- Spend threshold alerts.
