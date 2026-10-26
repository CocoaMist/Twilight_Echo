import assert from 'node:assert/strict'
import test from 'node:test'
import { CoreMusicFocusService } from './focusService.ts'
import type { CorePlaybackSession } from '../playback/session.ts'
import type {
  MusicFocusDatabaseApi,
  MusicFocusQuery,
  MusicFocusState,
  MusicFocusToken
} from '../../shared/musicFocus.ts'
import { musicFocusQueryKey, sameFocusState } from '../../shared/musicFocus.ts'
import type { LibraryQueueSeedItem } from '../../shared/libraryQueueBuild.ts'
import type { TrackData } from '../../shared/track.ts'

const query: MusicFocusQuery = {
  version: 1,
  entity: 'recording',
  where: { automaticPlaybackBlocked: false }
}
const state = (): MusicFocusState => ({
  savedRevision: 0,
  catalogRevision: 1,
  contentRevision: 1,
  genresRevision: 0,
  metadataRevision: 0,
  ratingsRevision: 0,
  preferencesRevision: 0,
  tagsRevision: 0,
  linkRevision: 0,
  historyRevision: 0
})
const token = (): MusicFocusToken => ({
  ...state(),
  queryKey: musicFocusQueryKey(query),
  asOf: 100,
  contextKey: 'context',
  expiresAt: null
})
function fixture(total = 205) {
  let current = state(),
    contexts = { ncm: 'account:one' },
    now = 101,
    historyChecks = 0
  let accepted: LibraryQueueSeedItem[] = [{ id: 'old' }],
    selected = -1
  let afterAppend: (() => void) | undefined,
    beforeAdopt: (() => void) | undefined,
    afterCheck: (() => void) | undefined
  let historyCheck: (() => void) | undefined
  let incomplete = false
  const batches: number[] = [],
    operations: string[] = []
  const anchors: Array<string | undefined> = []
  const database: MusicFocusDatabaseApi = {
    focusState: async () => ({ ...current }),
    focusQuery: async (q) => {
      if (q.token && !sameFocusState(q.token, current))
        throw Object.assign(new Error('stale'), { code: 'STALE_REVISION' })
      return { token: { ...(q.token ?? token()), ...current }, offset: 0, total, items: [] }
    },
    focusFacets: async (q) => ({
      token: { ...token(), ...current },
      facet: q.facet,
      offset: 0,
      total: 0,
      items: []
    }),
    focusPlaybackPage: async (q, context) => {
      assert.equal(q.limit, 100)
      anchors.push(q.anchorSourceId)
      assert.deepEqual(context?.platformContexts, contexts)
      const offset = q.offset ?? 0
      return {
        token: { ...token(), ...current },
        offset,
        total,
        items: incomplete
          ? []
          : Array.from({ length: Math.min(100, total - offset) }, (_, i) => {
              const n = offset + i
              const track: TrackData = {
                id: `track:${n}`,
                source: n % 2 ? 'ncm' : 'local',
                ncmSongId: n,
                title: `Song ${n}`,
                artist: 'Artist',
                album: 'Album',
                duration: 100,
                size: 0,
                filePath: n % 2 ? '' : `D:/private/${n}.flac`,
                fileName: `${n}.flac`,
                cover: null,
                lyrics: 'private lyrics'
              }
              return {
                recordingId: `recording:${n}`,
                sourceId: `source:${n}`,
                provider: track.source!,
                track
              }
            })
      }
    },
    focusSavedList: async () => ({
      savedRevision: current.savedRevision,
      offset: 0,
      total: 0,
      items: []
    }),
    focusSavedCreate: async (q, time) => {
      operations.push(`create:${time}`)
      current.savedRevision++
      return {
        savedRevision: current.savedRevision,
        item: {
          id: 'saved',
          name: q.name,
          query: q.query,
          nameRevision: 1,
          queryRevision: 1,
          updatedAt: time
        }
      }
    },
    focusSavedRename: async (q, time) => ({
      savedRevision: ++current.savedRevision,
      item: {
        id: q.id,
        name: q.name,
        query,
        nameRevision: q.nameRevision + 1,
        queryRevision: 1,
        updatedAt: time
      }
    }),
    focusSavedUpdate: async (q, time) => ({
      savedRevision: ++current.savedRevision,
      item: {
        id: q.id,
        name: 'Saved',
        query: q.query,
        nameRevision: 1,
        queryRevision: q.queryRevision + 1,
        updatedAt: time
      }
    }),
    focusSavedDelete: async (q) => ({ savedRevision: ++current.savedRevision, deletedId: q.id })
  }
  const playback: Pick<CorePlaybackSession, 'fromPages'> = {
    async fromPages(produce, options = {}, signal) {
      operations.push('capture-intent')
      const staged: LibraryQueueSeedItem[] = []
      await produce(async (items) => {
        batches.push(items.length)
        staged.push(...items)
        afterAppend?.()
      })
      beforeAdopt?.()
      await options.beforeAdopt?.(true)
      afterCheck?.()
      options.guard?.()
      signal?.throwIfAborted()
      selected =
        typeof options.selectedIndex === 'function'
          ? options.selectedIndex()
          : (options.selectedIndex ?? 0)
      accepted = staged
      options.onAdopt?.()
    }
  }
  const service = new CoreMusicFocusService({
    database,
    playback,
    ensureHistory: async () => {
      historyChecks++
      operations.push('history')
      historyCheck?.()
    },
    platformContexts: () => contexts,
    now: () => now,
    changed() {}
  })
  const controller = new AbortController()
  return {
    service,
    database,
    playback,
    controller,
    restore: async (t: TrackData) => t,
    result: () => ({ accepted, batches, selected, historyChecks, operations, anchors }),
    mutate(key: keyof MusicFocusState) {
      current = { ...current, [key]: current[key] + 1 }
    },
    setContext() {
      contexts = { ncm: 'account:two' }
    },
    setNow(n: number) {
      now = n
    },
    incomplete() {
      incomplete = true
    },
    onAppend(f: () => void) {
      afterAppend = f
    },
    beforeAdopt(f: () => void) {
      beforeAdopt = f
    },
    afterCheck(f: () => void) {
      afterCheck = f
    },
    ensureHistory(f: () => void) {
      historyCheck = f
    }
  }
}

