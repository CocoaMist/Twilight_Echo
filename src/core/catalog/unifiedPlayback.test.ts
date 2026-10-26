import assert from 'node:assert/strict'
import test from 'node:test'
import { CoreUnifiedPlaybackService } from './unifiedPlayback.ts'
import type { CorePlaybackSession } from '../playback/session.ts'
import type { TrackData } from '../../shared/track.ts'
import { emptyMusicVersions } from '../../shared/musicVersions.ts'
import { versionSourceKey } from '../../shared/trackSourceIdentity.ts'
import {
  validUnifiedPlaybackPayload,
  type CatalogPlaybackSource,
  type CatalogPlaybackSourcesQuery,
  type UnifiedPlaybackRequest
} from '../../shared/musicUnifiedPlayback.ts'
import type { GenreBrowseToken } from '../../shared/musicGenreBrowse.ts'

const track = (id: string): TrackData => ({
  id, source: id.split(':')[0], filePath: id.startsWith('local:') ? `D:/Music/${id.slice(6)}.flac` : '',
  fileName: '', title: 'Same title', artist: 'Same artist', album: 'Same album', duration: 60,
  cover: null, lyrics: null, size: 0, isrc: 'IDENTICAL-ISRC'
})
const row = (id: string, addedAt: number | null = null): CatalogPlaybackSource => {
  const value = track(id)
  return { sourceId: `opaque-${id}`, sourceKey: versionSourceKey(value), provider: value.source!,
    addedAt, inLibrary: true, track: value }
}
const token: GenreBrowseToken = { genresRevision: 1, catalogRevision: 7, contentRevision: 2,
  metadataRevision: 3, asOf: 10, expiresAt: null, contextKey: 'private-context' }

function fixture(rows: CatalogPlaybackSource[]) {
  const document = emptyMusicVersions()
  const queries: CatalogPlaybackSourcesQuery[] = [], prepared: string[] = [], committed: string[] = []
  const failures = new Map<string, Error>()
  let revision = 4
  let onPrepare: (() => void) | undefined
  let onBeforeAdopt: (() => void) | undefined
  let allowed: Set<string> | null = null
  const scopeCalls: string[][] = []
  const playback: Pick<CorePlaybackSession, 'fromUnifiedTrack'> = {
    fromUnifiedTrack: async (select, signal, beforeAdopt) => {
      const current = signal ?? new AbortController().signal
      const selection = await select(current, async (value) => {
        prepared.push(value.id)
        onPrepare?.()
        assert.equal(value.sourceSelection, 'explicit')
        const error = failures.get(value.id)
        if (error) throw error
        return { track: value, resolved: { source: `https://audio.invalid/${value.id}`, expiresAt: null } }
      })
      if (selection.prepared) {
        onBeforeAdopt?.()
        await beforeAdopt?.()
        selection.prepared.confirm?.()
        committed.push(selection.prepared.track.id)
      }
      return selection.result
    }
  }
  const service = new CoreUnifiedPlaybackService({
    database: {
      catalogPlaybackSources: async (query) => {
        queries.push(query)
        assert.equal(query.revision, 7)
        const matches = rows.filter((item) => query.sourceId
          ? item.sourceId === query.sourceId : query.sourceKeys?.includes(item.sourceKey))
        const offset = query.offset ?? 0
        return { revision: 7, total: matches.length, offset,
          items: matches.slice(offset, offset + (query.limit ?? 200)) }
      }
    },
    versions: { getRevision: () => revision, snapshot: () => structuredClone(document) }, playback,
    restore: async (value) => value,
    assertScope: async (_request, ids) => {
      scopeCalls.push(ids)
      assert.ok(ids.length <= 200)
      return ids.filter((id) => !allowed || allowed.has(id))
    }
  })
  return { document, service, queries, prepared, committed, failures, scopeCalls,
    changeVersions: () => { revision++ },
    onPrepare: (callback: () => void) => { onPrepare = callback },
    onBeforeAdopt: (callback: () => void) => { onBeforeAdopt = callback },
    allow: (ids: string[]) => { allowed = new Set(ids) },
    request: (source = rows[0]): UnifiedPlaybackRequest => ({ sourceId: source.sourceId, revision: 7 }),
    version: (id: string, sources: CatalogPlaybackSource[], preferredSource: string | null = null) => {
      document.tracks.versions.push({ id, label: id, sources: sources.map((item) => item.sourceKey), preferredSource })
    }
  }
}

