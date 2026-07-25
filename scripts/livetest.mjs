#!/usr/bin/env node
// Runs ONE real Claude turn through the app to verify live streaming, turn
// completion, and the per-turn model tag. Requires FORKFIELD_DEBUG launch and
// a working Claude Code login. Uses haiku + a trivial prompt to stay cheap.
import WebSocket from 'ws'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
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
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'ev failed')
    return r.result?.value
  }
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'ff-live-'))
  const ws = new WebSocket((await findPage()).webSocketDebuggerUrl, { perMessageDeflate: false })
  await new Promise((r, j) => {
    ws.once('open', r)
    ws.once('error', j)
  })
  const cdp = new CDP(ws)
  await cdp.send('Runtime.enable')
  for (let i = 0; i < 40; i++) {
    if (await cdp.ev('!!(window.__ff&&window.__ff.store)')) break
    await sleep(300)
  }

  // Seed one empty node and fire a real turn at it.
  await cdp.ev(`(() => {
    const S=window.__ff.store, uid=()=>crypto.randomUUID();
    const id='live-node';
    S.getState().setCanvas({id:uid(),createdAt:Date.now(),settings:{},nodes:[{
      id, parentId:null, branchPoint:null, seedSelection:null, sessionId:null,
      workingDirectory:${JSON.stringify(dir)}, position:{x:80,y:80}, status:'idle',
      turns:[], usage:{input:0,output:0,cacheWrite:0,cacheRead:0,costUsd:0}, title:'Live', unread:false
    }]});
    window.forkfield.startTurn({nodeId:id, prompt:'Reply with exactly: hello from forkfield', cwd:${JSON.stringify(
      dir
    )}, resumeSessionId:null, fork:false, model:'haiku', bypass:true});
    return true;
  })()`)

  // Poll for completion.
  let snap
  for (let i = 0; i < 80; i++) {
    await sleep(1000)
    snap = await cdp.ev(`(() => {
      const n=window.__ff.store.getState().canvas.nodes.find(x=>x.id==='live-node');
      const a=n.turns.filter(t=>t.role==='assistant');
      const text=a.map(t=>t.blocks.filter(b=>b.kind==='text').map(b=>b.text).join('')).join('\\n');
      return {status:n.status, sessionId:n.sessionId, model:(a[0]&&a[0].model)||null, cost:n.usage.costUsd, text};
    })()`)
    if (snap.status === 'complete' || snap.status === 'error') break
  }

  const results = []
  const rec = (ok, name, info = '') => results.push([ok, name, info])
  if (snap.status === 'error') {
    console.log('LIVE TURN ERRORED (likely not logged in):', snap.text)
  }
  rec(snap.status === 'complete', 'live turn completes', `status=${snap.status}`)
  rec(!!snap.text && snap.text.length > 0, 'assistant text streamed in', JSON.stringify(snap.text).slice(0, 80))
  rec(!!snap.sessionId, 'session id captured', String(snap.sessionId).slice(0, 12))
  rec(!!snap.model && /haiku/i.test(snap.model), 'per-turn model recorded', snap.model || 'none')
  rec(snap.cost >= 0, 'usage/cost recorded', '$' + snap.cost)

  ws.close()
  console.log('\n=== Forkfield live-turn test ===')
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
