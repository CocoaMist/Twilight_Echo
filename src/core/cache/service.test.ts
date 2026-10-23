import assert from 'node:assert/strict'
import test from 'node:test'
import { CoreMusicCacheService } from './service.ts'
import { SourceResources } from '../playback/sourceResources.ts'

function fixture(overrides: Partial<ConstructorParameters<typeof CoreMusicCacheService>[0]> = {}) {
  const events: string[] = []
  const scope =
    (name: string) =>
    async <T>(action: () => Promise<T>): Promise<T> => {
      events.push(name)
      try {
        return await action()
      } finally {
        events.push(`/${name}`)
      }
    }
  const service = new CoreMusicCacheService({
    authorize: async () => {
      events.push('authorize')
    },
    maintainSources: (action) => scope('sources')(() => action(['current', 'preloaded'])),
    maintainResources: scope('resources'),
    maintainNetwork: scope('network'),
    maintainProvider: scope('provider'),
    maintainScanner: scope('scanner'),
    clearFiles: async (sources) => {
      assert.deepEqual(sources, ['current', 'preloaded'])
      events.push('files')
    },
    clearPlatform: async () => {
      events.push('platform')
    },
    info: async () => {
      events.push('info')
      return { sizeBytes: 12 }
    },
    clearNetwork: async () => {
      events.push('network-only')
      return { sizeBytes: 3 }
    },
    ...overrides
  })
  return { events, service }
}

test('aggregate clear acquires real owners after source revocation and releases in reverse order', async () => {
  const f = fixture()
  assert.deepEqual(await f.service.clear(new AbortController().signal), { sizeBytes: 12 })
  assert.deepEqual(f.events, [
    'authorize',
    'sources',
    'resources',
    'network',
    'provider',
    'scanner',
    'files',
    'platform',
    '/scanner',
    '/provider',
    '/network',
    '/resources',
    '/sources',
    'info'
  ])
})

test('source readers cancel before provider maintenance rather than deadlocking against its barrier', async () => {
  const resources = new SourceResources(),
    preview = new AbortController()
  let started!: () => void
  const starting = new Promise<void>((resolve) => {
    started = resolve
  })
  const reader = resources.use(async () => {
    started()
    await new Promise<void>((_resolve, reject) =>
      preview.signal.addEventListener('abort', () => reject(preview.signal.reason))
    )
  })
  const rejected = assert.rejects(reader, /revoked/)
  await starting
  let providerEntered = false
  const f = fixture({
    maintainSources: async (action) => {
      preview.abort(new Error('revoked'))
      return action(['current', 'preloaded'])
    },
    maintainResources: (action) => resources.maintain(action),
    maintainProvider: async (action) => {
      assert.equal(preview.signal.aborted, true)
      providerEntered = true
      return action()
    }
  })
  await f.service.clear(new AbortController().signal)
  await rejected
  assert.equal(providerEntered, true)
})

test('network-only and aggregate commands share one owner; cancellation joins actual platform work', async () => {
  let arrived!: () => void, release!: () => void
  const entered = new Promise<void>((resolve) => {
    arrived = resolve
  })
  const signal = new AbortController()
  let ended = false
  const f = fixture({
    clearPlatform: async (current) => {
      arrived()
      await new Promise<void>((resolve) => {
        release = resolve
      })
      current.throwIfAborted()
    }
  })
  const clearing = f.service.clear(signal.signal).finally(() => {
    ended = true
  })
  const cancelled = assert.rejects(clearing, /disconnected/)
  await entered
  assert.throws(() => f.service.clearNetwork(signal.signal), /already running/)
  const flushed = f.service.flush()
  const flushFailed = assert.rejects(flushed, /disconnected/)
  signal.abort(new Error('disconnected'))
  await Promise.resolve()
  assert.equal(ended, false)
  release()
  await Promise.all([cancelled, flushFailed])
  assert.ok(f.events.includes('/sources'))
  assert.deepEqual(await f.service.clearNetwork(new AbortController().signal), { sizeBytes: 3 })
  assert.equal(f.events.filter((e) => e === 'files').length, 1)
})

test('authorization and already-cancelled requests fail before any cache owner or deletion', async () => {
  const f = fixture({
    authorize: async () => {
      throw new Error('denied')
    }
  })
  await assert.rejects(f.service.clear(new AbortController().signal), /denied/)
  await assert.rejects(f.service.info(), /denied/)
  assert.deepEqual(f.events, [])
  const stopped = new AbortController()
  stopped.abort(new Error('cancelled'))
  await assert.rejects(f.service.clear(stopped.signal), /cancelled/)
  assert.deepEqual(f.events, [])
})
