import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createServer, type RequestListener } from 'node:http'
import test from 'node:test'
import { createDlnaAdapter, type DlnaTransport } from './dlnaAdapter.ts'
import type { NetworkSourceProfile } from '../../../shared/networkSources.ts'

const DESC_XML = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <friendlyName>Test Media Server</friendlyName>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType>
        <controlURL>/upnp/control/content_directory</controlURL>
      </service>
    </serviceList>
  </device>
</root>`

function didl(result: string): string {
  return `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body>
<u:BrowseResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">
<Result>${result.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</Result>
</u:BrowseResponse>
</s:Body>
</s:Envelope>`
}

const DIRECT_CHILDREN = didl(
  `<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">
<container id="1" parentID="0" restricted="1"><dc:title>Music</dc:title><upnp:class>object.container.storageFolder</upnp:class></container>
<item id="2" parentID="0" restricted="1"><dc:title>Song</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class><res>http://127.0.0.1:9000/music/a.flac</res></item>
</DIDL-Lite>`
)

const METADATA = didl(
  `<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">
<item id="2" parentID="0" restricted="1"><dc:title>Song</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class><res>http://127.0.0.1:9000/music/a.flac</res></item>
</DIDL-Lite>`
)

const FLAC_BYTES = Buffer.from('DLNA-DATA')

function makeProfile(overrides: Partial<NetworkSourceProfile> = {}): NetworkSourceProfile {
  return {
    id: 'dlna1',
    protocol: 'dlna',
    name: 'DLNA Server',
    host: '127.0.0.1',
    port: 9000,
    rootPath: '/',
    credential: { kind: 'anonymous', encryptedId: '' },
    options: {
      readOnly: true,
      connectTimeoutMs: 5_000,
      transferTimeoutMs: 30_000,
      maxConcurrentTransfers: 2
    },
    bookmarks: [],
    createdAt: 1,
    lastConnectedAt: null,
    ...overrides
  }
}

function makeTransport(
  overrides: {
    browseDirectChildren?: string
    browseMetadata?: string
    authFail?: boolean
  } = {}
): DlnaTransport & { posts: Array<{ soapAction: string; body: string }> } {
  const posts: Array<{ soapAction: string; body: string }> = []
  const transport: DlnaTransport = {
    async get(_url) {
      if (overrides.authFail) return { status: 401, body: Buffer.from('unauthorized') }
      if (_url.includes('/rootDesc.xml') || _url === 'http://127.0.0.1:9000/') {
        return { status: 200, body: Buffer.from(DESC_XML) }
      }
      return { status: 200, body: FLAC_BYTES }
    },
    async post(_url, soapAction, body) {
      posts.push({ soapAction, body })
      if (overrides.authFail) return { status: 401, body: Buffer.from('unauthorized') }
      if (soapAction.includes('Browse') && body.includes('BrowseMetadata')) {
        return { status: 200, body: Buffer.from(overrides.browseMetadata ?? METADATA) }
      }
      return { status: 200, body: Buffer.from(overrides.browseDirectChildren ?? DIRECT_CHILDREN) }
    }
  }
  return Object.assign(transport, { posts })
}

test('dlna list browses ContentDirectory and maps containers and audio items', async () => {
  const transport = makeTransport()
  const adapter = createDlnaAdapter({ transport, descriptionPaths: ['/rootDesc.xml'] })
  const session = await adapter.createSession(makeProfile(), { kind: 'anonymous' })
  const entries = await session.list('/')
  assert.equal(entries.length, 2)
  const music = entries.find((entry) => entry.name === 'Music')
  const song = entries.find((entry) => entry.name === 'Song')
  assert.ok(music)
  assert.ok(song)
  assert.equal(music.kind, 'directory')
  assert.equal(song.kind, 'audio')
  assert.equal(song.path, '/2')
  assert.match(transport.posts[0].soapAction, /ContentDirectory:1#Browse/)
  assert.ok(transport.posts[0].body.includes('BrowseDirectChildren'))
  assert.ok(transport.posts[0].body.includes('ObjectID'))
  await session.close()
})

test('dlna resolvePlaybackUrl returns the item res url via BrowseMetadata', async () => {
  const transport = makeTransport()
  const adapter = createDlnaAdapter({ transport, descriptionPaths: ['/rootDesc.xml'] })
  const session = await adapter.createSession(makeProfile(), { kind: 'anonymous' })
  const url = await session.resolvePlaybackUrl('/2')
  assert.equal(url, 'http://127.0.0.1:9000/music/a.flac')
  assert.ok(transport.posts[0].body.includes('BrowseMetadata'))
  await session.close()
})

test('dlna readStream downloads the item res url', async () => {
  const transport = makeTransport()
  const adapter = createDlnaAdapter({ transport, descriptionPaths: ['/rootDesc.xml'] })
  const session = await adapter.createSession(makeProfile(), { kind: 'anonymous' })
  const stream = await session.readStream('/2')
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  assert.deepEqual(Buffer.concat(chunks), FLAC_BYTES)
  await session.close()
})

test('dlna surfaces device description failures as network errors', async () => {
  const adapter = createDlnaAdapter({
    transport: makeTransport({ authFail: true }),
    descriptionPaths: ['/rootDesc.xml']
  })
  const session = await adapter.createSession(makeProfile(), { kind: 'anonymous' })
  await assert.rejects(
    async () => session.list('/'),
    (err: unknown) => {
      assert.equal((err as { code: string }).code, 'network')
      return true
    }
  )
})

test('dlna transport readStream returns a stream from the body buffer', async () => {
  const transport = makeTransport()
  const adapter = createDlnaAdapter({ transport, descriptionPaths: ['/rootDesc.xml'] })
  const session = await adapter.createSession(makeProfile(), { kind: 'anonymous' })
  const stream = await session.readStream('/2')
  assert.ok(stream instanceof Readable)
  await session.close()
})

async function loopback(
  t: import('node:test').TestContext,
  handler: RequestListener
): Promise<number> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return (server.address() as { port: number }).port
}

test(
  'production DLNA media is exposed at headers and cancellation closes upstream early',
  { timeout: 3_000 },
  async (t) => {
    let port = 0
    let sent = 0
    let ended = false
    let mediaClosed: () => void = () => undefined
    const closed = new Promise<void>((resolve) => {
      mediaClosed = resolve
    })
    port = await loopback(t, (req, res) => {
      if (req.url === '/rootDesc.xml') {
        res.end(DESC_XML)
        return
      }
      if (req.method === 'POST') {
        res.end(METADATA.replaceAll('9000', String(port)))
        return
      }
      const chunk = Buffer.alloc(64 * 1024, 61)
      res.write(chunk)
      sent += chunk.length
      const timer = setInterval(() => {
        res.write(chunk)
        sent += chunk.length
        if (sent >= 2 * 1024 * 1024) {
          ended = true
          res.end()
          clearInterval(timer)
        }
      }, 10)
      res.once('close', () => {
        clearInterval(timer)
        mediaClosed()
      })
    })
    const session = await createDlnaAdapter({ descriptionPaths: ['/rootDesc.xml'] }).createSession(
      makeProfile({ port }),
      { kind: 'anonymous' }
    )
    t.after(() => session.close())
    const controller = new AbortController()
    const stream = await session.readStream('/2', controller.signal)
    assert.equal(ended, false)
    await assert.rejects(async () => {
      for await (const _chunk of stream) controller.abort()
    })
    await closed
    assert.ok(sent < 2 * 1024 * 1024)
  }
)

test(
  'production DLNA XML has a total deadline even if a server trickles bytes',
  { timeout: 2_000 },
  async (t) => {
    const port = await loopback(t, (_req, res) => {
      res.write('<root>')
      const timer = setInterval(() => res.write(' '), 5)
      res.once('close', () => clearInterval(timer))
    })
    const profile = makeProfile({ port })
    profile.options.transferTimeoutMs = 40
    const session = await createDlnaAdapter({ descriptionPaths: ['/rootDesc.xml'] }).createSession(
      profile,
      { kind: 'anonymous' }
    )
    t.after(() => session.close())
    await assert.rejects(session.list('/'), { code: 'network' })
  }
)

test('production DLNA rejects oversized XML during receipt', { timeout: 3_000 }, async (t) => {
  let sent = 0
  const port = await loopback(t, (_req, res) => {
    const chunk = Buffer.alloc(64 * 1024, 65)
    const timer = setInterval(() => {
      sent += chunk.length
      res.write(chunk)
      if (sent >= 8 * 1024 * 1024) {
        clearInterval(timer)
        res.end()
      }
    }, 1)
    res.once('close', () => clearInterval(timer))
  })
  const session = await createDlnaAdapter({ descriptionPaths: ['/rootDesc.xml'] }).createSession(
    makeProfile({ port }),
    { kind: 'anonymous' }
  )
  t.after(() => session.close())
  await assert.rejects(session.list('/'), { code: 'network' })
  assert.ok(sent < 8 * 1024 * 1024)
})

test(
  'DLNA close interrupts media and an idle media body reaches its deadline',
  { timeout: 2_000 },
  async (t) => {
    let port = 0
    port = await loopback(t, (req, res) => {
      if (req.url === '/rootDesc.xml') {
        res.end(DESC_XML)
        return
      }
      if (req.method === 'POST') {
        res.end(METADATA.replaceAll('9000', String(port)))
        return
      }
      res.write('first chunk')
    })
    const profile = makeProfile({ port })
    profile.options.transferTimeoutMs = 40
    for (const close of [false, true]) {
      const session = await createDlnaAdapter({
        descriptionPaths: ['/rootDesc.xml']
      }).createSession(profile, { kind: 'anonymous' })
      t.after(() => session.close())
      const stream = await session.readStream('/2')
      await assert.rejects(async () => {
        for await (const _chunk of stream) {
          if (close) await session.close()
        }
      })
    }
  }
)

test('DLNA paginates bounded Browse requests without requesting the whole directory', async () => {
  const transport = makeTransport()
  const requests: string[] = []
  transport.post = async (_url, _action, body) => {
    requests.push(body)
    const start = Number(/<StartingIndex>(\d+)<\/StartingIndex>/.exec(body)?.[1])
    const count = start === 0 ? 2 : 1
    const items = Array.from(
      { length: count },
      (_v, index) => `<item id="${start + index + 1}"><dc:title>Song</dc:title></item>`
    ).join('')
    return {
      status: 200,
      body: Buffer.from(didl(items).replace('</Result>', '</Result><TotalMatches>3</TotalMatches>'))
    }
  }
  const session = await createDlnaAdapter({ transport }).createSession(makeProfile(), {
    kind: 'anonymous'
  })
  assert.equal((await session.list('/')).length, 3)
  assert.equal(requests.length, 2)
  assert.ok(requests.every((body) => body.includes('<RequestedCount>250</RequestedCount>')))
  assert.ok(requests[1].includes('<StartingIndex>2</StartingIndex>'))
  await session.close()
})

test(
  'production DLNA requires a matching byte range for resumed media',
  { timeout: 2_000 },
  async (t) => {
    let port = 0
    let ignoredRange = false
    port = await loopback(t, (req, res) => {
      if (req.url === '/rootDesc.xml') {
        res.end(DESC_XML)
        return
      }
      if (req.method === 'POST') {
        res.end(METADATA.replaceAll('9000', String(port)))
        return
      }
      assert.equal(req.headers.range, 'bytes=4-')
      if (ignoredRange) {
        res.end(FLAC_BYTES)
        return
      }
      res.writeHead(206, {
        'Content-Range': `bytes 4-${FLAC_BYTES.length - 1}/${FLAC_BYTES.length}`
      })
      res.end(FLAC_BYTES.subarray(4))
    })
    const session = await createDlnaAdapter({ descriptionPaths: ['/rootDesc.xml'] }).createSession(
      makeProfile({ port }),
      { kind: 'anonymous' }
    )
    t.after(() => session.close())
    const chunks: Buffer[] = []
    for await (const chunk of await session.readStream('/2', undefined, { start: 4 }))
      chunks.push(Buffer.from(chunk))
    assert.deepEqual(Buffer.concat(chunks), FLAC_BYTES.subarray(4))
    ignoredRange = true
    await assert.rejects(session.readStream('/2', undefined, { start: 4 }), /未确认续传范围/)
  }
)

test(
  'production DLNA stops waiting for media headers at the connection deadline',
  { timeout: 2_000 },
  async (t) => {
    let port = 0
    port = await loopback(t, (req, res) => {
      if (req.url === '/rootDesc.xml') {
        res.end(DESC_XML)
        return
      }
      if (req.method === 'POST') res.end(METADATA.replaceAll('9000', String(port)))
    })
    const profile = makeProfile({ port })
    profile.options.connectTimeoutMs = 40
    const session = await createDlnaAdapter({ descriptionPaths: ['/rootDesc.xml'] }).createSession(
      profile,
      { kind: 'anonymous' }
    )
    t.after(() => session.close())
    await assert.rejects(session.readStream('/2'), { code: 'timeout' })
  }
)