test('unified selection resolves preferred playback version then preferred source, independent of metadata identity', async () => {
  const [original, local, stream] = [row('old:original'), row('local:master'), row('cloud:master')]
  const f = fixture([original, local, stream])
  f.version('original', [original])
  f.version('master', [local, stream], stream.sourceKey)
  f.document.tracks.families.push({ id: 'editions', versions: ['original', 'master'], preferredVersion: 'master' })
  const result = await f.service.play({ ...f.request(), providerOrder: ['local', 'cloud'] })
  assert.equal(result.status, 'played')
  assert.equal(result.versionId, 'master')
  assert.equal(result.sourceId, stream.sourceId)
  assert.deepEqual(f.prepared, ['cloud:master'])
  assert.deepEqual(f.committed, ['cloud:master'])
})

test('same title, recording metadata or ISRC never creates fallback equivalence', async () => {
  const a = row('local:missing'), b = row('cloud:same')
  const f = fixture([a, b])
  f.failures.set(a.track!.id, new Error('Selected file missing'))
  const result = await f.service.play(f.request())
  assert.equal(result.status, 'unavailable')
  assert.equal(result.versionId, null)
  assert.deepEqual(result.attempts.map((item) => item.sourceId), [a.sourceId])
  assert.deepEqual(f.prepared, ['local:missing'])
  assert.deepEqual(f.committed, [])
})

