import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { gzipSync } from 'node:zlib'
import { readBoundedResponseBody } from './boundedResponseBody.ts'

const { searchRadioBrowserStations } = (await import(
  new URL('./radioBrowserClient.ts', import.meta.url).href
)) as typeof import('./radioBrowserClient')

test('searchRadioBrowserStations maps directory rows and skips broken urls', async () => {
  const rows = [
    {
      stationuuid: 'uuid-1',
      name: '  Jazz FM ',
      url: 'http://stream.example/jazz',
      url_resolved: 'https://cdn.example/jazz',
      homepage: 'https://jazz.example',
      favicon: 'https://jazz.example/icon.png',
      tags: 'jazz,smooth',
      countrycode: 'US',
      bitrate: 128,
      codec: 'MP3',
      votes: 42
    },
    {
      stationuuid: 'uuid-2',
      name: 'Broken',
      url: 'ftp://nope',
      url_resolved: '',
      tags: ''
    }
  ]
  const result = await searchRadioBrowserStations({
    query: 'jazz',
    fetchJson: async () => rows
  })
  assert.equal(result.length, 1)
  assert.equal(result[0].name, 'Jazz FM')
  assert.equal(result[0].urlResolved, 'https://cdn.example/jazz')
  assert.deepEqual(result[0].tags, ['jazz', 'smooth'])
  assert.equal(result[0].countryCode, 'US')
})

test('searchRadioBrowserStations returns empty for blank query', async () => {
  const result = await searchRadioBrowserStations({
    query: '   ',
    fetchJson: async () => {
      throw new Error('should not fetch')
    }
  })
  assert.deepEqual(result, [])
})

test('searchRadioBrowserStations tries next mirror after failure', async () => {
  let calls = 0
  const result = await searchRadioBrowserStations({
    query: 'news',
    fetchJson: async () => {
      calls += 1
      if (calls === 1) throw new Error('mirror down')
      return [
        {
          stationuuid: 'u',
          name: 'News',
          url: 'https://news.example/live',
          url_resolved: 'https://news.example/live',
          tags: ''
        }
      ]
    }
  })
  assert.equal(calls, 2)
  assert.equal(result[0].name, 'News')
})

test(
  'radio directory aborts an oversized chunked response during receipt',
  { timeout: 3_000 },
  async (t) => {
    let sent = 0
    const server = createServer((_req, res) => {
      const chunk = Buffer.alloc(64 * 1024, 32)
      const timer = setInterval(() => {
        sent += chunk.length
        res.write(chunk)
        if (sent >= 4 * 1024 * 1024) {
          clearInterval(timer)
          res.end()
        }
      }, 1)
      res.once('close', () => clearInterval(timer))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.after(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    const port = (server.address() as { port: number }).port
    await assert.rejects(
      searchRadioBrowserStations({ query: 'test', baseUrl: `http://127.0.0.1:${port}` }),
      /response is too large/
    )
    assert.ok(sent < 4 * 1024 * 1024)
  }
)

test('bounded HTTP body counts decoded bytes and cancels before accepting an excessive chunk', async () => {
  let reads = 0
  let cancelled = false
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1
        controller.enqueue(new Uint8Array(64))
      },
      cancel() {
        cancelled = true
      }
    })
  )
  await assert.rejects(readBoundedResponseBody(response, 128, 'oversized'), /oversized/)
  assert.equal(cancelled, true)
  assert.ok(reads <= 4, 'at most one stream-prefetched chunk beyond the rejecting chunk')
})

test(
  'a small compressed directory response cannot evade the decoded body limit',
  { timeout: 3_000 },
  async (t) => {
    const compressed = gzipSync(Buffer.alloc(3 * 1024 * 1024, 32))
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': compressed.length })
      res.end(compressed)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.after(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    await assert.rejects(
      searchRadioBrowserStations({
        query: 'test',
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`
      }),
      /response is too large/
    )
  }
)
