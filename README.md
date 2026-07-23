# Branchpad

A branching canvas for Claude Code. Instead of one linear CLI thread, every response lives on an infinite canvas where you can highlight text and spawn a branch that inherits the conversation. Branches run concurrently, each node is a full Claude Code session, and you keep all Claude Code functionality.

Status: planning. See [SPEC.md](./SPEC.md) for the technical design.

## Stack (planned)

- Electron (desktop, all Node and TypeScript)
- Claude Agent SDK for the Claude Code harness and session forking
- React + React Flow for the infinite node canvas
