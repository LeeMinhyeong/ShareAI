import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

let harnessId = 0
async function harness(fetchImpl) {
  const fakeReact = `let states=[], cursor=0, effects=[]; export function reset(){cursor=0} export function flush(){const pending=effects; effects=[]; for(const fn of pending)fn()} export function useState(initial){const i=cursor++; if(!(i in states))states[i]=initial; return [states[i],v=>{states[i]=typeof v==='function'?v(states[i]):v}]} export function useMemo(fn,deps){const i=cursor++; const old=states[i]; if(!old||deps.some((v,j)=>v!==old.deps[j]))states[i]={deps,value:fn()}; return states[i].value} export function useEffect(fn,deps){const i=cursor++; const old=states[i]; if(!old||deps.some((v,j)=>v!==old.deps[j])){if(old?.cleanup)old.cleanup(); const record={deps}; states[i]=record; effects.push(()=>{record.cleanup=fn()})}}`
  const fakeJsx = `export const Fragment=Symbol.for('fragment'); export function jsx(type,props){return {type,props:props||{}}} export const jsxs=jsx;`
  const charts = `export const BarChart='BarChart', Bar='Bar', XAxis='XAxis', YAxis='YAxis', Tooltip='Tooltip', ResponsiveContainer='ResponsiveContainer', PieChart='PieChart', Pie='Pie', Cell='Cell'`
  const url = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  const reactUrl = `${url(fakeReact)}#${++harnessId}`
  const source = await readFile(new URL('../src/pages/Stats.tsx', import.meta.url), 'utf8')
  let compiled = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText
  compiled = compiled.replace('"react/jsx-runtime"', JSON.stringify(url(fakeJsx)))
    .replace("'react'", JSON.stringify(reactUrl)).replace("'recharts'", JSON.stringify(url(charts)))
  const mod = await import(url(`${compiled}\nexport {reset,flush} from ${JSON.stringify(reactUrl)}`))
  const previous = globalThis.fetch
  globalThis.fetch = fetchImpl
  const render = (adminKey='synthetic') => {mod.reset(); const tree=mod.default({adminKey}); mod.flush(); return JSON.stringify(tree)}
  return {render, restore:()=>{globalThis.fetch=previous}}
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const account = (overrides = {}) => ({id:'id',name:'good account',provider:'openai',status:'active',usedToday:4,dailyQuota:10,quotaResetAt:'2026-01-01T00:00:00Z',...overrides})

test('legacy invalid numeric quota is shown as unknown without hiding valid accounts', async () => {
  const h=await harness(async()=>({ok:true,json:async()=>({accounts:[account(),account({id:'bad1',name:'negative',dailyQuota:-1}),account({id:'bad2',name:'fraction',dailyQuota:1.5})]})}))
  try { h.render(); await tick(); const view=h.render(); assert.match(view,/good account/); assert.match(view,/negative/); assert.match(view,/fraction/); assert.equal((view.match(/알 수 없음/g)||[]).length,2); assert.doesNotMatch(view,/통계를 불러오지 못했습니다/) } finally { h.restore() }
})

test('stored legacy reset time is labeled separately from the daily quota', async () => {
  const h=await harness(async()=>({ok:true,json:async()=>({accounts:[account()]})}))
  try { h.render(); await tick(); const view=h.render(); assert.match(view,/기록된 기존 리셋 시각 \(일일 할당량과 별개\)/) } finally { h.restore() }
})

test('disabled accounts are included in the status chart', async () => {
  const h=await harness(async()=>({ok:true,json:async()=>({accounts:[account({status:'disabled'})]})}))
  try { h.render(); await tick(); const view=h.render(); assert.match(view,/비활성/); assert.match(view,/"name":"비활성","value":1/) } finally { h.restore() }
})

test('malformed account objects remain unavailable', async () => {
  for (const bad of [null, [], {}, account({dailyQuota:null}), account({name:{}})]) {
    const h=await harness(async()=>({ok:true,json:async()=>({accounts:[account(),bad]})}))
    try { h.render(); await tick(); const view=h.render(); assert.match(view,/통계를 불러오지 못했습니다/); assert.doesNotMatch(view,/good account/) } finally { h.restore() }
  }
})

test('valid zero quota remains unlimited and chart receives only needed fields', async () => {
  const h=await harness(async()=>({ok:true,json:async()=>({accounts:[account({dailyQuota:0, secret:'synthetic-secret'})]})}))
  try { h.render(); await tick(); const view=h.render(); assert.match(view,/∞/); assert.doesNotMatch(view,/synthetic-secret/) } finally { h.restore() }
})

test('the mock render hides A data on transitions including A to B to A', async () => {
  const pending=[]
  const h=await harness(()=>new Promise(resolve=>pending.push(resolve)))
  try {
    h.render('A'); pending[0]({ok:true,json:async()=>({accounts:[account({name:'old-A'})]})}); await tick()
    assert.match(h.render('A'),/old-A/)
    assert.doesNotMatch(h.render('B'),/old-A/)
    assert.doesNotMatch(h.render('A'),/old-A/)
    pending[1]({ok:true,json:async()=>({accounts:[account({name:'late-B'})]})}); await tick()
    assert.doesNotMatch(h.render('A'),/late-B/)
    pending[2]({ok:true,json:async()=>({accounts:[account({name:'new-A'})]})}); await tick()
    assert.match(h.render('A'),/new-A/)
  } finally { h.restore() }
})

test('failed stats request is unavailable rather than an empty account report', async () => {
  const h=await harness(async()=>({ok:false,status:503}))
  try { h.render(); await tick(); const view=h.render(); assert.match(view,/통계를 불러오지 못했습니다/); assert.doesNotMatch(view,/계정별 상세/) } finally { h.restore() }
})

test('a successful empty account list remains a valid report', async () => {
  const h=await harness(async()=>({ok:true,json:async()=>({accounts:[]})}))
  try { h.render(); await tick(); const view=h.render(); assert.match(view,/계정별 상세/); assert.doesNotMatch(view,/통계를 불러오지 못했습니다/) } finally { h.restore() }
})

test('network errors and malformed responses are unavailable', async () => {
  for (const fetchImpl of [async()=>{throw Error('offline')}, async()=>({ok:true,json:async()=>({accounts:null})})]) {
    const h=await harness(fetchImpl)
    try { h.render(); await tick(); const view=h.render(); assert.match(view,/통계를 불러오지 못했습니다/); assert.doesNotMatch(view,/계정별 상세/) } finally { h.restore() }
  }
})

test('a stale response cannot replace the current administrator report', async () => {
  let resolveOld
  const h=await harness((url, options)=>options.headers.Authorization==='Bearer old'
    ? new Promise(resolve=>{resolveOld=resolve})
    : Promise.resolve({ok:true,json:async()=>({accounts:[]})}))
  try {
    h.render('old'); h.render('new'); await tick()
    resolveOld({ok:false,status:503}); await tick()
    const view=h.render('new'); assert.match(view,/계정별 상세/); assert.doesNotMatch(view,/통계를 불러오지 못했습니다/)
  } finally { h.restore() }
})
