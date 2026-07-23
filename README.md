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

One command, from anywhere:
```
branchpad
```
That builds the app and opens it on your Windows desktop through WSLg. A `branchpad` launcher is installed in `~/bin`. If `~/bin` is not on your PATH, run the script directly:
```
~/branchpad/scripts/launch.sh
```
or, from inside the repo:
```
npm start
```

The first run installs dependencies and fetches the Electron binary, so it takes a few minutes. After that it starts in a few seconds. The launcher handles the install, the binary fetch, and the build for you, and it passes `--no-sandbox`, which WSL needs.

For live development with hot reload, use `npm run dev` instead.

### Auth

The app reuses your existing Claude Code authentication (the same credentials `claude` and `ant` use). Make sure you are logged in there first; no API key is stored in the app. This applies to the packaged Windows app too: it needs Claude Code available and authenticated on the machine it runs on.

## Package for Windows

Two options.

- **Portable zip (builds from WSL, no extra tools):**
  ```
  npm run pack:win
  ```
  Produces `dist/Branchpad-<version>-x64.zip` and `dist/win-unpacked/Branchpad.exe`. Copy the zip to Windows, unzip anywhere, and run `Branchpad.exe`. No install needed. The Agent SDK is pure JavaScript with no native binaries, so a WSL-built package runs on Windows.

- **Installer (.exe, NSIS):**
  ```
  npm run dist:win
  ```
  This produces a proper installer under `dist/`. Building the NSIS installer on WSL/Linux needs Wine; the reliable path is to run this command from **Windows PowerShell** in the repo (run `npm install` there once first), where no Wine is required.

The app has no custom icon yet, so it uses the default Electron icon. That is a later polish step.

## Scripts

- `npm run dev` starts Electron with hot reload
- `npm run build` builds the production bundles into `out/`
- `npm run typecheck` typechecks main, preload, and renderer
- `npm run pack:win` builds a portable Windows zip into `dist/`
- `npm run dist:win` builds a Windows installer into `dist/` (NSIS; needs Windows or Wine)

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
