import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { EventEmitter } from 'node:events'
import {
  CoreNcmCloudTransferService,
  type CoreNcmCloudTransferOptions
} from './cloudTransferService.ts'
import type { NcmCloudTransferProgress } from '../../shared/ncmCloud.ts'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fixture(t: TestContext, overrides: Partial<CoreNcmCloudTransferOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-core-cloud-'))
  const source = join(directory, 'Source.flac')
  const destination = join(directory, 'Target.flac')
  await writeFile(source, 'abc')
  let id = 0
  let now = 10
  const changes = new EventEmitter()
  const service = new CoreNcmCloudTransferService({
    chooseUploadFiles: async () => [source],
    chooseDownloadFile: async () => destination,
    callProvider: async <T>() => {
      throw new Error('Unexpected provider request') as T
    },
    now: () => now,
    newId: () => `id-${++id}`,
    changed: () => changes.emit('change'),
    fetch: async () => {
      throw new Error('Unexpected network request')
    },
    ...overrides
  })
  t.after(async () => {
    await service.shutdown()
    await rm(directory, { recursive: true, force: true })
  })
  const tasks = () => service.page({ revision: service.state().revision, limit: 200 }).items
  const finished = (transferId: string): Promise<NcmCloudTransferProgress> =>
    new Promise((resolve) => {
      const check = () => {
        const task = tasks().find((task) => task.transferId === transferId)
        if (!task || !['completed', 'failed', 'cancelled'].includes(task.stage)) return
        changes.off('change', check)
        resolve(task)
      }
      changes.on('change', check)
      check()
    })
  return {
    service,
    source,
    destination,
    directory,
    tasks,
    finished,
    now: (value: number) => {
      now = value
    }
  }
}

test(
  'selected-file authority stays client-bound, accepted upload survives window destruction',
  { timeout: 5000 },
  async (t) => {
    const started = deferred()
    const authorize = deferred()
    const calls: Array<{ method: string; args: unknown[]; key?: string }> = []
    const f = await fixture(t, {
      callProvider: async <T>(method, args, signal, key): Promise<T> => {
        calls.push({ method, args, key })
        if (method === 'prepareCloudUpload') {
          started.resolve()
          await authorize.promise
          assert.equal(signal?.aborted, false)
          return { needUpload: false, songId: 'song-7', resourceId: 'resource-7' } as T
        }
        return {} as T
      }
    })
    const [file] = await f.service.chooseUploadFiles('window-1')
    assert.deepEqual(file, { handle: 'id-1', name: 'Source.flac', size: 3, format: 'flac' })
    assert.throws(() => f.service.upload('window-2', file.handle), /凭证已失效/)
    const accepted = f.service.upload('window-1', file.handle)
    await started.promise
    assert.throws(() => f.service.upload('window-1', file.handle), /已有上传任务/)
    f.service.disconnect('window-1')
    authorize.resolve()
    assert.equal((await f.finished(accepted.transferId)).stage, 'completed')
    assert.equal(f.service.state().active, 0)
    assert.deepEqual(
      calls.map((call) => call.method),
      ['prepareCloudUpload', 'completeCloudUpload']
    )
    assert.equal((calls[0].args[0] as { md5: string }).md5, '900150983cd24fb0d6963f7d28e17f72')
    assert.equal(calls[1].key, accepted.transferId)
    assert.equal((calls[1].args[0] as { song: string }).song, 'Source')
    assert.throws(() => f.service.upload('window-1', file.handle), /凭证已失效/)
    const publicState = JSON.stringify(f.tasks())
    assert.equal(publicState.includes(f.source), false)
    assert.equal(publicState.includes('resource-7'), false)
  }
)

test('Core owns account-change cancellation and retires old upload grants without a renderer listener', async (t) => {
  const started = deferred()
  const f = await fixture(t, {
    callProvider: async <T>(_method, _args, signal): Promise<T> => {
      started.resolve()
      await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }))
      throw new Error('unreachable')
    }
  })
  await f.service.observeAccount(1)
  const [file] = await f.service.chooseUploadFiles('window')
  const upload = f.service.upload('window', file.handle)
  await started.promise
  f.service.disconnect('window')
  await f.service.observeAccount(2)
  assert.equal((await f.finished(upload.transferId)).stage, 'cancelled')
  assert.throws(() => f.service.upload('window', file.handle), /凭证已失效/)
})

test(
  'uncertain provider completion is retained as failed and never automatically replayed',
  { timeout: 5000 },
  async (t) => {
    let completes = 0
    const f = await fixture(t, {
      callProvider: async <T>(method): Promise<T> => {
        if (method === 'prepareCloudUpload')
          return { needUpload: false, songId: '9', resourceId: 'secret' } as T
        completes++
        throw new Error('Unknown result: C:\\Private\\song.flac token=private-secret')
      }
    })
    const [file] = await f.service.chooseUploadFiles('window')
    const task = f.service.upload('window', file.handle)
    const result = await f.finished(task.transferId)
    assert.equal(result.stage, 'failed')
    assert.equal(completes, 1)
    for (let i = 0; i < 5; i++) {
      f.service.disconnect(`window-${i}`)
      assert.equal(f.tasks()[0].stage, 'failed')
    }
    assert.equal(completes, 1)
    assert.equal(result.error?.includes('Private'), false)
    assert.equal(result.error?.includes('private-secret'), false)
  }
)

