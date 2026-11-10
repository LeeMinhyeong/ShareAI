import {test} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'

test('routing editor loads, validates, saves and reloads the selected account', async () => {
 const fakeReact=`let states=[], cursor=0, effects=[]; export function reset(){cursor=0} export function flush(){let e=effects; effects=[]; for(const f of e)f()} export function useState(initial){const i=cursor++; if(!(i in states)) states[i]=initial; return [states[i],v=>{states[i]=typeof v==='function'?v(states[i]):v}]} export function useRef(initial){const i=cursor++; return states[i] ||= {current:initial}} export function useEffect(fn,deps){const i=cursor++; const old=states[i]; if(!old || deps.some((v,j)=>v!==old.deps[j])) { if(old?.cleanup)old.cleanup(); const record={deps}; states[i]=record; effects.push(()=>{record.cleanup=fn()}) }};`
 const fakeJsx=`export const Fragment=Symbol.for('fragment'); export function jsx(type,props){return {type,props:props||{}}} export const jsxs=jsx;`
 const root=await build({stdin:{contents:`export {default} from './src/pages/OfficialChatGPT.tsx'; export {reset,flush} from 'react';`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'fake',setup(b){b.onResolve({filter:/^react(?:\/jsx-runtime)?$/},args=>({path:args.path,namespace:'fake'}));b.onLoad({filter:/.*/,namespace:'fake'},args=>({contents:args.path==='react'?fakeReact:fakeJsx,loader:'js'}))}}]})
 const mod=await import(`data:text/javascript;base64,${Buffer.from(root.outputFiles[0].contents).toString('base64')}`)
 let saved={priority:0,weight:1}, posts=0
 const previous=globalThis.fetch
 globalThis.fetch=async (url,opts)=>{if(url.endsWith('/accounts'))return {ok:true,json:async()=>({accounts:[{id:'a',name:'A'}]})}; if(url.endsWith('/access'))return {ok:true,json:async()=>({enabled:false,scope:'selected',userIds:[]})}; if(url.endsWith('/routing')){if(opts.method==='POST'){posts++; saved=JSON.parse(opts.body)} return {ok:true,json:async()=>({...saved})}}; throw Error('unexpected request')}
 const render=()=>{mod.reset(); const t=mod.default({adminKey:'synthetic-admin',onUpdate:()=>{}}); mod.flush(); return t}
 const nodes=n=>n==null||typeof n!=='object'?[]:[n,...(Array.isArray(n.props?.children)?n.props.children:[n.props?.children]).flatMap(nodes)]
 const find=(t,type,text)=>nodes(t).find(n=>n.type===type&&(text===undefined||n.props.children===text))
 const tick=()=>new Promise(r=>setTimeout(r,0))
 try {
  render(); await tick(); let tree=render(); find(tree,'select').props.onChange({target:{value:'a'}}); render(); await tick(); tree=render()
  let inputs=nodes(tree).filter(n=>n.type==='input'&&n.props.type==='number'); assert.deepEqual(inputs.map(n=>n.props.value),['0','1'])
  inputs[0].props.onChange({target:{value:'4'}}); tree=render(); inputs=nodes(tree).filter(n=>n.type==='input'&&n.props.type==='number'); inputs[1].props.onChange({target:{value:'3'}})
  await find(render(),'button','라우팅 설정 저장').props.onClick(); assert.deepEqual(saved,{priority:4,weight:3}); assert.equal(posts,1)
  tree=render(); find(tree,'select').props.onChange({target:{value:''}}); render(); tree=render(); find(tree,'select').props.onChange({target:{value:'a'}}); render(); await tick(); tree=render()
  inputs=nodes(tree).filter(n=>n.type==='input'&&n.props.type==='number'); assert.deepEqual(inputs.map(n=>n.props.value),['4','3'])
  inputs[1].props.onChange({target:{value:'0'}}); await find(render(),'button','라우팅 설정 저장').props.onClick(); assert.equal(posts,1); assert.match(JSON.stringify(render()),/정수여야/)
 } finally {globalThis.fetch=previous}
})
