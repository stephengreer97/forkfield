#!/usr/bin/env node
// Forkfield demo driver. Attaches to the app over the Chrome DevTools Protocol
// (launch with FORKFIELD_DEBUG=1, which opens port 9222), scripts a short tour
// that shows the core idea (fork one Claude session into parallel branches),
// and captures full-resolution frames for encoding into a video.
//
// Usage: node scripts/drive.mjs <frames-dir>
import WebSocket from 'ws'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

const PORT = 9222
const outDir = process.argv[2] || '/tmp/forkfield-demo'
mkdirSync(outDir, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findPageTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* not up yet */
    }
    await sleep(500)
  }
  throw new Error('No page target on :9222 (launch with FORKFIELD_DEBUG=1)')
}

class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || 'evaluate failed')
    }
    return r.result?.value
  }
}

let frame = 0
async function shot(cdp) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(outDir, `f${String(frame++).padStart(4, '0')}.png`), Buffer.from(r.data, 'base64'))
}

// Root session with a clear decision point that invites branching.
const SEED_ROOT = String.raw`
(() => {
  const S = window.__ff.store;
  const uid = () => crypto.randomUUID();
  const U = (i,o,c) => ({input:i,output:o,cacheWrite:0,cacheRead:c,costUsd:((i+o)/1e6)*9});
  const T = (role,text,model) => ({id:uid(),role,blocks:[{kind:'text',text}],createdAt:Date.now(),model});
  const root = uid();
  const nodes = [{
    id:root, parentId:null, branchPoint:null, seedSelection:null, sessionId:'d0',
    workingDirectory:'/home/sgreer/mealio_central', position:{x:120,y:260},
    status:'complete', title:'Speed up the dashboard', unread:false,
    model:'claude-opus-4-8', usage:U(1400,900,4200), turns:[
      T('user','The dashboard takes about 4 seconds to load. Make it faster.'),
      T('assistant','The bottleneck is the analytics aggregate query. Two solid directions:\n\n1. Cache the aggregated result so repeat loads are instant.\n2. Paginate and lazy-load so the first paint happens fast.\n\nThey trade freshness against simplicity. Want me to try both as separate branches and compare the results?','claude-opus-4-8')
    ]
  }];
  S.getState().setCanvas({id:uid(),createdAt:Date.now(),settings:{},nodes});
  window.__root = root;
  return true;
})()
`

// Fork a branch off the root, mid-thought, ready to stream.
function makeBranch(varName, title, selection, prompt, model) {
  return String.raw`
(() => {
  const S = window.__ff.store;
  const n = S.getState().addBranch(window.__root, 1, ${JSON.stringify(selection)});
  S.getState().setNodeTitle(n.id, ${JSON.stringify(title)}, true);
  S.getState().setNodeModel(n.id, ${JSON.stringify(model)});
  S.getState().appendUserTurn(n.id, ${JSON.stringify(prompt)});
  S.getState().applyEvent({type:'status', nodeId:n.id, status:'thinking'});
  window.${varName} = n.id;
  return n.id;
})()
`
}

function streamChunk(varName, turnVar, text) {
  return `window.__ff.store.getState().applyEvent({type:'assistant_text',nodeId:window.${varName},turnId:window.${turnVar},text:${JSON.stringify(
    text
  )}})`
}
function done(varName, turnVar, cost) {
  return `(()=>{const S=window.__ff.store;S.getState().applyEvent({type:'turn_done',nodeId:window.${varName},turnId:window.${turnVar},usage:{input:2100,output:1300,cacheWrite:0,cacheRead:8000,costUsd:${cost}},sessionId:'x',model:'m'});S.getState().applyEvent({type:'status',nodeId:window.${varName},status:'complete'});})()`
}

async function main() {
  const target = await findPageTarget()
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false })
  await new Promise((res, rej) => {
    ws.once('open', res)
    ws.once('error', rej)
  })
  const cdp = new CDP(ws)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  for (let i = 0; i < 40; i++) {
    if (await cdp.evaluate('!!(window.__ff && window.__ff.store)')) break
    await sleep(300)
  }
  const ev = (e) => cdp.evaluate(e)
  const clickTitle = (t) =>
    ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.title&&x.title.indexOf(${JSON.stringify(
      t
    )})===0);if(b){b.click();return true}return false})()`)

  // Capture frames continuously in the background.
  let running = true
  ;(async () => {
    while (running) {
      try {
        await shot(cdp)
      } catch {
        /* transient */
      }
      await sleep(150)
    }
  })()

  // 1. One root session; open it and let the viewer read the decision point.
  await ev(SEED_ROOT)
  await sleep(400)
  await ev(`window.__ff.openNode(window.__root)`)
  await sleep(3600)

  // 2. Back to the canvas.
  await ev(`window.__ff.openNode(null)`)
  await sleep(1100)

  // 3. Fork two branches that explore the two approaches, in parallel.
  await ev(makeBranch('__b1', 'Cache the query', 'Cache the aggregated result', 'Cache the aggregate query so repeat loads are instant.', 'claude-opus-4-8'))
  await sleep(250)
  await ev(makeBranch('__b2', 'Paginate + lazy-load', 'Paginate and lazy-load', 'Paginate the results and lazy-load the rest so first paint is fast.', 'claude-sonnet-5'))
  await ev(`window.__t1='s1';window.__t2='s2';`)
  await sleep(300)
  await clickTitle('Tidy')
  await sleep(1500)

  // 4. Both branches stream their work concurrently.
  const s1 = [
    'Added a 60s cache on the ',
    'aggregate query keyed by the active filters. ',
    'Repeat loads drop from ~4s to about 120ms.'
  ]
  const s2 = [
    'Split the query into a fast first ',
    'page plus a background prefetch of the rest. ',
    'First paint is now ~600ms; the rest fills in.'
  ]
  for (let i = 0; i < 3; i++) {
    await ev(streamChunk('__b1', '__t1', s1[i]))
    await sleep(220)
    await ev(streamChunk('__b2', '__t2', s2[i]))
    await sleep(360)
  }
  await ev(done('__b1', '__t1', 0.06))
  await ev(done('__b2', '__t2', 0.05))
  await sleep(1400)

  // 5. A third parallel idea, to show it scales.
  await ev(makeBranch('__b3', 'Precompute nightly', 'precompute', 'Precompute the aggregate nightly into a summary table.', 'claude-haiku-4-5'))
  await ev(`window.__t3='s3';`)
  await sleep(250)
  await clickTitle('Tidy')
  await sleep(1200)
  const s3 = ['Materialized the aggregate into a ', 'nightly summary table; the dashboard now reads it directly in ~40ms.']
  for (let i = 0; i < 2; i++) {
    await ev(streamChunk('__b3', '__t3', s3[i]))
    await sleep(420)
  }
  await ev(done('__b3', '__t3', 0.02))
  await sleep(2600)

  running = false
  await sleep(300)
  ws.close()
  console.log(`captured ${frame} frames to ${outDir}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
