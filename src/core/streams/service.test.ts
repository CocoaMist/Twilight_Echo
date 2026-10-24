import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CoreStreamsService, type CoreStreamsOptions } from './service.ts'
import { RadioMediaService, type RadioMediaServiceOptions } from './radioMediaService.ts'
import { searchRadioBrowserStations } from './radioBrowserClient.ts'
import { CoreStateDatabase } from '../../main/library/coreStateDatabase.ts'
import { emptyCoreStateCounts } from '../../shared/coreState.ts'
import type { PodcastSubscription } from '../../shared/podcastSubscriptions.ts'

const RSS = `<rss><channel><title>New title</title><item><title>One</title><guid>urn:episode:one</guid><enclosure url="https://cdn.example/one.mp3?token=private"/><duration>120</duration></item></channel></rss>`
const subscription = (id = 'one'): PodcastSubscription => ({
  id,
  feedUrl: `https://example.test/${id}.rss`,
  title: 'Old title',
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
  feedEtag: '"old"',
  feedLastModified: 'Tue, 21 Jul 2026 00:00:00 GMT',
  episodes: [
    {
      guid: 'urn:episode:one',
      title: 'One',
      mediaUrl: 'https://cdn.example/old.mp3',
      durationSeconds: 120,
      progressSeconds: 7
    }
  ]
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
async function fixture(
  t: test.TestContext,
  options: {
    feeds?: RadioMediaServiceOptions['fetchFeed']
    subscriptions?: PodcastSubscription[]
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'twilight-core-streams-'))
  const repository = new RadioMediaService({
    userDataPath: root,
    fetchFeed: options.feeds,
    now: () => '2026-10-22T00:00:00Z',
    newId: () => `id${++serial}`
  })
  let serial = 0,
    now = 10_000,
    callback: (() => void) | null = null,
    interval = 0
  if (options.subscriptions)
    await repository.savePodcastSubscriptions(
      { schemaVersion: 1, subscriptions: options.subscriptions },
      0
    )
  const db = new CoreStateDatabase(':memory:')
  const counts = emptyCoreStateCounts()
  counts['podcast-preferences'] = 1
  db.begin('upgrade', { version: 1, counts })
  db.stage('upgrade', 0, 'podcast-preferences', [{ key: 'defaultPlaybackRate', value: 1.25 }])
  db.commit('upgrade')
  const failures: unknown[] = []
  const dependencies: CoreStreamsOptions = {
    repository,
    preferences: {
      coreStateRead: async (...args) => db.read(...args),
      coreStateWrite: async (...args) => db.write(...args)
    },
    now: () => now,
    newId: () => `token${++serial}`,
    timers: {
      setInterval: (fn, delay) => {
        callback = fn
        interval = delay
        return 1
      },
      clearInterval: () => {
        callback = null
      }
    },
    changed() {},
    failed: (error) => failures.push(error)
  }
  const service = new CoreStreamsService(dependencies)
  await service.initialize()
  await service.activate()
  t.after(async () => {
    await service.shutdown()
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  const episodes = (id = 'one') =>
    service.episodes(id, { revision: service.state().podcastRevision })
  const track = (id = 'one') =>
    service.playback({
      kind: 'podcast',
      id,
      guid: 'urn:episode:one',
      revision: service.state().podcastRevision
    }).track
  return {
    service,
    repository,
    db,
    dependencies,
    failures,
    episodes,
    track,
    interval: () => interval,
    timer: () => callback?.(),
    hasTimer: () => !!callback,
    advance: (ms: number) => {
      now += ms
    }
  }
}

test('radio mutations preserve confirmation, CAS, duplicate/import order and disk ACK; public pages omit source URLs', async (t) => {
  const f = await fixture(t)
  await assert.rejects(
    f.service.radioEdit({
      revision: 0,
      edit: { kind: 'add', name: 'HTTP', streamUrl: 'http://example.test/live' }
    }),
    /confirmation/
  )
  const added = await f.service.radioEdit({
    revision: 0,
    edit: {
      kind: 'add',
      name: 'HTTP',
      streamUrl: 'http://example.test/live',
      allowInsecureHttp: true
    }
  })
  assert.equal(added.state.radioRevision, 1)
  await assert.rejects(
    f.service.radioEdit({ revision: 0, edit: { kind: 'remove', id: added.id! } }),
    { code: 'STALE_REVISION' }
  )
  const result = await f.service.radioEdit({
    revision: 1,
    edit: {
      kind: 'import',
      text: '#EXTM3U\n#EXTINF:-1,HTTP\nhttp://example.test/live\n#EXTINF:-1,A\nhttps://example.test/a\n#EXTINF:-1,B\nhttps://example.test/b',
      allowInsecureHttp: true
    }
  })
  assert.equal(result.added, 2)
  const page = f.service.stations({ revision: 2 })
  assert.deepEqual(
    page.items.map((item) => item.name),
    ['B', 'A', 'HTTP']
  )
  assert.doesNotMatch(JSON.stringify(page), /streamUrl/)
  assert.equal((await f.repository.loadRadioStations()).revision, 2)
  assert.equal(
    f.service.playback({ kind: 'radio', id: added.id!, revision: 2 }).track.streamUrl,
    'http://example.test/live'
  )
})

test('a slow conditional feed refresh merges the latest native progress instead of blocking or overwriting it', async (t) => {
  const gate = deferred<void>(),
    started = deferred<void>()
  const f = await fixture(t, {
    subscriptions: [subscription()],
    feeds: async (_url, request) => {
      assert.equal(request?.ifNoneMatch, '"old"')
      assert.match(request?.ifModifiedSince ?? '', /Jul/)
      started.resolve()
      await gate.promise
      return { body: RSS, status: 200, etag: '"new"' }
    }
  })
  const work = f.service.refresh('one')
  await started.promise
  const track = f.track()
  f.service.observe(track, { state: 'playing', position: 30 })
  await f.service.flush()
  assert.equal(f.episodes().items[0].progressSeconds, 30)
  f.service.observe(track, { state: 'paused', position: 31 })
  await f.service.flush()
  gate.resolve()
  await work
  assert.equal(f.episodes().items[0].progressSeconds, 31)
  const disk = await f.repository.loadPodcastSubscriptions()
  assert.equal(disk.data.subscriptions[0].feedEtag, '"new"')
  assert.equal(disk.data.subscriptions[0].title, 'New title')
  assert.doesNotMatch(JSON.stringify(f.episodes()), /mediaUrl|private/)
})

test('native progress keeps legacy 4/8-second throttles and forced pause/Stop/final writes', async (t) => {
  const f = await fixture(t, { subscriptions: [subscription()] }),
    track = f.track()
  f.service.observe(track, { state: 'paused', position: 7 }) // restored snapshot does not write
  assert.equal(f.service.state().podcastRevision, 1)
  f.service.observe(track, { state: 'playing', position: 10 })
  await f.service.flush()
  f.advance(3000)
  f.service.observe(track, { state: 'playing', position: 20 })
  await f.service.flush()
  assert.equal(f.episodes().items[0].progressSeconds, 10)
  f.advance(1000)
  f.service.observe(track, { state: 'playing', position: 11 })
  await f.service.flush()
  assert.equal(f.episodes().items[0].progressSeconds, 10)
  f.advance(4000)
  f.service.observe(track, { state: 'playing', position: 11 })
  await f.service.flush()
  assert.equal(f.episodes().items[0].progressSeconds, 11)
  f.service.observe(track, { state: 'paused', position: 12 })
  await f.service.flush()
  assert.equal(f.episodes().items[0].progressSeconds, 12)
  f.service.observe(track, { state: 'playing', position: 13 })
  f.service.observe(track, { state: 'stopped', position: 0 })
  await f.service.flush()
  assert.equal(f.episodes().items[0].progressSeconds, 13)
  await f.service.shutdown()
  assert.equal(
    (await f.repository.loadPodcastSubscriptions()).data.subscriptions[0].episodes[0]
      .progressSeconds,
    13
  )
})

test('unsubscribe during a refresh never resurrects it; undo merges just the removed subscription', async (t) => {
  const gate = deferred<void>(),
    started = deferred<void>()
  const f = await fixture(t, {
    subscriptions: [subscription()],
    feeds: async () => {
      started.resolve()
      await gate.promise
      return { body: RSS, status: 200 }
    }
  })
  const work = f.service.refresh('one')
  await started.promise
  const removal = await f.service.podcastEdit({
    revision: 1,
    edit: { kind: 'unsubscribe', id: 'one' }
  })
  gate.resolve()
  await work
  assert.equal(f.service.state().subscriptions, 0)
  await f.service.subscribe('https://example.test/new.rss', f.service.state().podcastRevision)
  await f.service.podcastEdit({
    revision: f.service.state().podcastRevision,
    edit: { kind: 'restore', token: removal.undoToken! }
  })
  assert.equal(f.service.state().subscriptions, 2)
  assert.equal(f.episodes().items[0].progressSeconds, 7)
  await assert.rejects(
    f.service.podcastEdit({
      revision: f.service.state().podcastRevision,
      edit: { kind: 'restore', token: removal.undoToken! }
    }),
    /失效/
  )
})

test('refresh Save failures remain visible without an automatic error Save or a pretend successful refreshAll', async (t) => {
  const f = await fixture(t, {
    subscriptions: [subscription()],
    feeds: async () => ({ body: RSS, status: 200 })
  })
  let writes = 0
  f.repository.savePodcastSubscriptions = async () => {
    writes++
    throw new Error('Reply lost after Save')
  }
  await assert.rejects(f.service.refreshAll(), /Reply lost/)
  assert.equal(writes, 1)
  assert.equal(f.service.state().podcastRevision, 1)
  assert.equal(f.episodes().items[0].progressSeconds, 7)
})

test('six-hour refresh works without clients, at most three fetches, retains 304 progress and joins cancellation on shutdown', async (t) => {
  let active = 0,
    peak = 0
  const f = await fixture(t, {
    subscriptions: Array.from({ length: 7 }, (_, i) => subscription(`sub${i}`)),
    feeds: async () => {
      active++
      peak = Math.max(peak, active)
      await tick()
      active--
      return { body: '', status: 304 }
    }
  })
  assert.equal(f.interval(), 6 * 60 * 60 * 1000)
  await f.service.refreshAll()
  assert.equal(peak, 3)
  assert.equal(f.service.state().podcastRevision, 2, 'a batch refresh persists exactly once')
  assert.equal(f.episodes('sub0').items[0].progressSeconds, 7)
  let aborted = false
  f.repository.buildSubscriptionFromFeed = async (_url, _previous, signal) => {
    await new Promise<void>((_resolve, reject) =>
      signal!.addEventListener(
        'abort',
        () => {
          aborted = true
          reject(signal!.reason)
        },
        { once: true }
      )
    )
    throw new Error('unreachable')
  }
  const pending = f.service.refresh('sub0')
  void pending.catch(() => {})
  await tick()
  await f.service.stopRefresh()
  await assert.rejects(pending, /shutting down/)
  assert.equal(aborted, true)
  assert.equal(f.hasTimer(), false)
})

test('episode departure persists its final observation, and native EOF records completion instead of a stale pre-boundary position', async (t) => {
  const f = await fixture(t, { subscriptions: [subscription('one'), subscription('two')] })
  const boundaries = (trackSerial: number) => ({
    trackSerial,
    queueSerial: 0,
    trackTimeMs: 0,
    queueTimeMs: 0
  })
  f.service.observe(
    { ...f.track('one'), queueEntryId: 'occ-1' },
    {
      state: 'playing',
      position: 30,
      naturalBoundaries: boundaries(0)
    }
  )
  f.service.observe(
    { ...f.track('one'), queueEntryId: 'occ-2' },
    {
      state: 'playing',
      position: 0,
      naturalBoundaries: boundaries(0)
    }
  )
  await f.service.flush()
  assert.equal(f.episodes('one').items[0].progressSeconds, 30)
  f.service.observe(
    { ...f.track('one'), queueEntryId: 'occ-2' },
    {
      state: 'playing',
      position: 47,
      naturalBoundaries: boundaries(0)
    }
  )
  f.service.observe(f.track('two'), {
    state: 'playing',
    position: 20,
    naturalBoundaries: boundaries(0)
  })
  await f.service.flush()
  assert.equal(f.episodes('one').items[0].progressSeconds, 47)
  f.service.observe(null, { state: 'stopped', position: 0, naturalBoundaries: boundaries(1) })
  await f.service.flush()
  assert.equal(f.episodes('two').items[0].progressSeconds, 120)
})

test('migrated default rate is authoritative and revision-fenced; query/reconnect never changes progress', async (t) => {
  const f = await fixture(t, { subscriptions: [subscription()] })
  assert.equal(f.service.defaultPlaybackRate(), 1.25)
  const state = f.service.state()
  await f.service.setDefaultRate(1.5, state.preferencesRevision)
  await assert.rejects(f.service.setDefaultRate(1, state.preferencesRevision), {
    code: 'STALE_REVISION'
  })
  assert.equal(
    f.service.playback({ kind: 'podcast', id: 'one', guid: 'urn:episode:one', revision: 1 })
      .position,
    7
  )
  assert.equal(
    f.service.playback({
      kind: 'podcast',
      id: 'one',
      guid: 'urn:episode:one',
      revision: 1,
      resume: false
    }).position,
    0
  )
  assert.equal(f.service.state().podcastRevision, 1)
  assert.doesNotMatch(JSON.stringify(f.service.subscriptions({ revision: 1 })), /feedUrl|feedEtag/)
})

test('cancelled directory requests do not retry another mirror or fetch at all when already aborted', async () => {
  const controller = new AbortController()
  let requests = 0
  await assert.rejects(
    searchRadioBrowserStations({
      query: 'jazz',
      signal: controller.signal,
      fetchJson: async () => {
        requests++
        controller.abort(new Error('cancelled'))
        throw new Error('network')
      }
    }),
    /cancelled/
  )
  assert.equal(requests, 1)
  await assert.rejects(
    searchRadioBrowserStations({
      query: 'jazz',
      signal: controller.signal,
      fetchJson: async () => {
        requests++
        return []
      }
    }),
    /cancelled/
  )
  assert.equal(requests, 1)
})
