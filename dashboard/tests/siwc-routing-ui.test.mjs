import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
test('routing editor presents bounded fields, save and strategy guidance', () => {
 const source=readFileSync(new URL('../src/pages/OfficialChatGPT.tsx',import.meta.url),'utf8')
 assert.match(source,/라우팅 설정 저장/)
 assert.match(source,/우선순위/)
 assert.match(source,/가중치/)
 assert.match(source,/max=\{1000\}/)
 assert.match(source,/max=\{100\}/)
 assert.match(source,/setRouting/)
})
