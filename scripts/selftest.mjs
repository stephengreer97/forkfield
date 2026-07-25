#!/usr/bin/env node
// Drives the running app (FORKFIELD_DEBUG=1) over CDP and asserts each feature
// works. Prints PASS/FAIL per check and exits non-zero if any fail.
import WebSocket from 'ws'

const PORT = 9222
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
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
let cdp
async function check(name, expr) {
  try {
    const v = await cdp.ev(`(async()=>{ return (${expr}); })()`)
    const ok = !!v
    results.push([ok, name, ok ? '' : `got ${JSON.stringify(v)}`])
  } catch (e) {
    results.push([false, name, e.message])
  }
}
const act = async (expr, wait = 250) => {
  await cdp.ev(expr)
  await sleep(wait)
}

const SEED = String.raw`(() => {
  const S = window.__ff.store, uid=()=>crypto.randomUUID();
  const U=(i,o)=>({input:i,output:o,cacheWrite:0,cacheRead:0,costUsd:0.02});
  const T=(r,t)=>({id:uid(),role:r,blocks:[{kind:'text',text:t}],createdAt:Date.now()});
  const root=uid(),b1=uid(),b2=uid(),g=uid();
  const N=(id,parent,x,y,title,turns,extra)=>Object.assign({id,parentId:parent,branchPoint:parent?{parentTurnIndex:1}:null,seedSelection:parent?'sel':null,sessionId:'s',workingDirectory:'/tmp',position:{x,y},status:'complete',title,unread:false,usage:U(100,50),turns:turns||[]},extra||{});
  const nodes=[
    N(root,null,80,300,'Root question',[T('user','make it faster please'),T('assistant','Two options: cache or paginate.')]),
    N(b1,root,520,120,'Cache approach',[T('user','cache it'),T('assistant','cached, now fast')],{model:'claude-opus-4-8'}),
    N(b2,root,520,400,'Paginate approach',[T('user','paginate'),T('assistant','paginated')],{model:'claude-sonnet-5'}),
    N(g,b1,960,120,'Persist choice',[T('user','persist'),T('assistant','done')])
  ];
  S.getState().setCanvas({id:uid(),createdAt:Date.now(),settings:{},nodes});
  window.__ids={root,b1,b2,g};
  return true;
})()`

