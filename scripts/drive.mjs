#!/usr/bin/env node
// Forkfield demo driver. Attaches over CDP (launch with FORKFIELD_DEBUG=1) and
// performs the REAL interaction with a visible fake cursor: open a root session,
// type an exploratory question, send it, then highlight answers and branch off
// them by typing into the branch box. Captures a high-fps screencast that is
// encoded (with real timing, then sped up) into demo.mp4.
//
// Usage: node scripts/drive.mjs <frames-dir>
import WebSocket from 'ws'
import { writeFileSync, mkdirSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const outDir = process.argv[2] || '/tmp/forkfield-demo/frames'
mkdirSync(outDir, { recursive: true })
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
  throw new Error('no page target on :9222 (launch with FORKFIELD_DEBUG=1)')
}

class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.listeners = new Map()
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString())
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id)
        this.pending.delete(m.id)
        m.error ? reject(new Error(m.error.message)) : resolve(m.result)
      } else if (m.method) {
        const h = this.listeners.get(m.method)
        if (h) h(m.params)
      }
    })
  }
  on(method, cb) {
    this.listeners.set(method, cb)
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

const CURSOR = String.raw`(() => {
  if (document.getElementById('__cur')) return true;
  const c = document.createElement('div');
  c.id = '__cur';
  c.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" style="display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))"><path d="M4 2 L4 19 L8.5 14.5 L11.5 21.5 L14 20.4 L11 13.6 L17 13.6 Z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>';
  Object.assign(c.style, {position:'fixed',left:'700px',top:'450px',zIndex:'999999',pointerEvents:'none',transition:'left .5s cubic-bezier(.3,.7,.2,1), top .5s cubic-bezier(.3,.7,.2,1)'});
  document.body.appendChild(c);
  window.__moveCur = (x,y) => { c.style.left = x+'px'; c.style.top = y+'px'; };
  window.__curSel = (sel,fx,fy) => { const e=document.querySelector(sel); if(!e) return false; const r=e.getBoundingClientRect(); window.__moveCur(r.left+r.width*(fx==null?0.5:fx), r.top+r.height*(fy==null?0.5:fy)); return true; };
  window.__pulse = () => { c.animate([{transform:'scale(1)'},{transform:'scale(0.8)'},{transform:'scale(1)'}],{duration:220}); };
  return true;
})()`

async function main() {
  const cwd = mkdtempSync(join(tmpdir(), 'ff-demo-'))
  const ws = new WebSocket((await findPage()).webSocketDebuggerUrl, { perMessageDeflate: false })
  await new Promise((r, j) => {
    ws.once('open', r)
    ws.once('error', j)
  })
  const cdp = new CDP(ws)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  for (let i = 0; i < 40; i++) {
    if (await cdp.ev('!!(window.__ff&&window.__ff.store)')) break
    await sleep(300)
  }
  const ev = (e) => cdp.ev(e)

  // High-fps screencast capture.
  let n = 0
  const frames = []
  cdp.on('Page.screencastFrame', (p) => {
    const name = `f${String(n++).padStart(5, '0')}.jpg`
    try {
      writeFileSync(join(outDir, name), Buffer.from(p.data, 'base64'))
      frames.push({ name, ts: p.metadata.timestamp })
    } catch {}
    cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {})
  })

  const moveTo = async (sel, fx, fy, wait = 560) => {
    await ev(`window.__curSel(${JSON.stringify(sel)},${fx == null ? 'null' : fx},${fy == null ? 'null' : fy})`)
    await sleep(wait)
  }
  const clickSel = async (sel, after = 300) => {
    await moveTo(sel)
    await ev(`window.__pulse()`)
    await sleep(120)
    await ev(`document.querySelector(${JSON.stringify(sel)}).click()`)
    await sleep(after)
  }
  const proto = (sel) =>
    `(document.querySelector(${JSON.stringify(
      sel
    )}).tagName==='TEXTAREA'?window.HTMLTextAreaElement:window.HTMLInputElement).prototype`
  const type = async (sel, text, per = 46) => {
    await ev(`document.querySelector(${JSON.stringify(sel)}).focus()`)
    let cur = ''
    for (const ch of text) {
      cur += ch
      await ev(
        `(()=>{const el=document.querySelector(${JSON.stringify(
          sel
        )});const s=Object.getOwnPropertyDescriptor(${proto(
          sel
        )},'value').set;s.call(el,${JSON.stringify(cur)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`
      )
      await sleep(per)
    }
  }
  const waitFor = async (expr, ms = 60000, poll = 500) => {
    const t = Date.now()
    while (Date.now() - t < ms) {
      if (await ev(expr)) return true
      await sleep(poll)
    }
    return false
  }

  await ev(CURSOR)
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 80,
    everyNthFrame: 1,
    maxWidth: 1400,
    maxHeight: 900
  })

  // 1. One empty root session in a fresh folder; center it on screen.
  await ev(`(() => {
    const S=window.__ff.store, uid=()=>crypto.randomUUID();
    const root=uid();
    S.getState().setCanvas({id:uid(),createdAt:Date.now(),
      settings:{permissionMode:'skip', switchOnBranch:false},
      nodes:[{id:root,parentId:null,branchPoint:null,seedSelection:null,sessionId:null,
        workingDirectory:${JSON.stringify(cwd)},position:{x:120,y:180},status:'idle',
        turns:[],usage:{input:0,output:0,cacheWrite:0,cacheRead:0,costUsd:0},title:'New session',unread:false,model:'sonnet'}]});
    window.__root=root; return true;
  })()`)
  // Let React Flow mount and measure the node before fitting, so the opening
  // frame is centered and zoomed in rather than small in a corner.
  await sleep(1100)
  await clickSel('button[title^="Tidy"]', 500)
  await clickSel('button[title^="Tidy"]', 900)

  // 2. Open the root, type an exploratory question, send it.
  await clickSel('.node-card', 700)
  await waitFor(`!!document.querySelector('.cli-input textarea')`, 8000)
  await moveTo('.cli-input textarea')
  await type('.cli-input textarea', 'List the 10 most significant turning points in human history — one short line each, numbered.')
  await sleep(300)
  await clickSel('.cli-input .btn.primary', 500)

  // 3. Wait for the list to finish streaming.
  await waitFor(`window.__ff.store.getState().canvas.nodes.find(n=>n.id===window.__root).status==='complete'`, 70000)
  await sleep(1200)

  // 4. Highlight an item and branch off it by typing a follow-up.
  const branchOff = async (liIndex, question) => {
    await ev(
      `window.__curSel('.cli-transcript .md-ol li:nth-child(${liIndex + 1})', 0.5, 0.5)`
    )
    await sleep(560)
    await ev(`(()=>{
      const li=document.querySelectorAll('.cli-transcript .md-ol li')[${liIndex}];
      if(!li) return false;
      const r=document.createRange(); r.selectNodeContents(li);
      const s=window.getSelection(); s.removeAllRanges(); s.addRange(r);
      document.querySelector('.cli-transcript').dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
      return true;
    })()`)
    await sleep(700)
    await moveTo('.branch-popover input', 0.5, 0.5)
    await type('.branch-popover input', question)
    await sleep(250)
    await clickSel('.branch-popover .btn.primary', 700)
  }
  await branchOff(2, 'Why was this such a turning point?')
  await sleep(600)
  await branchOff(6, 'What everyday life was like right before this?')
  await sleep(900)

  // 5. Close the overlay to reveal the branches running in parallel.
  await clickSel('.cli-header-right button[title="Close"]', 700)
  await clickSel('button[title^="Tidy"]', 1200)

  // 6. Let both branches finish, capturing the concurrent streaming.
  await waitFor(
    `window.__ff.store.getState().canvas.nodes.filter(n=>n.parentId).every(n=>n.status==='complete')`,
    70000
  )
  await ev(`window.__curSel('button[title^="Tidy"]')`)
  await sleep(3000)

  await cdp.send('Page.stopScreencast')
  await sleep(300)
  ws.close()

  // Emit a concat manifest with real per-frame durations.
  let manifest = ''
  for (let i = 0; i < frames.length; i++) {
    const dur = i < frames.length - 1 ? Math.max(0.02, frames[i + 1].ts - frames[i].ts) : 0.15
    manifest += `file '${frames[i].name}'\nduration ${dur.toFixed(3)}\n`
  }
  if (frames.length) manifest += `file '${frames[frames.length - 1].name}'\n`
  writeFileSync(join(outDir, 'frames.txt'), manifest)
  console.log(`captured ${frames.length} frames to ${outDir}`)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
