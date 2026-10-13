import assert from 'node:assert/strict'
import { createServer, type Server as NetServer, type Socket } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createFtpAdapter } from './ftpAdapter.ts'
import { downloadEntryToCache } from '../networkCache.ts'
import { buildNetworkEntryId } from '../networkPath.ts'
import type { NetworkSourceProfile } from '../../../shared/networkSources.ts'

const FLAC_BYTES = Buffer.from('FTP-DATA-0123456789')
const LARGE_BYTES = Buffer.alloc(2 * 1024 * 1024, 71)
const USERNAME = 'alice'
const PASSWORD = 's3cret'

const LISTING = [
  'drwxr-xr-x 1 owner group 0 Jan 01 2025 album',
  '-rw-r--r-- 1 owner group 22 Jan 01 2025 a.flac'
].join('\r\n')

function makeProfile(
  port: number,
  overrides: Partial<NetworkSourceProfile> = {}
): NetworkSourceProfile {
  return {
    id: 'ftp1',
    protocol: 'ftp',
    name: 'FTP NAS',
    host: '127.0.0.1',
    port,
    rootPath: '/',
    username: USERNAME,
    credential: { kind: 'password', encryptedId: 'enc:x' },
    options: {
      readOnly: true,
      connectTimeoutMs: 5_000,
      transferTimeoutMs: 10_000,
      maxConcurrentTransfers: 2
    },
    bookmarks: [],
    createdAt: 1,
    lastConnectedAt: null,
    ...overrides
  }
}

interface TestFtpServer {
  port: number
  close: () => Promise<void>
}

async function startFtpServer(): Promise<TestFtpServer> {
  let dataSocket: Socket | null = null
  let dataServer: NetServer | null = null
  const controlSockets = new Set<Socket>()
  const dataSockets = new Set<Socket>()
  const servers = new Set<NetServer>()

  const control = createServer((socket) => {
    socket.setEncoding('utf8')
    controlSockets.add(socket)
    socket.on('close', () => controlSockets.delete(socket))
    socket.on('error', () => undefined)
    socket.write('220 test ftp ready\r\n')
    let buffer = ''
    let restartAt = 0

    function reply(line: string): void {
      socket.write(`${line}\r\n`)
    }

    function openPassive(replyPrefix: string): void {
      dataServer = createServer((data) => {
        dataSockets.add(data)
        data.once('close', () => dataSockets.delete(data))
        data.on('error', () => undefined)
        dataSocket = data
      })
      servers.add(dataServer)
      dataServer.on('error', () => undefined)
      dataServer.listen(0, '127.0.0.1', () => {
        const address = dataServer?.address()
        if (!address || typeof address === 'string') return
        if (replyPrefix === 'EPSV') {
          reply(`229 Entering Extended Passive Mode (|||${address.port}|)`)
        } else {
          const p1 = Math.floor(address.port / 256)
          const p2 = address.port % 256
          reply(`227 Entering Passive Mode (127,0,0,1,${p1},${p2})`)
        }
      })
    }

    async function withData(
      fn: (socket: Socket) => void,
      completion = '226 transfer complete'
    ): Promise<void> {
      reply('150 opening data connection')
      if (!dataSocket) {
        const deadline = Date.now() + 1000
        while (!dataSocket && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      }
      if (!dataSocket) {
        reply('425 cannot open data connection')
        return
      }
      const target = dataSocket
      dataSocket = null
      try {
        fn(target)
      } finally {
        // 等客户端挂好数据读取器再关闭，避免竞态丢数据。
        await new Promise((resolve) => setTimeout(resolve, 150))
        target.end()
        dataServer?.close()
        dataServer = null
      }
      reply(completion)
    }

    socket.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split('\r\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const [command, ...args] = line.trim().split(' ')
        const argument = args.join(' ')
        switch (command.toUpperCase()) {
          case 'USER':
            reply('331 password required')
            break
          case 'PASS':
            reply(argument === PASSWORD ? '230 logged in' : '530 login incorrect')
            break
          case 'REST':
            restartAt = Number(argument) || 0
            reply(`350 Restarting at ${restartAt}`)
            break
          case 'TYPE':
            reply('200 type set')
            break
          case 'OPTS':
            reply('200 ok')
            break
          case 'SYST':
            reply('215 UNIX Type: L8')
            break
          case 'FEAT':
            reply('211-features')
            reply('211 end')
            break
          case 'PWD':
            reply('257 "/"')
            break
          case 'CWD':
            reply('250 ok')
            break
          case 'PASV':
            openPassive('PASV')
            break
          case 'EPSV':
            openPassive('EPSV')
            break
          case 'LIST':
            void withData((socket) => socket.write(LISTING))
            break
          case 'RETR':
            if (
              argument.endsWith('a.flac') ||
              argument.endsWith('large.flac') ||
              argument.endsWith('late-error.flac')
            ) {
              const offset = restartAt
              restartAt = 0
              void withData(
                (socket) =>
                  socket.write(
                    (argument.endsWith('large.flac') ? LARGE_BYTES : FLAC_BYTES).subarray(offset)
                  ),
                argument.endsWith('late-error.flac')
                  ? '550 transfer failed'
                  : '226 transfer complete'
              )
            } else {
              reply('550 no such file')
            }
            break
          case 'SIZE':
            reply(argument.endsWith('a.flac') ? `213 ${FLAC_BYTES.length}` : '550 no such file')
            break
          case 'NOOP':
            reply('200 ok')
            break
          case 'QUIT':
            reply('221 bye')
            socket.end()
            break
          default:
            reply('500 unknown command')
        }
      }
    })
  })

  await new Promise<void>((resolve) => control.listen(0, '127.0.0.1', resolve))
  servers.add(control)
  const port = (control.address() as { port: number }).port
  return {
    port,
    close: async () => {
      for (const socket of controlSockets) socket.destroy()
      for (const socket of dataSockets) socket.destroy()
      dataSocket?.destroy()
      for (const server of servers) {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    }
  }
}

