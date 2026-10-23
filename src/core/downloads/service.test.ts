import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import {
  ProviderDownloadManager,
  type ProviderDownloadManagerOptions
} from './providerDownloadManager.ts'
import { CoreDownloadsService } from './service.ts'
import { createDownloadMetadataPreparation } from './metadataService.ts'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
const track = {
  id: 'one',
  title: 'Song',
  artist: 'Artist',
  album: 'Album',
  privateUrl: 'https://secret.invalid/token'
}
const input = { providerId: 'fixture', quality: 'lossless' as const, track }
const ready = {
  jobId: 'private-job',
  status: 'ready',
  progress: 1,
  requestedQuality: 'lossless',
  fileName: 'song.wav'
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
async function until(check: () => boolean) {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(check(), 'task should reach its expected state')
}
function wave() {
  const bytes = Buffer.alloc(444)
  bytes.write('RIFF')
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(8000, 24)
  bytes.writeUInt32LE(16000, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(400, 40)
  return bytes
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'twilight-core-download-'))
  const library = join(root, 'library'),
    download = join(root, 'download')
  await mkdir(library)
  await mkdir(download)
  const server = createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/song' })
      res.end()
      return
    }
    res.setHeader('content-length', wave().length)
    res.end(wave())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/song`
  const calls: string[] = [],
    indexed: string[] = []
  const options: ProviderDownloadManagerOptions = {
    authorizedRoots: async () => ({ libraryRoots: [library], downloadRoot: download }),
    indexer: () => (path) => {
      indexed.push(path)
    },
    grant: async (path) => path,
    onChanged: () => {},
    pluginManager: {
      callProvider: async (_id, method, _args, invocation) => {
        calls.push(method)
        assert.ok(invocation?.signal)
        if (method === 'createDownload') return ready
        if (method === 'getDownloadFile')
          return { url, fileName: 'song.wav', fileSize: wave().length }
        if (method === 'getLyrics')
          return { lyrics: '[00:00.00]Song', translatedLyrics: '[00:00.00]歌曲' }
        return null
      }
    }
  }
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  })
  return { root, library, download, url, options, calls, indexed }
}

test('portable owner downloads real loopback audio, preserves tags/lyrics and serializes completed imports', async (t) => {
  const f = await fixture(t)
  const manager = new ProviderDownloadManager({
    ...f.options,
    getPreferences: () => ({ naming: 'title', embedMetadata: true, saveLyrics: true })
  })
  t.after(() => manager.shutdown())
  const task = await manager.create(input)
  await until(() => manager.get(task.id).status === 'completed')
  const complete = manager.get(task.id)
  assert.equal(complete.qualityVerified, true)
  assert.equal(complete.actualQuality, 'lossless')
  assert.ok(complete.targetPath?.startsWith(f.download))
  assert.equal(await readFile(join(f.download, 'Song.lrc'), 'utf8'), '[00:00.00]Song')
  const [first, second] = await Promise.all([
    manager.completedResult(task.id, true),
    manager.completedResult(task.id, true)
  ])
  assert.equal(first, second)
  assert.ok(first.startsWith(f.library))
  assert.equal((await readdir(f.library)).length, 1)
  assert.ok(f.indexed.includes(first))
  assert.deepEqual(f.calls, ['createDownload', 'getDownloadFile', 'getLyrics'])
  assert.deepEqual(
    (await readdir(f.download)).filter((name) => name.includes('.part')),
    []
  )
  // Existing files are not overwritten when another task chooses the same name.
  const next = await manager.create(input)
  await until(() => manager.get(next.id).status === 'completed')
  assert.notEqual(manager.get(next.id).targetPath, complete.targetPath)
})

test('provider/file policy and size errors leave no partial or published file', async (t) => {
  const f = await fixture(t)
  for (const delivery of [
    { url: 'https://127.0.0.1/audio' },
    { url: 'http://localhost/audio' },
    { url: f.url, fileSize: 4 * 1024 * 1024 * 1024 + 1 },
    { url: f.url, fileSize: wave().length - 1 },
    { url: f.url.replace('/song', '/redirect') }
  ]) {
    const manager = new ProviderDownloadManager({
      ...f.options,
      pluginManager: {
        callProvider: async (_id, method) =>
          method === 'createDownload' ? ready : { ...delivery, fileName: 'bad.wav' }
      }
    })
    const task = await manager.create(input)
    await until(() => manager.get(task.id).status === 'failed')
    await manager.shutdown()
  }
  assert.deepEqual(await readdir(f.download), [])
  const manager = new ProviderDownloadManager(f.options)
  await assert.rejects(manager.create({ ...input, targetRoot: f.root }), /已授权/)
  assert.deepEqual(f.calls, [])
  await manager.shutdown()
})

test('cancel joins the actual stream cleanup and shutdown joins an in-flight create without replaying it', async (t) => {
  const f = await fixture(t),
    entered = deferred<void>(),
    release = deferred<void>()
  const manager = new ProviderDownloadManager({
    ...f.options,
    fetch: async (_url, options) => {
      entered.resolve()
      await new Promise<void>((resolve) =>
        options?.signal?.addEventListener('abort', () => resolve(), { once: true })
      )
      await release.promise
      throw new Error('stream cancelled')
    }
  })
  const task = await manager.create(input)
  await entered.promise
  let joined = false
  const cancellation = manager.cancel(task.id).then(() => {
    joined = true
  })
  await tick()
  assert.equal(joined, false)
  release.resolve()
  await cancellation
  assert.equal(manager.get(task.id).status, 'cancelled')
  await manager.shutdown()
  assert.deepEqual(await readdir(f.download), [])

  const creating = deferred<void>(),
    createRelease = deferred<void>()
  let creates = 0
  const pending = new ProviderDownloadManager({
    ...f.options,
    pluginManager: {
      callProvider: async (_id, _method, _args, options) => {
        creates++
        creating.resolve()
        await new Promise<void>((resolve) =>
          options?.signal?.addEventListener('abort', () => resolve(), { once: true })
        )
        await createRelease.promise
        throw new Error('unknown create outcome')
      }
    }
  })
  const create = pending.create(input)
  const rejected = assert.rejects(create, /unknown create/)
  await creating.promise
  let stopped = false
  const shutdown = pending.shutdown().then(() => {
    stopped = true
  })
  await tick()
  assert.equal(stopped, false)
  createRelease.resolve()
  await rejected
  await shutdown
  assert.equal(creates, 1)
  assert.deepEqual(pending.list(), [])
  assert.throws(() => pending.create(input), /shutting down/)
})

test('public pages are bounded revision-fenced projections, not provider jobs or filesystem authorities', async (t) => {
  const f = await fixture(t)
  let changed = 0
  const service = new CoreDownloadsService({ ...f.options, changed: () => changed++ })
  t.after(() => service.shutdown())
  const first = await service.create(input),
    initial = service.state()
  await until(() => service.state().active === 0)
  assert.throws(() => service.page({ revision: initial.revision }), /changed/)
  const page = service.page({ revision: service.state().revision, offset: 0, limit: 1 })
  assert.equal(page.total, 1)
  assert.equal(page.items[0].id, first.id)
  assert.ok(changed > 0)
  assert.doesNotMatch(
    JSON.stringify(page),
    /providerJobId|private-job|targetPath|privateUrl|secret.invalid|download\\\\/
  )
  const playback = await service.playbackTrack(first.id)
  assert.equal(playback.source, 'local')
  assert.ok(playback.filePath.startsWith(f.download))
})

test('terminal retention stays at fifty, and failed creates have one explicit retry each', async (t) => {
  const f = await fixture(t)
  let writes = 0
  const manager = new ProviderDownloadManager({
    ...f.options,
    pluginManager: {
      callProvider: async () => {
        writes++
        return { ...ready, status: 'failed', error: 'failed' }
      }
    }
  })
  const first = await manager.create(input)
  await manager.retry(first.id)
  for (let i = 0; i < 60; i++) await manager.create(input)
  assert.equal(writes, 62)
  assert.equal(manager.list().length, 50)
  await manager.shutdown()
})

test('indexed and reveal use completed task authority and recheck revoked roots without exposing paths', async (t) => {
  const f = await fixture(t)
  const indexed: string[] = [], revealed: string[] = []
  let authorized = true
  const service = new CoreDownloadsService({
    ...f.options, changed() {},
    authorizedRoots: async () => ({ libraryRoots: [f.library], downloadRoot: authorized ? f.download : null }),
    indexed: async (path) => { indexed.push(path); return true },
    reveal: async (path) => { revealed.push(path) }
  })
  t.after(() => service.shutdown())
  await assert.rejects(service.reveal('missing'))
  assert.equal(revealed.length, 0)
  const task = await service.create(input)
  await until(() => service.state().active === 0)
  assert.deepEqual(await service.indexed(task.id), { indexed: true })
  assert.equal(await service.reveal(task.id), undefined)
  assert.equal(indexed.length, 1)
  assert.deepEqual(revealed, indexed)
  assert.ok(indexed[0].startsWith(f.download))
  authorized = false
  await assert.rejects(service.indexed(task.id), /目录已失效/)
  await assert.rejects(service.reveal(task.id), /目录已失效/)
  assert.equal(indexed.length, 1)
  assert.equal(revealed.length, 1)
})

test('metadata service adapter bounds provider fields and sends only controlled cover bytes to its worker', async () => {
  const prepare = createDownloadMetadataPreparation(async (path, request, signal) => {
    assert.equal(path, '/temporary.part')
    assert.equal(signal.aborted, false)
    assert.deepEqual(request.lyrics, { lyrics: 'Song' })
    assert.equal(request.cover?.base64, Buffer.from('cover').toString('base64'))
    assert.doesNotMatch(JSON.stringify(request), /privateUrl|secret.invalid/)
    return { actualQuality: 'lossless', warning: null, lyrics: [] }
  })
  await prepare({
    partPath: '/temporary.part',
    targetPath: '/song.wav',
    track: { ...track, cover: 'twilight-media://image/cover' },
    preferences: { naming: 'title', embedMetadata: true, saveLyrics: true },
    signal: new AbortController().signal,
    getLyrics: async () => ({
      lyrics: 'Song',
      translatedLyrics: 'x'.repeat(1024 * 1024 + 1),
      secret: 'private'
    }),
    fetchCover: async () => ({ bytes: Buffer.from('cover'), mime: 'image/jpeg' })
  })
})

test('unknown file size remains unknown, and rejected oversized responses release the actual body', async (t) => {
  const f = await fixture(t)
  let cancelled = false
  const manager = new ProviderDownloadManager({
    ...f.options,
    fetch: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true
          }
        }),
        { headers: { 'content-length': String(4 * 1024 * 1024 * 1024 + 1) } }
      ),
    pluginManager: {
      callProvider: async (_id, method) =>
        method === 'createDownload' ? ready : { url: f.url, fileName: 'size.wav' }
    }
  })
  const task = await manager.create(input)
  assert.equal(task.fileSize, null)
  assert.equal(task.queuePosition, null)
  await until(() => manager.get(task.id).status === 'failed')
  assert.equal(cancelled, true)
  await manager.shutdown()
  const unknown = new ProviderDownloadManager({
    ...f.options,
    pluginManager: {
      callProvider: async (_id, method) =>
        method === 'createDownload' ? ready : { url: f.url, fileName: 'size.wav' }
    }
  })
  const successful = await unknown.create(input)
  await until(() => unknown.get(successful.id).status === 'completed')
  assert.equal(unknown.get(successful.id).fileSize, wave().length)
  await unknown.shutdown()
})

test('download errors redact filesystem targets as well as provider URLs', async (t) => {
  const f = await fixture(t)
  const service = new CoreDownloadsService({
    ...f.options,
    changed: () => {},
    pluginManager: {
      callProvider: async () => ({
        ...ready,
        status: 'failed',
        error:
          "EACCES: copyfile 'D:\\Private downloads\\song.wav' to '/private/music/song.wav' https://signed.invalid/a?token=secret"
      })
    }
  })
  const task = await service.create(input)
  assert.doesNotMatch(task.error!, /Private downloads|private\/music|signed.invalid|token=secret/)
  await service.shutdown()
})

test('an unavailable legacy indexer rejects import before copying, while completed playback remains usable', async (t) => {
  const f = await fixture(t)
  const manager = new ProviderDownloadManager({ ...f.options, indexer: () => null })
  const task = await manager.create(input)
  await until(() => manager.get(task.id).status === 'completed')
  await assert.rejects(manager.completedResult(task.id, true), /尚未就绪/)
  assert.deepEqual(await readdir(f.library), [])
  assert.equal(await manager.completedResult(task.id), manager.get(task.id).targetPath)
  await manager.shutdown()
})
