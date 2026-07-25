#!/usr/bin/env node
// Exercises the real worktree/git IPC path (main-process git.ts) through the
// running app against a throwaway repo. Requires FORKFIELD_DEBUG launch.
import WebSocket from 'ws'
import { execSync } from 'child_process'
import { mkdtempSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'pipe' }).toString()

async function findPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (p) return p
    } catch {}
    await sleep(500)
  }
  throw new Error('no page target')
}
class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString())
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id)
        this.pending.delete(m.id)
        m.error ? reject(new Error(m.error.message)) : resolve(m.result)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async ev(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'ev failed')
    return r.result?.value
  }
}

const results = []
const rec = (ok, name, info = '') => results.push([ok, name, info])

async function main() {
  // Throwaway git repo.
  const repo = mkdtempSync(join(tmpdir(), 'ff-git-'))
  sh('git init -q && git config user.email t@t && git config user.name t', repo)
  writeFileSync(join(repo, 'a.txt'), 'hello\n')
  sh('git add -A && git commit -q -m init', repo)

  const ws = new WebSocket((await findPage()).webSocketDebuggerUrl, { perMessageDeflate: false })
  await new Promise((r, j) => {
    ws.once('open', r)
    ws.once('error', j)
  })
  const cdp = new CDP(ws)
  await cdp.send('Runtime.enable')

  const call = (method, ...args) =>
    cdp.ev(`window.forkfield.${method}(${args.map((a) => JSON.stringify(a)).join(',')})`)

  // isGitRepo
  rec((await call('isGitRepo', repo)) === true, 'isGitRepo true for a git repo')
  rec((await call('isGitRepo', tmpdir())) === false, 'isGitRepo false for a non-repo')

  // createWorktree
  const wt = await call('createWorktree', repo, 'node1234abcd')
  rec(!!wt && existsSync(wt.path), 'createWorktree makes a checkout', wt ? wt.path : 'null')
  rec(!!wt && wt.branch === 'forkfield/node1234', 'worktree branch named forkfield/<id>', wt?.branch)

  // Make changes in the worktree and commit.
  writeFileSync(join(wt.path, 'a.txt'), 'hello\nworld\n')
  writeFileSync(join(wt.path, 'new.txt'), 'brand new\n')
  sh('git add -A && git commit -q -m "branch work"', wt.path)

  // gitDiff shows the changes (incl. the new file via intent-to-add path).
  const diff = await call('gitDiff', wt)
  rec(/\+world/.test(diff) && /new\.txt/.test(diff), 'gitDiff shows edits and new files')

  // Main tree stays clean.
  rec(sh('git status --porcelain', repo).trim() === '', 'main tree unaffected by branch work')

  // promoteWorktree merges the branch into base.
  const prom = await call('promoteWorktree', wt)
  rec(prom && prom.ok, 'promoteWorktree reports success', prom?.message)
  rec(/branch work/.test(sh('git log --oneline', repo)), 'base branch now contains the branch commit')

  // openInEditor spawns the configured command (use "true", a no-op binary).
  const ed = await call('openInEditor', 'true', repo)
  rec(ed && ed.ok, 'openInEditor launches the command', ed?.message)

  // removeWorktree cleans up folder + branch.
  await call('removeWorktree', wt)
  await sleep(300)
  rec(!existsSync(wt.path), 'removeWorktree deletes the checkout')
  rec(!/forkfield\/node1234/.test(sh('git branch', repo)), 'removeWorktree deletes the branch')

  ws.close()
  try {
    sh(`rm -rf ${repo}`)
  } catch {}

  console.log('\n=== Forkfield git-ops test ===')
  let fail = 0
  for (const [ok, name, info] of results) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  (' + info + ')' : ''}`)
    if (!ok) fail++
  }
  console.log(`\n${results.length - fail}/${results.length} passed`)
  process.exit(fail ? 1 : 0)
}
main().catch((e) => {
  console.error(e)
  process.exit(2)
})
