import assert from 'node:assert/strict'
import test from 'node:test'
import { MetadataHttp } from './metadataHttp.ts'

const ENDPOINT = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
const post = (body: string, signal?: AbortSignal): RequestInit => ({ method: 'POST', body, signal })

test('metadata HTTP shares identical QQ POSTs but never joins different search bodies', async () => {
  const seen: string[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const http = new MetadataHttp(async (_input, init) => {
    seen.push(String(init!.body))
    await gate
    return new Response(String(init!.body))
  }, 0)
  const one = http.fetch(ENDPOINT, post('{"query":"one"}'))
  const same = http.fetch(ENDPOINT, post('{"query":"one"}'))
  const other = http.fetch(ENDPOINT, post('{"query":"two"}'))
  release()
  assert.deepEqual(
    await Promise.all([one, same, other].map(async (response) => (await response).text())),
    ['{"query":"one"}', '{"query":"one"}', '{"query":"two"}']
  )
  assert.deepEqual(seen, ['{"query":"one"}', '{"query":"two"}'])
})

test('QQ public exit accepts only the exact bounded POST endpoint', async () => {
  let calls = 0
  const http = new MetadataHttp(async () => {
    calls++
    return new Response('{}')
  }, 0)
  const invalid: Array<[string, RequestInit]> = [
    ['http://u.y.qq.com/cgi-bin/musicu.fcg', post('{}')],
    ['https://u.y.qq.com/other', post('{}')],
    [ENDPOINT + '?other=1', post('{}')],
    [ENDPOINT + '#x', post('{}')],
    ['https://user:password@u.y.qq.com/cgi-bin/musicu.fcg', post('{}')],
    ['https://u.y.qq.com:444/cgi-bin/musicu.fcg', post('{}')],
    ['https://evil.example/cgi-bin/musicu.fcg', post('{}')],
    [ENDPOINT, {}],
    [ENDPOINT, { method: 'GET' }],
    [ENDPOINT, { method: 'PUT', body: '{}' }],
    [ENDPOINT, { method: 'POST', body: new Uint8Array([1]) }],
    [ENDPOINT, post('x'.repeat(32769))],
    ['https://musicbrainz.org/ws/2/artist', post('{}')]
  ]
  for (const [url, init] of invalid) await assert.rejects(http.fetch(url, init), /Unsupported/)
  assert.equal(calls, 0)
  await http.fetch(ENDPOINT, post('{}'))
  assert.equal(calls, 1)
})

test('QQ 429/503 cool-down holds the next source request and cancellation removes it', async () => {
  for (const status of [429, 503]) {
    let calls = 0,
      now = 1000
    const http = new MetadataHttp(
      async () => {
        calls++
        return new Response('{}', { status, headers: { 'retry-after': '60' } })
      },
      0,
      () => now
    )
    await http.fetch(ENDPOINT, post('first'))
    const controller = new AbortController()
    const waiting = http.fetch(ENDPOINT, post('waiting', controller.signal))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls, 1)
    controller.abort(new Error('Cancelled source wait'))
    await assert.rejects(waiting, /Cancelled source wait/)
    now = 61000
    await http.fetch(ENDPOINT, post('after-cooldown'))
    assert.equal(calls, 2)
  }
})

test('one cancelled QQ consumer cannot cancel another subscriber to the same request', async () => {
  let finish!: () => void,
    calls = 0
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  const http = new MetadataHttp(async (_input, init) => {
    calls++
    await pending
    init!.signal!.throwIfAborted()
    return new Response('shared')
  }, 0)
  const controller = new AbortController()
  const abandoned = http.fetch(ENDPOINT, post('same', controller.signal))
  const survivor = http.fetch(ENDPOINT, post('same'))
  controller.abort(new Error('Window closed'))
  await assert.rejects(abandoned, /Window closed/)
  finish()
  assert.equal(await (await survivor).text(), 'shared')
  assert.equal(calls, 1)
})