let server: TestFtpServer

test.before(async () => {
  server = await startFtpServer()
})

test.after(async () => {
  await server.close()
})

test('ftp list parses directory and audio entries with stable ids', async () => {
  const session = await createFtpAdapter().createSession(makeProfile(server.port), {
    kind: 'password',
    username: USERNAME,
    password: PASSWORD
  })
  const entries = await session.list('/')
  assert.equal(entries.length, 2)
  const album = entries.find((entry) => entry.name === 'album')
  const track = entries.find((entry) => entry.name === 'a.flac')
  assert.ok(album)
  assert.ok(track)
  assert.equal(album.kind, 'directory')
  assert.equal(track.kind, 'audio')
  assert.equal(track.path, '/a.flac')
  assert.match(track.id, /^[0-9a-f]{64}$/)
  await session.close()
})

test('ftp readStream downloads file bytes', async () => {
  const session = await createFtpAdapter().createSession(makeProfile(server.port), {
    kind: 'password',
    username: USERNAME,
    password: PASSWORD
  })
  const stream = await session.readStream('/a.flac')
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  assert.deepEqual(Buffer.concat(chunks), FLAC_BYTES)
  await session.close()
})

test('FTP data EOF cannot hide a failed final control reply', { timeout: 2_000 }, async (t) => {
  const session = await createFtpAdapter().createSession(makeProfile(server.port), {
    kind: 'password',
    username: USERNAME,
    password: PASSWORD
  })
  t.after(() => session.close())
  const stream = await session.readStream('/late-error.flac')
  await assert.rejects(
    async () => {
      for await (const _chunk of stream) {
        /* drain */
      }
    },
    { code: 'notFound' }
  )
})

test('ftp stat resolves size for files and rejects missing paths', async () => {
  const session = await createFtpAdapter().createSession(makeProfile(server.port), {
    kind: 'password',
    username: USERNAME,
    password: PASSWORD
  })
  const entry = await session.stat('/a.flac')
  assert.equal(entry?.name, 'a.flac')
  assert.equal(entry?.sizeBytes, FLAC_BYTES.length)
  await assert.rejects(
    async () => session.stat('/missing.flac'),
    (err: unknown) => {
      assert.equal((err as { code: string }).code, 'notFound')
      return true
    }
  )
  await session.close()
})

test('ftp rejects wrong credentials with auth error and never allows direct urls', async () => {
  const bad = await createFtpAdapter().createSession(makeProfile(server.port), {
    kind: 'password',
    username: USERNAME,
    password: 'wrong'
  })
  await assert.rejects(
    async () => bad.list('/'),
    (err: unknown) => {
      assert.equal((err as { code: string }).code, 'auth')
      return true
    }
  )
  await bad.close()

  const session = await createFtpAdapter().createSession(makeProfile(server.port), {
    kind: 'password',
    username: USERNAME,
    password: PASSWORD
  })
  assert.equal(await session.resolvePlaybackUrl('/a.flac'), null)
  await session.close()
})