test('Focus captures intent first, streams bounded private pages and freezes exact matched sources', async () => {
  const f = fixture()
  const result = await f.service.play(
    { query, token: token(), sourceId: 'source:150' },
    f.controller.signal,
    f.restore
  )
  assert.deepEqual(result, { total: 205, selectedIndex: 150 })
  assert.deepEqual(f.result().batches, [100, 100, 5])
  assert.deepEqual(f.result().anchors, ['source:150', 'source:150', 'source:150'])
  assert.deepEqual(f.result().operations.slice(0, 2), ['capture-intent', 'history'])
  assert.equal(f.result().accepted[0].localSnapshot?.sourceSelection, 'explicit')
  assert.equal(f.result().accepted[1].snapshot?.sourceSelection, 'explicit')
  assert.equal(f.result().accepted[0].localSnapshot?.lyrics, null)
  f.service.observe({ ...state(), tagsRevision: 1 })
  assert.equal(f.result().accepted.length, 205)
})

test('Focus empty, missing anchor, unauthorized restoration and incomplete pages retain the old queue', async () => {
  for (const mode of ['empty', 'anchor', 'authority', 'incomplete']) {
    const f = fixture(mode === 'empty' ? 0 : 1)
    if (mode === 'incomplete') f.incomplete()
    await assert.rejects(
      f.service.play(
        { query, token: token(), ...(mode === 'anchor' ? { sourceId: 'missing' } : {}) },
        f.controller.signal,
        mode === 'authority' ? undefined : f.restore
      )
    )
    assert.deepEqual(f.result().accepted, [{ id: 'old' }], mode)
  }
})

test('Focus cancellation, changed contexts and fact expiry abort staged adoption', async () => {
  for (const mode of ['cancel', 'context', 'expiry']) {
    const f = fixture(1)
    const frozen = token()
    if (mode === 'expiry') frozen.expiresAt = 102
    f.onAppend(() => {
      if (mode === 'cancel') f.controller.abort(new Error('cancelled'))
      if (mode === 'context') f.setContext()
      if (mode === 'expiry') f.setNow(102)
    })
    await assert.rejects(f.service.play({ query, token: frozen }, f.controller.signal, f.restore))
    assert.deepEqual(f.result().accepted, [{ id: 'old' }], mode)
  }
})

test('Focus beforeAdopt rechecks all durable revisions even before their events arrive', async () => {
  for (const key of Object.keys(state()) as Array<keyof MusicFocusState>) {
    const f = fixture(1)
    f.beforeAdopt(() => f.mutate(key))
    await assert.rejects(
      f.service.play({ query, token: token() }, f.controller.signal, f.restore),
      { code: 'STALE_REVISION' }
    )
    assert.deepEqual(f.result().accepted, [{ id: 'old' }], key)
  }
})

test('Focus final synchronous event guard fences changes after the last async check', async () => {
  const f = fixture(1)
  f.afterCheck(() => f.service.observe({ ...state(), historyRevision: 1 }))
  await assert.rejects(f.service.play({ query, token: token() }, f.controller.signal, f.restore), {
    code: 'STALE_REVISION'
  })
  assert.deepEqual(f.result().accepted, [{ id: 'old' }])
})

