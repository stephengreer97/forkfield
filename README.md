# Branchpad

A branching canvas for Claude Code. Instead of one linear CLI thread, every response lives on an infinite canvas where you can highlight text and spawn a branch that inherits the conversation. Branches run concurrently, each node is a full Claude Code session, and you keep all Claude Code functionality.

See [SPEC.md](./SPEC.md) for the full technical design.

## Stack

- Electron (desktop, all Node and TypeScript)
- Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) for the Claude Code harness and session forking
- React + React Flow (`@xyflow/react`) for the infinite node canvas
- Zustand for renderer state

## What works so far (MVP)

- Infinite canvas: pan, zoom, drag, minimap
- Pick a folder to open the root node in
- Each node is a live Claude Code session you can keep chatting with (the 90 percent CLI overlay)
- Highlight any assistant text and branch off it (forks the parent session with the selection as context)
- Concurrent branches, each streaming independently
- Node glow states: blue pulse while thinking, yellow for a pending permission, green when done
- Approve or deny tool permissions per node, plus a global skip-permissions toggle
- ctrl+c interrupts a thinking node
- Right click a node to delete it and all descendants, with a confirm
- Per-node and total token and cost readouts
- Canvas persists and reloads across restarts

## Run it (WSL2 on Windows 11)

1. Install dependencies:
   ```
   npm install
   ```
   On WSL the first install is slow because it pulls the Electron binary and a large dependency tree. Let it finish; do not run two installs at once.

2. Start the app:
   ```
   npm run dev
   ```
   The window opens on your Windows desktop via WSLg.

If the Electron binary was skipped during install (you will see an error about a missing Electron executable on `npm run dev`), fetch it once with:
```
node node_modules/electron/install.js
```

If your shell blocks executing `node_modules/.bin` scripts, run commands through node or npx instead, for example:
```
npx electron-vite dev
```

### Auth

The app reuses your existing Claude Code authentication (the same credentials `claude` and `ant` use). Make sure you are logged in there first; no API key is stored in the app.

## Scripts

- `npm run dev` starts Electron with hot reload
- `npm run build` builds the production bundles into `out/`
- `npm run typecheck` typechecks main, preload, and renderer

## Layout

```
src/
  shared/types.ts        shared types + IPC contract
  main/                  Electron main process
    index.ts             window + IPC wiring
    sessions.ts          Claude Agent SDK session manager (fork, resume, permissions, interrupt)
    persistence.ts       canvas save/load
  preload/index.ts       contextBridge API
  renderer/
    src/
      App.tsx            top bar, orchestration, autosave
      store.ts           zustand canvas state + event reducer
      components/
        Canvas.tsx       React Flow canvas
        NodeCard.tsx     node preview with glow + permission buttons
        CliView.tsx      90 percent CLI overlay, transcript, branch popover
      styles.css
```
