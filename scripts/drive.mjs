#!/usr/bin/env node
// Forkfield demo driver. Attaches to the app over the Chrome DevTools Protocol
// (the app must be launched with FORKFIELD_DEBUG=1, which opens port 9222),
// scripts a short guided tour through the automation bridge, and captures
// frames that are stitched into a GIF with ImageMagick.
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
  throw new Error('No page target on :9222 (is the app running with FORKFIELD_DEBUG=1?)')
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
  const r = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: 1400, height: 900, scale: 0.5 }
  })
  writeFileSync(join(outDir, `f${String(frame++).padStart(4, '0')}.png`), Buffer.from(r.data, 'base64'))
}

// --- The scene the driver builds inside the page ------------------------------
const SEED = String.raw`
(() => {
  const S = window.__ff.store;
  const uid = () => crypto.randomUUID();
  const U = (i,o,c) => ({input:i,output:o,cacheWrite:0,cacheRead:c,costUsd:((i+o)/1e6)*9});
  const T = (role,text,model) => ({id:uid(),role,blocks:[{kind:'text',text}],createdAt:Date.now(),model});
  const root=uid(), b1=uid(), b2=uid(), b3=uid(), g1=uid();
  const wt = (id) => ({path:'/repo/.git/forkfield/'+id.slice(0,8),branch:'forkfield/'+id.slice(0,8),baseRef:'abc123',repoRoot:'/home/sgreer/mealio_central'});
  const nodes = [
    {id:root,parentId:null,branchPoint:null,seedSelection:null,sessionId:'d0',workingDirectory:'/home/sgreer/mealio_central',position:{x:80,y:60},status:'complete',title:'Add dark mode',unread:false,usage:U(1200,760,4200),model:'claude-opus-4-8',turns:[
      T('user','Add a dark mode toggle to the app header.'),
      T('assistant','There are two clean ways to do this: CSS custom properties flipped by a data-theme attribute, or Tailwind’s dark: variant. The variable approach is lighter to retrofit and needs no build changes.\n\nWant me to try both as branches and compare?','claude-opus-4-8')
    ]},
    {id:b1,parentId:root,branchPoint:{parentTurnIndex:1},seedSelection:'CSS custom properties flipped by a data-theme attribute',sessionId:'d1',workingDirectory:'/home/sgreer/mealio_central',position:{x:520,y:-120},status:'complete',title:'CSS variables approach',unread:false,tags:['keep'],model:'claude-opus-4-8',worktree:wt(b1),usage:U(2400,1500,9000),turns:[
      T('user','Try the CSS custom properties approach.'),
      T('assistant','Defined the palette as variables on :root and overrode them under :root[data-theme="dark"]. A single toggle flips the attribute, so every component recolors with zero per-component work. No Tailwind config or build change needed.','claude-opus-4-8')
    ]},
    {id:b2,parentId:root,branchPoint:{parentTurnIndex:1},seedSelection:'Tailwind’s dark: variant',sessionId:'d2',workingDirectory:'/home/sgreer/mealio_central',position:{x:520,y:120},status:'complete',title:'Tailwind dark variant',unread:true,tags:['wip'],model:'claude-sonnet-5',worktree:wt(b2),usage:U(1900,1200,7000),turns:[
      T('user','Try the Tailwind dark: variant instead.'),
      T('assistant','Set darkMode:"class" and prefixed color utilities with dark:. It works, but it touches every component that sets a color, so it’s a larger diff than the variable approach.','claude-sonnet-5')
    ]},
    {id:b3,parentId:root,branchPoint:{parentTurnIndex:1},seedSelection:'compare',sessionId:'d3',workingDirectory:'/home/sgreer/mealio_central',position:{x:520,y:360},status:'idle',title:'Sync to OS preference',unread:false,model:'claude-sonnet-5',usage:U(0,0,0),turns:[
      T('user','Make the theme follow the OS setting when set to system.')
    ]},
    {id:g1,parentId:b1,branchPoint:{parentTurnIndex:1},seedSelection:'a single toggle flips the attribute',sessionId:'d4',workingDirectory:'/home/sgreer/mealio_central',position:{x:960,y:-120},status:'complete',title:'Persist choice',unread:false,tags:['keep'],model:'claude-haiku-4-5',worktree:wt(g1),usage:U(700,400,3000),turns:[
      T('user','Persist the choice to localStorage and restore on load.'),
      T('assistant','Reads the saved theme on startup and writes it whenever the toggle changes, so the preference survives reloads.','claude-haiku-4-5')
    ]}
  ];
  S.getState().setCanvas({id:uid(),createdAt:Date.now(),settings:{},nodes});
  window.__ffIds = {root,b1,b2,b3,g1};
  return true;
})()
`

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

  // Wait for the automation bridge to exist.
  for (let i = 0; i < 40; i++) {
    if (await cdp.evaluate('!!(window.__ff && window.__ff.store)')) break
    await sleep(300)
  }

  // Capture frames continuously in the background.
  let running = true
  ;(async () => {
    while (running) {
      try {
        await shot(cdp)
      } catch {
        /* ignore transient */
      }
      await sleep(160)
    }
  })()

  const ev = (e) => cdp.evaluate(e)
  const clickTitle = (t) =>
    ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.title&&x.title.indexOf(${JSON.stringify(
      t
    )})===0);if(b){b.click();return true}return false})()`)

  // 1. Seed the scene, then tidy + fit.
  await ev(SEED)
  await sleep(700)
  await clickTitle('Tidy')
  await sleep(1600)

  // 2. Command palette: open, type, close.
  await clickTitle('Command palette')
  await sleep(700)
  await ev(
    `(()=>{const i=document.querySelector('.palette-input');const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(i,'dark');i.dispatchEvent(new Event('input',{bubbles:true}));})()`
  )
  await sleep(1300)
  await ev(
    `document.querySelector('.palette-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`
  )
  await sleep(700)

  // 3. Open a branch node: breadcrumb + conversation.
  await ev(`window.__ff.openNode(window.__ffIds.b1)`)
  await sleep(1800)

  // 4. Streaming: open the idle node and stream a reply in.
  await ev(`window.__ff.openNode(window.__ffIds.b3)`)
  await sleep(700)
  await ev(
    `(()=>{const id=window.__ffIds.b3;const S=window.__ff.store;S.getState().applyEvent({type:'status',nodeId:id,status:'thinking'});window.__tt='stream1';})()`
  )
  const chunks = [
    'Reading the theme setting',
    '… when it is "system", I subscribe to ',
    'the prefers-color-scheme media query ',
    'and update the data-theme attribute live, ',
    'so the app follows the OS the moment it changes.'
  ]
  for (const c of chunks) {
    await ev(
      `window.__ff.store.getState().applyEvent({type:'assistant_text',nodeId:window.__ffIds.b3,turnId:window.__tt,text:${JSON.stringify(
        c
      )}})`
    )
    await sleep(430)
  }
  await ev(
    `window.__ff.store.getState().applyEvent({type:'turn_done',nodeId:window.__ffIds.b3,turnId:window.__tt,usage:{input:900,output:300,cacheWrite:0,cacheRead:3000,costUsd:0.02},sessionId:'d3',model:'claude-sonnet-5'})`
  )
  await ev(
    `window.__ff.store.getState().applyEvent({type:'status',nodeId:window.__ffIds.b3,status:'complete'})`
  )
  await sleep(1200)

  // 5. Dark theme.
  await ev(`window.__ff.setTheme('dark')`)
  await sleep(1800)

  // 6. Back to the canvas in dark mode.
  await ev(`window.__ff.openNode(null)`)
  await sleep(1400)

  // 7. Settings panel (shows the refreshed icon + controls).
  await clickTitle('Settings')
  await sleep(1900)
  await ev(
    `(()=>{const b=[...document.querySelectorAll('.settings-dialog .btn')].find(x=>x.textContent.trim()==='Done');if(b)b.click();})()`
  )
  await sleep(700)
  await ev(`window.__ff.setTheme('light')`)
  await sleep(900)

  running = false
  await sleep(300)
  ws.close()
  console.log(`captured ${frame} frames to ${outDir}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