test('Focus history projection failures do not query or replace a queue', async () => {
  const f = fixture(1)
  f.ensureHistory(() => {
    throw new Error('history unavailable')
  })
  await assert.rejects(f.service.query({ query }), /history unavailable/)
  await assert.rejects(
    f.service.play({ query, token: token() }, f.controller.signal, f.restore),
    /history unavailable/
  )
  assert.deepEqual(f.result().accepted, [{ id: 'old' }])
})

test('Focus observes saved and history revisions without copying token context into durable state', async () => {
  const f = fixture(1)
  await f.service.query({ query })
  assert.equal(f.service.getRevision(), 0)
  await f.service.savedCreate({ name: 'Night', query, savedRevision: 0 })
  assert.equal(f.service.getRevision(), 1)
  f.service.observe({ ...state(), historyRevision: 3 })
  f.service.observe(state())
  assert.equal(f.service.getRevision(), 1)
  assert.equal(f.service.getHistoryRevision(), 3)
})

test('Focus public reads reject account changes, delayed expiry and newer observed revisions before returning', async () => {
  for (const method of ['query', 'facets'] as const)
    for (const change of ['context', 'expiry', 'revision']) {
      const f = fixture(1)
      const delayed = async () => {
        if (change === 'context') f.setContext()
        if (change === 'expiry') f.setNow(103)
        if (change === 'revision') f.service.observe({ ...state(), ratingsRevision: 1 })
        return {
          token: { ...token(), expiresAt: change === 'expiry' ? 102 : null },
          offset: 0,
          total: 0,
          items: []
        }
      }
      f.database.focusQuery = delayed
      f.database.focusFacets = async () => ({ ...(await delayed()), facet: 'provider' })
      await assert.rejects(
        method === 'query'
          ? f.service.query({ query })
          : f.service.facets({ query, facet: 'provider' }),
        { code: 'STALE_REVISION' },
        `${method}/${change}`
      )
    }
  const f = fixture(1)
  await f.service.query({ query })
  f.mutate('ratingsRevision')
  assert.equal(
    (await f.service.query({ query })).token.ratingsRevision,
    1,
    'a new read may initialize a revision before its event arrives'
  )
})

test('Focus request receipts distinguish pending, cancellation, adopted native failure and acknowledged play without replay', async () => {
  const f = fixture(1),
    identity = { requestId: 'one', epoch: 'current', owner: 'window' }
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  f.database.focusPlaybackPage = async () => {
    entered()
    await gate
    return { token: token(), offset: 0, total: 1, items: [] }
  }
  const work = f.service.play({ query, token: token() }, f.controller.signal, f.restore, identity)
  await started
  assert.deepEqual(f.service.playStatus(identity, 'window', 'current'), { status: 'pending' })
  assert.deepEqual(f.service.playStatus(identity, 'different', 'current'), { status: 'unknown' })
  assert.deepEqual(f.service.playStatus(identity, 'window', 'new-epoch'), { status: 'unknown' })
  const rejected = assert.rejects(work)
  f.controller.abort()
  release()
  await rejected
  assert.deepEqual(f.service.playStatus(identity, 'window', 'current'), { status: 'not_committed' })
  await assert.rejects(
    f.service.play({ query, token: token() }, new AbortController().signal, f.restore, identity),
    { code: 'OUTCOME_UNKNOWN' }
  )

  for (const nativeFails of [false, true]) {
    const next = fixture(1)
    const fromPages = next.playback.fromPages
    next.playback.fromPages = async (...args) => {
      await fromPages(...args)
      assert.deepEqual(next.service.playStatus(identity, 'window', 'current'), {
        status: 'committed',
        result: { total: 1, selectedIndex: 0 },
        playback: 'pending'
      })
      if (nativeFails) throw new Error('native reply lost')
    }
    const playing = next.service.play(
      { query, token: token() },
      next.controller.signal,
      next.restore,
      identity
    )
    if (nativeFails) await assert.rejects(playing, /native reply lost/)
    else await playing
    const receipt = next.service.playStatus(identity, 'window', 'current')
    assert.deepEqual(receipt, {
      status: 'committed',
      result: { total: 1, selectedIndex: 0 },
      playback: nativeFails ? 'failed' : 'confirmed'
    })
    if (receipt.status === 'committed') receipt.result.total = 999
    assert.equal(
      (next.service.playStatus(identity, 'window', 'current') as { result: { total: number } })
        .result.total,
      1
    )
  }
})
