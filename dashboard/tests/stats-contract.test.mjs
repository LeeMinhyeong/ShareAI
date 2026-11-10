import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInThisContext } from 'node:vm'
import ts from 'typescript'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const require = createRequire(import.meta.url)
const source = readFileSync(new URL('../src/pages/Stats.tsx', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
const module = { exports: {} }
runInThisContext(`(function(require,module,exports){${compiled}\n})`)(require, module, module.exports)
const { default: Stats, isAccountStatsResponse } = module.exports

const account = { id: 'a', name: 'Account', provider: 'anthropic', status: 'active', usedToday: 2, dailyQuota: 0, quotaResetAt: '2026-01-01T00:00:00.000Z' }

test('valid backend response and empty list pass validation', () => {
  assert.equal(isAccountStatsResponse({ accounts: [] }), true)
  assert.equal(isAccountStatsResponse({ accounts: [account] }), true)
  for (const provider of ['anthropic', 'openai', 'google']) {
    for (const status of ['active', 'quota_exceeded', 'error', 'disabled']) {
      assert.equal(isAccountStatsResponse({ accounts: [{ ...account, provider, status }] }), true)
    }
  }
})

test('finite legacy numeric quotas are accepted for unknown display', () => {
  for (const dailyQuota of [-1, 1.5]) {
    assert.equal(isAccountStatsResponse({ accounts: [{ ...account, dailyQuota }] }), true)
  }
})

test('reject malformed responses and every invalid displayed field', () => {
  for (const value of [null, {}, { accounts: null }, { accounts: [null] }, { accounts: [{}] }]) {
    assert.equal(isAccountStatsResponse(value), false)
  }
  for (const [field, value] of Object.entries({ id: null, name: {}, provider: null, status: {}, usedToday: null, dailyQuota: {}, quotaResetAt: {} })) {
    assert.equal(isAccountStatsResponse({ accounts: [{ ...account, [field]: value }] }), false, field)
  }
  for (const [field, value] of [['provider', 'unknown'], ['status', 'unknown'], ['usedToday', -1], ['usedToday', 0.5], ['dailyQuota', NaN], ['dailyQuota', Infinity], ['quotaResetAt', 'not a date']]) {
    assert.equal(isAccountStatsResponse({ accounts: [{ ...account, [field]: value }] }), false, field)
  }
})

test('real React server renderer shows loading without exposing key', () => {
  const token = 'synthetic-sensitive-key'
  const html = renderToStaticMarkup(React.createElement(Stats, { adminKey: token }))
  assert.match(html, /데이터를 불러오는 중/)
  assert.equal(html.includes(token), false)
})