test('ftp readStream honors a restart offset', async () => {
  const session = await createFtpAdapter().createSession(makeProfile(server.port), {
    kind: 'password',
    username: USERNAME,
    password: PASSWORD
  })
  const stream = await session.readStream('/a.flac', undefined, { start: 4 })
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  assert.deepEqual(Buffer.concat(chunks), FLAC_BYTES.subarray(4))
  await session.close()
})

test(
  'ftp exposes a large producer before completion and respects a slow consumer',
  { timeout: 5_000 },
  async (t) => {
    const session = await createFtpAdapter().createSession(makeProfile(server.port), {
      kind: 'password',
      username: USERNAME,
      password: PASSWORD
    })
    t.after(() => session.close())
    const stream = await session.readStream('/large.flac')
    let bytes = 0
    for await (const chunk of stream) {
      bytes += Buffer.byteLength(chunk)
      await new Promise((resolve) => setTimeout(resolve, 2))
      assert.ok((stream as import('node:stream').Readable).readableLength <= 128 * 1024)
    }
    assert.equal(bytes, LARGE_BYTES.length)
  }
)

test('ftp large files finish through the cache pipeline', { timeout: 5_000 }, async (t) => {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'ftp-large-cache-'))
  const session = await createFtpAdapter().createSession(makeProfile(server.port), {
    kind: 'password',
    username: USERNAME,
    password: PASSWORD
  })
  t.after(async () => {
    await session.close()
    await rm(cacheRoot, { recursive: true, force: true })
  })
  const path = await downloadEntryToCache({
    session,
    cacheRoot,
    entry: {
      id: buildNetworkEntryId('ftp', 'ftp1', '/large.flac'),
      profileId: 'ftp1',
      path: '/large.flac',
      name: 'large.flac',
      kind: 'audio',
      sizeBytes: LARGE_BYTES.length
    }
  })
  assert.deepEqual(await readFile(path), LARGE_BYTES)
})

test(
  'ftp cancellation stops a producer and a failed producer reaches its consumer',
  { timeout: 5_000 },
  async (t) => {
    const session = await createFtpAdapter().createSession(makeProfile(server.port), {
      kind: 'password',
      username: USERNAME,
      password: PASSWORD
    })
    t.after(() => session.close())
    const controller = new AbortController()
    const stream = await session.readStream('/large.flac', controller.signal)
    await assert.rejects(
      async () => {
        for await (const _chunk of stream) controller.abort()
      },
      { code: 'timeout' }
    )
    const missing = await session.readStream('/missing.flac')
    await assert.rejects(
      async () => {
        for await (const _chunk of missing) {
          /* drain */
        }
      },
      { code: 'notFound' }
    )
  }
)

test(
  'ftp cancellation interrupts connection setup before greeting',
  { timeout: 2_000 },
  async (t) => {
    const sockets = new Set<Socket>()
    const stalled = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    await new Promise<void>((resolve) => stalled.listen(0, '127.0.0.1', resolve))
    t.after(async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => stalled.close(() => resolve()))
    })
    const session = await createFtpAdapter().createSession(
      makeProfile((stalled.address() as { port: number }).port),
      {
        kind: 'anonymous'
      }
    )
    t.after(() => session.close())
    const controller = new AbortController()
    const stream = await session.readStream('/a.flac', controller.signal)
    setTimeout(() => controller.abort(), 30)
    await assert.rejects(
      async () => {
        for await (const _chunk of stream) {
          /* drain */
        }
      },
      { code: 'timeout' }
    )
  }
)

test(
  "cancelling a queued FTP reader does not close another reader's connection",
  { timeout: 5_000 },
  async (t) => {
    const session = await createFtpAdapter().createSession(makeProfile(server.port), {
      kind: 'password',
      username: USERNAME,
      password: PASSWORD
    })
    t.after(() => session.close())
    const first = await session.readStream('/large.flac')
    const controller = new AbortController()
    const queued = await session.readStream('/a.flac', controller.signal)
    const cancelled = assert.rejects(
      async () => {
        for await (const _chunk of queued) {
          /* drain */
        }
      },
      { code: 'timeout' }
    )
    let received = 0
    for await (const chunk of first) {
      received += Buffer.byteLength(chunk)
      controller.abort()
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    await cancelled
    assert.equal(received, LARGE_BYTES.length)
  }
)