async function main() {
  const ws = new WebSocket((await findPage()).webSocketDebuggerUrl, { perMessageDeflate: false })
  await new Promise((r, j) => {
    ws.once('open', r)
    ws.once('error', j)
  })
  cdp = new CDP(ws)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  for (let i = 0; i < 40; i++) {
    if (await cdp.ev('!!(window.__ff&&window.__ff.store)')) break
    await sleep(300)
  }

  await act(SEED, 500)

  // Branch spacing (post-tidy): child column offset and sibling row gap.
  await act(
    `window.__ff.store.getState().setNodePositions(window.__ff.tidyLayout(window.__ff.store.getState().canvas.nodes))`,
    300
  )
  await check('branch spacing: child column >= 400px right of parent', `(()=>{const n=window.__ff.store.getState().canvas.nodes,by=Object.fromEntries(n.map(x=>[x.id,x]));return by[window.__ids.b1].position.x - by[window.__ids.root].position.x >= 400})()`)
  await check('branch spacing: siblings >= 240px apart vertically', `(()=>{const n=window.__ff.store.getState().canvas.nodes,by=Object.fromEntries(n.map(x=>[x.id,x]));return Math.abs(by[window.__ids.b1].position.y - by[window.__ids.b2].position.y) >= 240})()`)

  // Rendered node count.
  await check('all 4 nodes render as cards', `document.querySelectorAll('.node-card').length === 4`)

  // Search + dim + count.
  await act(
    `(()=>{const i=document.querySelector('.topbar-search');const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(i,'cache');i.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    350
  )
  await check('search dims non-matches', `document.querySelectorAll('.node-card.dim').length >= 1`)
  await check('search shows match count', `/\\d+\\/\\d+/.test(document.querySelector('.search-count')?.textContent||'')`)
  await act(
    `(()=>{const i=document.querySelector('.topbar-search');const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(i,'');i.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    250
  )

  // Command palette via keybinding.
  await act(
    `window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}))`,
    350
  )
  await check('Ctrl+K opens command palette', `!!document.querySelector('.palette')`)
  await act(
    `(()=>{const i=document.querySelector('.palette-input');const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(i,'tidy');i.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    300
  )
  await check('palette fuzzy-filters to Tidy', `[...document.querySelectorAll('.palette-item-label')].some(e=>/tidy/i.test(e.textContent))`)
  await act(`document.querySelector('.palette-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`, 250)
  await check('palette closes on Escape', `!document.querySelector('.palette')`)

  // Subtree collapse hides descendants.
  await act(`window.__ff.store.getState().toggleCollapse(window.__ids.b1)`, 300)
  await check('collapse hides descendant (g)', `document.querySelectorAll('.node-card').length === 3`)
  await check('collapsed node shows hidden badge', `!!document.querySelector('.node-collapsed-badge')`)
  await act(`window.__ff.store.getState().toggleCollapse(window.__ids.b1)`, 300)
  await check('expand restores descendant', `document.querySelectorAll('.node-card').length === 4`)

  // Tags.
  await act(`window.__ff.store.getState().addTag(window.__ids.b2,'experiment')`, 300)
  await check('tag chip renders', `[...document.querySelectorAll('.node-tag')].some(e=>e.textContent==='experiment')`)
  await check('tag is searchable', `window.__ff.store.getState().canvas.nodes.find(n=>n.id===window.__ids.b2).tags.includes('experiment')`)
  await act(`window.__ff.store.getState().removeTag(window.__ids.b2,'experiment')`, 250)
  await check('tag removed', `!window.__ff.store.getState().canvas.nodes.find(n=>n.id===window.__ids.b2).tags.includes('experiment')`)

  // Undo/restore.
  await act(
    `(()=>{const S=window.__ff.store;window.__snap=S.getState().canvas.nodes.filter(n=>n.id===window.__ids.g);S.getState().deleteNode(window.__ids.g);})()`,
    250
  )
  await check('delete removes node', `document.querySelectorAll('.node-card').length === 3`)
  await act(`window.__ff.store.getState().restoreNodes(window.__snap)`, 300)
  await check('undo restores node', `document.querySelectorAll('.node-card').length === 4`)

  // Per-turn model badge (open branch, mark its turn with a model).
  await act(`window.__ff.openNode(window.__ids.b1)`, 400)
  await check('overlay breadcrumb shows lineage path', `document.querySelectorAll('.cli-breadcrumb .crumb').length >= 2`)
  await act(
    `(()=>{const S=window.__ff.store;const n=S.getState().canvas.nodes.find(x=>x.id===window.__ids.b1);const tid=n.turns.find(t=>t.role==='assistant').id;S.getState().applyEvent({type:'turn_done',nodeId:window.__ids.b1,turnId:tid,usage:{input:1,output:1,cacheWrite:0,cacheRead:0,costUsd:0.01},sessionId:'s',model:'claude-opus-4-8'});})()`,
    300
  )
  await check('per-turn model badge renders', `[...document.querySelectorAll('.turn-model')].some(e=>/opus/i.test(e.textContent))`)

  // Focus mode.
  await act(`(()=>{const b=[...document.querySelectorAll('.cli-header-right button')].find(x=>/Focus/i.test(x.title));if(b)b.click();})()`, 300)
  await check('focus mode expands panel', `!!document.querySelector('.cli-panel.focus')`)
  await act(`window.__ff.openNode(null)`, 300)

  // Compare dialog via palette command.
  await act(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}))`, 300)
  await act(
    `(()=>{const i=document.querySelector('.palette-input');const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(i,'compare');i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`,
    400
  )
  await check('compare dialog opens with two pickers', `document.querySelectorAll('.compare-dialog select').length === 2`)
  await check('compare shows transcripts', `document.querySelectorAll('.compare-pane .compare-turn').length >= 2`)
  await act(`(()=>{const d=document.querySelector('.confirm-backdrop');if(d)d.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));document.querySelector('.compare-dialog')&&document.querySelector('.diff-header .btn').click();})()`, 300)

  // Broadcast via palette.
  await act(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}))`, 300)
  await act(
    `(()=>{const i=document.querySelector('.palette-input');const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;s.call(i,'broadcast');i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`,
    400
  )
  await check('broadcast prompt dialog opens', `[...document.querySelectorAll('.confirm-dialog h3, .prompt-dialog h3, .confirm-dialog')].some(e=>/broadcast/i.test(e.textContent))`)
  await act(`document.querySelector('.confirm-backdrop')?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`, 200)

  // Toast + theme + font scale.
  await act(`window.__ff.store.getState().pushToast({kind:'success',message:'self-test toast'})`, 300)
  await check('toast renders', `[...document.querySelectorAll('.toast')].some(e=>/self-test toast/.test(e.textContent))`)
  await act(`window.__ff.setTheme('dark')`, 300)
  await check('dark theme applies', `document.documentElement.getAttribute('data-theme')==='dark'`)
  await act(`window.__ff.store.getState().updateSettings({fontScale:1.3})`, 250)
  await check('font scale variable set', `getComputedStyle(document.documentElement).getPropertyValue('--font-scale').trim()==='1.3'`)
  await act(`window.__ff.setTheme('light');window.__ff.store.getState().updateSettings({fontScale:1})`, 200)

  ws.close()

  // Report.
  console.log('\n=== Forkfield self-test ===')
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
