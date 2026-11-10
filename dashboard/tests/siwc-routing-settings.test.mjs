import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createSiwcApi} from '../src/siwc-api.mjs'

test('routing settings use encoded account path and persist explicit values', async () => {
  const calls=[]
  const api=createSiwcApi('synthetic-admin',async (url, options)=>{calls.push({url,options}); return {ok:true,json:async()=>({priority:4,weight:3})}})
  assert.deepEqual(await api.routing('account /'),{priority:4,weight:3})
  assert.deepEqual(await api.setRouting('account /',{priority:4,weight:3}),{priority:4,weight:3})
  assert.equal(calls[0].url,'/admin/accounts/siwc/accounts/account%20%2F/routing')
  assert.equal(calls[0].options.method,'GET')
  assert.equal(calls[1].options.method,'POST')
  assert.deepEqual(JSON.parse(calls[1].options.body),{priority:4,weight:3})
})
