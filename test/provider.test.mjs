import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { provider } from '../source/provider.mjs'

async function listen(t) {
  const source = provider().listen(0, '127.0.0.1')
  t.after(() => new Promise((resolve, reject) => source.close(error => error ? reject(error) : resolve())))
  await once(source, 'listening')
  return 'http://127.0.0.1:' + source.address().port
}

function post(root, endpoint, value) {
  return fetch(root + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value) })
}

test('校历过期回退的日期范围与两校房间开通不同步', async t => {
  const root = await listen(t)
  const source = await fetch(root + '/school/calendars?school=W')
  assert.equal(source.headers.get('x-sync-key'), 'W1')
  assert.match(await source.text(), /Australia\/Melbourne/)
  await post(root, '/lab?stage=local-change')
  assert.equal((await fetch(root + '/school/calendars?school=W&since=W1')).status, 410)
  assert.equal((await fetch(root + '/school/calendars?school=W')).headers.get('x-scope'), '2026-11-20/2026-11-21')
  assert.deepEqual((await (await fetch(root + '/calling/offers')).json()).map(row => row.state), ['open','closed'])
})