test(
  'accepted download survives request abort and commits over the chosen target without exposing URLs or paths',
  { timeout: 5000 },
  async (t) => {
    const fetching = deferred()
    const response = deferred()
    let gets = 0
    const f = await fixture(t, {
      callProvider: async <T>(method): Promise<T> => {
        assert.equal(method, 'getCloudDownloadUrl')
        gets++
        return 'https://cdn.example/song.flac?token=private' as T
      },
      fetch: async (_url, options) => {
        fetching.resolve()
        await response.promise
        assert.equal(options?.signal?.aborted, false)
        return new Response('new-audio', { headers: { 'content-length': '9' } })
      }
    })
    await writeFile(f.destination, 'original')
    const request = new AbortController()
    const accepted = await f.service.download(
      'window',
      { cloudSongId: '77', fileName: 'A/B.flac' },
      request.signal
    )
    await fetching.promise
    const oldRevision = f.service.state().revision
    await assert.rejects(
      f.service.download('other', { cloudSongId: '77', fileName: 'other.flac' }),
      /已有下载任务/
    )
    request.abort()
    f.service.disconnect('window')
    response.resolve()
    assert.equal((await f.finished(accepted.transferId)).stage, 'completed')
    assert.equal(await readFile(f.destination, 'utf8'), 'new-audio')
    assert.deepEqual((await readdir(f.directory)).sort(), ['Source.flac', 'Target.flac'])
    assert.equal(gets, 1)
    assert.throws(() => f.service.page({ revision: oldRevision }), { code: 'STALE_REVISION' })
    assert.equal(f.tasks()[0].fileName, 'A_B.flac')
    const projection = JSON.stringify(f.tasks())
    assert.equal(projection.includes(f.destination), false)
    assert.equal(projection.includes('cdn.example'), false)
    assert.equal(projection.includes('private'), false)
  }
)

test(
  'cancellation cleans partial downloads; Core shutdown waits for stream cancellation',
  { timeout: 5000 },
  async (t) => {
    const fetching = deferred()
    const cancelling = deferred()
    const closed = deferred()
    const f = await fixture(t, {
      callProvider: async <T>(): Promise<T> => 'https://cdn.example/song.flac' as T,
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]))
              fetching.resolve()
            },
            async cancel() {
              cancelling.resolve()
              await closed.promise
            }
          })
        )
    })
    await writeFile(f.destination, 'original')
    const accepted = await f.service.download('window', {
      cloudSongId: '77',
      fileName: 'song.flac'
    })
    await fetching.promise
    assert.equal(f.service.cancel(accepted.transferId, 'foreign'), false)
    let shutdownFinished = false
    const stopping = f.service.shutdown().then(() => {
      shutdownFinished = true
    })
    await cancelling.promise
    assert.equal(shutdownFinished, false)
    closed.resolve()
    await stopping
    assert.equal((await f.finished(accepted.transferId)).stage, 'cancelled')
    assert.equal(await readFile(f.destination, 'utf8'), 'original')
    assert.deepEqual((await readdir(f.directory)).sort(), ['Source.flac', 'Target.flac'])
    await assert.rejects(f.service.chooseUploadFiles('window'), /shutting down/)
  }
)

test(
  'cancelled selections and expired grants never start provider work',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t, { chooseDownloadFile: async () => null })
    for (let i = 0; i < 2; i++)
      assert.deepEqual(
        await f.service.download('window', { cloudSongId: 7, fileName: 'CON.flac' }),
        {
          transferId: '',
          fileName: '网易云云盘歌曲.flac',
          accepted: false,
          cancelled: true
        }
      )
    const [file] = await f.service.chooseUploadFiles('window')
    f.now(30 * 60_000 + 10)
    assert.throws(() => f.service.upload('window', file.handle), /凭证已失效/)
    assert.equal(f.service.state().total, 0)
    const controller = new AbortController()
    controller.abort(new Error('client disconnected'))
    await assert.rejects(
      f.service.chooseUploadFiles('window', controller.signal),
      /client disconnected/
    )
  }
)

test(
  'task history retains the last 200 finished transfers and serves bounded pages',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t)
    let first = ''
    for (let index = 0; index < 203; index++) {
      const accepted = await f.service.download('window', {
        cloudSongId: index + 1,
        fileName: 'song.flac'
      })
      first ||= accepted.transferId
      await f.finished(accepted.transferId)
    }
    assert.equal(f.service.state().total, 200)
    assert.equal(f.service.state().active, 0)
    assert.equal(
      f.tasks().some((task) => task.transferId === first),
      false
    )
    assert.equal(
      f.service.page({ revision: f.service.state().revision, offset: 199, limit: 50 }).items.length,
      1
    )
  }
)