test('equivalent sources prepare once, with provider order then genuine addedAt and stable opaque ID', async () => {
  const rows = [row('cloud:c'), row('local:b', 20), row('local:a', 20), row('cloud:a', 5)]
  const f = fixture(rows)
  f.version('equivalent', rows)
  f.failures.set('local:a', new Error('File not found: D:/Music/a.flac'))
  f.failures.set('local:b', new Error('Unable to open https://audio.invalid/a?token=secret'))
  const result = await f.service.play({ ...f.request(), providerOrder: ['local', 'cloud'] })
  assert.deepEqual(f.prepared, ['local:a', 'local:b', 'cloud:a'])
  assert.equal(result.sourceId, 'opaque-cloud:a')
  assert.deepEqual(result.attempts.map((item) => item.status), ['failed', 'failed', 'selected'])
  assert.doesNotMatch(JSON.stringify(result), /D:\/Music|audio.invalid|token=secret|\["local"/)
})

test('a failed preferred version does not fall back to another version in its family', async () => {
  const original = row('cloud:studio'), live = row('cloud:live')
  const f = fixture([original, live])
  f.version('studio', [original])
  f.version('live', [live])
  f.document.tracks.families.push({ id: 'family', versions: ['studio', 'live'], preferredVersion: 'live' })
  f.failures.set('cloud:live', new Error('Provider unavailable'))
  const result = await f.service.play(f.request())
  assert.equal(result.status, 'unavailable')
  assert.equal(result.versionId, 'live')
  assert.deepEqual(f.prepared, ['cloud:live'])
})

test('frozen scope removes a preferred cloud source instead of escaping local format filters', async () => {
  const local = row('local:24bit'), cloud = row('cloud:24bit')
  const f = fixture([local, cloud])
  f.version('equivalent', [local, cloud], cloud.sourceKey)
  f.allow([local.sourceId])
  const result = await f.service.play({ ...f.request(), scope: { entityId: 'recording:one', token } })
  assert.equal(result.sourceId, local.sourceId)
  assert.deepEqual(f.prepared, ['local:24bit'])
  assert.equal(f.scopeCalls.filter((ids) => ids.length === 1 && ids[0] === local.sourceId).length, 3)
})

test('version edits and scope expiry after preparation stop before commit, without trying another source', async () => {
  for (const changed of ['versions', 'scope']) {
    const rows = [row('local:a'), row('cloud:b')]
    const f = fixture(rows)
    f.version('equivalent', rows, rows[0].sourceKey)
    if (changed === 'versions') f.onPrepare(f.changeVersions)
    else f.onBeforeAdopt(() => f.allow([]))
    await assert.rejects(f.service.play(f.request()), { code: 'STALE_REVISION' })
    assert.deepEqual(f.prepared, ['local:a'])
    assert.deepEqual(f.committed, [])
  }
})

test('authorization refusal and missing provider permission stop rather than search around a denial', async () => {
  for (const code of ['SOURCE_ACCESS_DENIED', 'FORBIDDEN']) {
    const rows = [row('cloud:a'), row('local:b')]
    const f = fixture(rows)
    f.version('equivalent', rows, rows[0].sourceKey)
    f.failures.set('cloud:a', Object.assign(new Error('Access denied'), { code }))
    await assert.rejects(f.service.play(f.request()), { code })
    assert.deepEqual(f.prepared, ['cloud:a'])
    assert.deepEqual(f.committed, [])
  }
})

test('per-call provider restoration enforces its identity permissions while local playback remains independent', async () => {
  const f = fixture([row('local:a')])
  let restored = false
  const result = await f.service.play(f.request(), undefined, async (value) => {
    restored = true
    return value
  })
  assert.equal(restored, true)
  assert.equal(result.status, 'played')
  const remote = fixture([row('cloud:a')])
  await assert.rejects(remote.service.play(remote.request(), undefined, async () => {
    throw Object.assign(new Error('Provider access is not granted'), { code: 'FORBIDDEN' })
  }), { code: 'FORBIDDEN' })
  assert.deepEqual(remote.prepared, [])
})

test('version-key enumeration and scope authorization stay bounded and exclude nonmembers', async () => {
  const rows = Array.from({ length: 205 }, (_, index) => row(`cloud:${String(index).padStart(3, '0')}`))
  rows[0].inLibrary = false
  const f = fixture(rows)
  f.version('many', rows)
  const result = await f.service.play(f.request(rows[1]))
  assert.equal(result.sourceId, rows[1].sourceId)
  assert.equal(f.queries.length, 4)
  assert.ok(f.queries.every((query) => !query.sourceKeys || query.sourceKeys.length <= 200))
  assert.ok(f.scopeCalls.every((ids) => ids.length <= 200))
  assert.equal(f.scopeCalls.flat().includes(rows[0].sourceId), false)
})

test('unavailable indexed local rows retain a precise failure and do not silently use a different identity', async () => {
  const local = row('local:a')
  local.track = null
  const f = fixture([local])
  const result = await f.service.play(f.request())
  assert.equal(result.attempts[0].code, 'SOURCE_MISSING')
  assert.deepEqual(f.prepared, [])
})

test('removal during preparation is rechecked against the catalog before adopting even without a filter scope', async () => {
  const local = row('local:a')
  const f = fixture([local])
  f.onBeforeAdopt(() => { local.inLibrary = false })
  await assert.rejects(f.service.play(f.request()), { code: 'STALE_REVISION' })
  assert.deepEqual(f.prepared, ['local:a'])
  assert.deepEqual(f.committed, [])
})

test('unified public payload accepts only opaque IDs, bounded preferences and one tokenized server scope', () => {
  const valid = { sourceId: 'source:one', revision: 7 }
  assert.equal(validUnifiedPlaybackPayload(valid), true)
  assert.equal(validUnifiedPlaybackPayload({ ...valid, scope: { entityId: 'r', token } }), true)
  assert.equal(validUnifiedPlaybackPayload({ ...valid, albumScope: { entityId: 'p', releaseId: 'r', token } }), true)
  assert.equal(validUnifiedPlaybackPayload({ ...valid, albumScope: { entityId: 'p', releaseId: 'r'.repeat(200), token } }), true)
  for (const extra of [
    { sourceKeys: ['private-key'] }, { track: track('local:a') },
    { providerOrder: ['local', 'local'] }, { providerOrder: ['../cloud'] },
    { scope: { entityId: 'r' } }, { scope: { entityId: 'r', token, sourceIds: ['source:one'] } },
    { scope: { entityId: 'r', token }, albumScope: { entityId: 'p', releaseId: 'r', token } }
  ]) assert.equal(validUnifiedPlaybackPayload({ ...valid, ...extra }), false)
})
