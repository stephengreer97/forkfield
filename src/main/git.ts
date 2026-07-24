import { execFile } from 'child_process'
import { join } from 'path'
import type { Worktree } from '../shared/types'

// Thin promise wrapper around `git`. Rejects with stderr on non-zero exit.
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.trim() || err.message))
      else resolve(stdout)
    })
  })
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const out = await git(dir, ['rev-parse', '--is-inside-work-tree'])
    return out.trim() === 'true'
  } catch {
    return false
  }
}

// Create an isolated worktree for a branch node, checked out on a fresh
// forkfield/<id> branch off the parent's current HEAD. Lives inside .git so it
// never shows up in the main tree's status and is cleaned up on node delete.
export async function createWorktree(baseDir: string, nodeId: string): Promise<Worktree | null> {
  try {
    const repoRoot = (await git(baseDir, ['rev-parse', '--show-toplevel'])).trim()
    const baseRef = (await git(baseDir, ['rev-parse', 'HEAD'])).trim()
    const short = nodeId.slice(0, 8)
    const branch = `forkfield/${short}`
    const path = join(repoRoot, '.git', 'forkfield', short)
    await git(repoRoot, ['worktree', 'add', '-b', branch, path, baseRef])
    return { path, branch, baseRef, repoRoot }
  } catch (err) {
    console.error('createWorktree failed:', err)
    return null
  }
}

export async function removeWorktree(wt: Worktree): Promise<void> {
  try {
    await git(wt.repoRoot, ['worktree', 'remove', '--force', wt.path])
  } catch (err) {
    console.error('worktree remove failed:', err)
  }
  try {
    await git(wt.repoRoot, ['branch', '-D', wt.branch])
  } catch {
    // Branch may already be gone; ignore.
  }
  try {
    await git(wt.repoRoot, ['worktree', 'prune'])
  } catch {
    // Best effort.
  }
}

// Full patch of everything the branch changed relative to where it forked,
// including new files (intent-to-add makes untracked files show up in the diff).
export async function gitDiff(wt: Worktree): Promise<string> {
  try {
    await git(wt.path, ['add', '-A', '-N'])
  } catch {
    // Non-fatal: diff still shows tracked changes without this.
  }
  try {
    return await git(wt.path, ['diff', wt.baseRef])
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}
