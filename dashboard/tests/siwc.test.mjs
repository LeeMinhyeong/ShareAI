import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSiwcApi } from '../src/siwc-api.mjs'

test('SIWC requests use same-origin admin endpoints and explicit payloads', async () => {
  const calls = []
  const api = createSiwcApi('admin', async (url, options) => {
    calls.push({ url, options })
    return { ok: true, json: async () => ({ flowId: 'flow', authorizationUrl: 'https://example.test/auth' }) }
  })
  await api.start({ accountId: 'acct' })
  assert.equal(calls[0].url, '/admin/accounts/siwc/start')
  assert.equal(calls[0].options.headers.Authorization, 'Bearer admin')
  assert.deepEqual(JSON.parse(calls[0].options.body), { accountId: 'acct' })
  assert.equal(calls[0].options.cache, 'no-store')
})

test('access settings use encoded account path and explicit policy', async () => {
  const calls = []
  const api = createSiwcApi('admin', async (url, options) => { calls.push({url,options}); return {ok:true,json:async()=>({})} })
  await api.access('id /')
  await api.setAccess('id /', {enabled:true,scope:'selected',userIds:['u']})
  assert.equal(calls[0].url, '/admin/accounts/siwc/accounts/id%20%2F/access')
  assert.equal(calls[0].options.method, 'GET')
  assert.equal(calls[1].options.method, 'POST')
  assert.deepEqual(JSON.parse(calls[1].options.body), {enabled:true,scope:'selected',userIds:['u']})
})

test('errors never expose server response bodies', async () => {
  const api = createSiwcApi('admin', async () => ({ ok: false, status: 500, json: async () => ({ error: 'secret-token' }) }))
  await assert.rejects(api.list(), error => !error.message.includes('secret-token') && error.message.includes('500'))
})

test('logout posts to encoded account endpoint with admin authorization', async () => {
  let call
  const api = createSiwcApi('admin', async (url, options) => { call = {url, options}; return {ok:true, json:async()=>({localSignedOut:true,remoteRevoked:false,token:'secret-token'})} })
  assert.deepEqual(await api.logout('id /'), {localSignedOut:true,remoteRevoked:false})
  assert.equal(call.url, '/admin/siwc/accounts/id%20%2F/logout')
  assert.equal(call.options.method, 'POST'); assert.equal(call.options.headers.Authorization, 'Bearer admin')
  assert.deepEqual(JSON.parse(call.options.body), {})
})

test('logout rejects malformed results and HTTP errors without leaking bodies', async () => {
  for (const body of [{localSignedOut:false,remoteRevoked:true}, {localSignedOut:true}, {local:'signed_out',remote:'confirmed'}]) {
    const api = createSiwcApi('admin', async () => ({ok:true,json:async()=>body}))
    await assert.rejects(api.logout('account'), /Invalid logout response/)
  }
  const api = createSiwcApi('admin', async () => ({ok:false,status:403,json:async()=>({token:'secret-token'})}))
  await assert.rejects(api.logout('account'), error => error.message.includes('403') && !error.message.includes('secret-token'))
})
