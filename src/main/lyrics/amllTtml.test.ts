import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AMLL_TTML_MAX_BYTES,
  clearAmlTtmlCache,
  fetchAmlTtml,
  normalizeAmlSongId
} from './amllTtml.ts'

const fixture =
  '<tt xmlns="http://www.w3.org/ns/ttml"><body><p begin="00:01.00">fixture</p></body></tt>'

test('AMLL service validates positive integer IDs', () => {
  assert.equal(normalizeAmlSongId(123), 123)
  assert.throws(() => normalizeAmlSongId(0))
  assert.throws(() => normalizeAmlSongId(1.5))
  assert.throws(() => normalizeAmlSongId('1e3'))
})

test('AMLL does not start a network request for an already cancelled lyric load', async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  await assert.rejects(
    fetchAmlTtml(99999, {
      signal: controller.signal,
      fetchImpl: async () => {
        calls++
        return new Response(fixture)
      }
    })
  )
  assert.equal(calls, 0)
})

test('AMLL service falls back from the mirror and caches successful responses', async () => {
  clearAmlTtmlCache()
  const urls: string[] = []
  const fetchImpl: typeof fetch = async (url) => {
    urls.push(String(url))
    if (urls.length === 1) return new Response('', { status: 404 })
    return new Response(fixture, { status: 200 })
  }
  assert.equal(await fetchAmlTtml(987654, { fetchImpl }), fixture)
  assert.equal(await fetchAmlTtml(987654, { fetchImpl }), fixture)
  assert.equal(urls.length, 2)
  assert.match(urls[0], /amll-ttml-db\.stevexmh\.net\/ncm\/987654$/)
  assert.match(urls[1], /ncm-lyrics\/987654\.ttml$/)
})

test('AMLL service falls back to jsDelivr when the mirror misses and GitHub is rate limited', async () => {
  clearAmlTtmlCache()
  const urls: string[] = []
  const fetchImpl: typeof fetch = async (url) => {
    urls.push(String(url))
    if (urls.length === 1) return new Response('', { status: 404 })
    if (urls.length === 2) return new Response('', { status: 429 })
    return new Response(fixture, {
      status: 200,
      headers: { 'content-type': 'application/ttml+xml' }
    })
  }

  assert.equal(await fetchAmlTtml(987655, { fetchImpl }), fixture)
  assert.equal(urls.length, 3)
  assert.match(urls[2], /^https:\/\/cdn\.jsdelivr\.net\/gh\/amll-dev\/amll-ttml-db@main\//)
  assert.match(urls[2], /ncm-lyrics\/987655\.ttml$/)
})

test('AMLL service rejects unsafe XML and oversized payloads', async () => {
  clearAmlTtmlCache()
  const unsafe: typeof fetch = async () => new Response('<!DOCTYPE tt><tt />', { status: 200 })
  await assert.rejects(() => fetchAmlTtml(123001, { fetchImpl: unsafe }))
  const oversized: typeof fetch = async () =>
    new Response('x', {
      status: 200,
      headers: { 'content-length': String(AMLL_TTML_MAX_BYTES + 1) }
    })
  await assert.rejects(() => fetchAmlTtml(123002, { fetchImpl: oversized }))
})
