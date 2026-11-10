import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

// Render the actual component with a minimal hook/JSX harness; network is always mocked.
async function harness(fetcher) {
  const fakeReact = `let states=[], cursor=0; export function reset(){cursor=0} export function useState(initial){const i=cursor++; if(!(i in states)) states[i]=initial; return [states[i], value=>{states[i]=typeof value==='function'?value(states[i]):value}]} export function useRef(initial){const i=cursor++; return states[i] ||= {current:initial}} export function useEffect(){};`
  const fakeJsx = `export const Fragment=Symbol.for('fragment'); export function jsx(type,props){return {type,props:props||{}}} export const jsxs=jsx;`
  const root = await build({stdin:{contents:`export {default} from './src/pages/OfficialChatGPT.tsx'; export {reset} from 'react';`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'fake-react',setup(b){b.onResolve({filter:/^react(?:\/jsx-runtime)?$/},args=>({path:args.path,namespace:'fake'}));b.onLoad({filter:/.*/,namespace:'fake'},args=>({contents:args.path==='react'?fakeReact:fakeJsx,loader:'js'}))}}]})
  const mod = await import(`data:text/javascript;base64,${Buffer.from(root.outputFiles[0].contents).toString('base64')}#${Math.random()}`)
  globalThis.fetch = fetcher
  globalThis.window = {confirm:()=>true}
  const render = () => { mod.reset(); return mod.default({adminKey:'synthetic-admin',onUpdate:()=>{}}) }
  const nodes = (node) => node == null || typeof node !== 'object' ? [] : [node,...(Array.isArray(node.props?.children)?node.props.children:[node.props?.children]).flatMap(nodes)]
  const find = (tree, type, text) => nodes(tree).find(n=>n.type===type && (text===undefined || n.props.children===text))
  let tree = render(); find(tree,'select').props.onChange({target:{value:'account'}}); tree = render()
  return {render,find,button:()=>find(render(),'button','선택 계정 로그아웃')}
}

test('logout displays confirmed and unconfirmed outcomes', async () => {
  for (const remoteRevoked of [true,false]) {
    const h = await harness(async()=>({ok:true,json:async()=>({localSignedOut:true,remoteRevoked})}))
    await h.button().props.onClick()
    const message=h.find(h.render(),'p').props.children // first paragraph is informational
    assert.ok(message)
    const status = (function walk(n){if(!n || typeof n!=='object')return; if(n.props?.role==='status')return n.props.children; for(const child of [n.props?.children].flat(Infinity)){const found=walk(child);if(found)return found}})(h.render())
    assert.match(status,remoteRevoked ? /원격 세션 종료가 확인/ : /원격 세션 종료는 확인되지 않았/)
  }
})

test('duplicate clicks are ignored while pending and errors do not expose secrets', async () => {
  let release, calls=0
  const h=await harness(async()=>{calls++; await new Promise(r=>{release=r}); throw Error('secret-token')})
  const button=h.button(); const first=button.props.onClick(); const second=button.props.onClick()
  assert.equal(calls,1); assert.equal(h.button().props.disabled,true)
  release(); await Promise.all([first,second])
  const tree=JSON.stringify(h.render()); assert.ok(!tree.includes('secret-token')); assert.ok(tree.includes('로그아웃 결과를 확인하지 못했습니다'))
  assert.equal(h.button().props.disabled,false)
})
