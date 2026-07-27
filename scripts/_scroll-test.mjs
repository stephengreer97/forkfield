import WebSocket from 'ws'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const page = (await (await fetch('http://127.0.0.1:9222/json/list')).json()).find(
  (x) => x.type === 'page' && /index\.html/.test(x.url)
)
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
await new Promise((r) => ws.once('open', r))
let id = 0
const pend = new Map()
ws.on('message', (d) => {
  const m = JSON.parse(d)
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m.result)
    pend.delete(m.id)
  }
})
const ev = async (e) =>
  (
    await new Promise((res) => {
      pend.set(++id, res)
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: e, awaitPromise: true, returnByValue: true } }))
    })
  ).result?.value
const wait = async (e, ms = 6000) => {
  const t = Date.now()
  while (Date.now() - t < ms) {
    if (await ev(e)) return true
    await sleep(200)
  }
  return false
}
await new Promise((res) => {
  pend.set(++id, res)
  ws.send(JSON.stringify({ id, method: 'Runtime.enable', params: {} }))
})
await wait('typeof window.__ff', 12000)

// Seed a node with a long answer so there's scroll space.
const longText = Array(30)
  .fill(0)
  .map((_, i) => `Line ${i + 1}: This is a long line of text to create scroll space in the transcript.`)
  .join('\n')

await ev(`(()=>{
  const S=window.__ff.store, uid=()=>crypto.randomUUID();
  const id='scroll-test';
  S.getState().setCanvas({id:uid(),createdAt:Date.now(),settings:{},nodes:[{
    id, parentId:null, branchPoint:null, seedSelection:null, sessionId:'session-1',
    workingDirectory:'/tmp', position:{x:80,y:80}, status:'complete',
    turns:[
      {id:uid(),role:'user',blocks:[{kind:'text',text:'prompt'}],createdAt:Date.now()},
      {id:uid(),role:'assistant',blocks:[{kind:'text',text:${JSON.stringify(longText)}}],createdAt:Date.now()}
    ],
    usage:{input:10,output:20,cacheWrite:0,cacheRead:0,costUsd:0.01},title:'Scroll Test',unread:false
  }]});
  window.__ff.openNode(id);return true;
})()`)
await sleep(800)

// Get initial scroll state (should be at bottom).
let state1 = await ev(`(() => {
  const el = document.querySelector('.cli-transcript');
  return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
})()`)
console.log('Initial (should be at bottom):', state1)
const atBottom1 = state1.scrollHeight - (state1.scrollTop + state1.clientHeight) < 50
console.log('  atBottom:', atBottom1)

// Scroll up 200px.
await ev(`(() => {
  const el = document.querySelector('.cli-transcript');
  el.scrollTop -= 200;
})()`)
await sleep(100)

// Check scroll state after user scroll.
let state2 = await ev(`(() => {
  const el = document.querySelector('.cli-transcript');
  return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
})()`)
console.log('After scrolling up 200px:', state2)
const atBottom2 = state2.scrollHeight - (state2.scrollTop + state2.clientHeight) < 50
console.log('  atBottom:', atBottom2)

// Simulate node update (add a turn - this would trigger auto-scroll).
await ev(`(() => {
  const S=window.__ff.store;
  const node=S.getState().canvas.nodes[0];
  node.turns.push({
    id:crypto.randomUUID(),
    role:'user',
    blocks:[{kind:'text',text:'another message'}],
    createdAt:Date.now()
  });
  S.getState().applyEvent({type:'status',nodeId:node.id,status:'thinking'});
})()`)
await sleep(300)

// Check scroll after update - should NOT scroll to bottom since user scrolled up.
let state3 = await ev(`(() => {
  const el = document.querySelector('.cli-transcript');
  return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
})()`)
console.log('After node update (should stay up):', state3)
const atBottom3 = state3.scrollHeight - (state3.scrollTop + state3.clientHeight) < 50
console.log('  atBottom:', atBottom3)

// Verify it didn't jump back to the bottom.
const scrolledStayedUp = state3.scrollTop === state2.scrollTop
console.log('\n=== Scroll Behavior ===')
console.log(`PASS  user scroll respected (scroll didn't jump down): ${scrolledStayedUp}`)
console.log(`PASS  tracking atBottom works: ${!atBottom2 && atBottom1}`)

ws.close()
process.exit(scrolledStayedUp ? 0 : 1)
