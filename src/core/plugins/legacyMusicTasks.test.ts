import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import { LEGACY_MUSIC_TASKS_SQL } from '../../main/library/legacyQueueSchema.fixture.ts'
import { CoreEntityMetadataService } from '../library/entityMetadataService.ts'
import type { MetadataProvider } from '../library/entityMetadataProvider.ts'
import type {
  EntityMetadataDatabaseApi,
  EntityMetadataResult
} from '../../shared/entityMetadata.ts'
import type {
  LegacyMusicLookup,
  LegacyMusicTaskSeed,
  LegacyMusicTaskWork
} from '../../shared/legacyMusicTasks.ts'
import type { MusicAlbum } from '../../shared/rhineMusic.ts'
import type { TwilightPluginDescriptor } from '../../shared/pluginTypes.ts'
import type { LegacyMusicAuthorityDatabase } from './legacyMusicAuthority.ts'
import { legacyExperienceAlbumId } from './legacyMusicAuthority.ts'
import { CorePluginExperiences } from './experiences.ts'
import {
  createLegacyMusicLookupProvider,
  type LegacyMusicLookupProvider
} from './legacyMusicLookupProvider.ts'

const PLUGIN = 'com.twilightecho.experience.rhine-lab'
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
async function until(check: () => boolean | Promise<boolean>) {
  for (let n = 0; n < 1000; n++) {
    if (await check()) return
    await tick()
  }
  throw new Error('Legacy queue condition timed out')
}
const publicProvider = {
  id: 'musicbrainz-wiki',
  resolve: async () => null,
  enrich: async () => [],
  capabilities: { entities: ['artist'], fields: [], licensing: 'open', requiresIdentity: true }
} as unknown as MetadataProvider
type Result = Extract<EntityMetadataResult, { state: 'legacy_result' }>
const introduction = (text = 'New introduction'): Result => ({
  state: 'legacy_result',
  taskState: 'completed',
  outcome: 'matched',
  reason: null,
  lookup: {
    operation: 'introductions',
    value: {
      status: 'matched',
      checkedAt: '2026-10-24',
      description: text,
      descriptionSource: { name: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Album' }
    }
  }
})
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'legacy-tasks-')),
    path = join(root, 'library.sqlite')
  const db = new LibraryDatabase(path),
    dataDir = join(root, 'plugin')
  mkdirSync(dataDir)
  // Equal track numbers exercise the difference between display and SQL order.
  db.replaceDocument({
    version: 2,
    revision: 1,
    folders: [],
    exclusions: [],
    tracks: [
      {
        id: 'z',
        source: 'local',
        filePath: 'D:/Music/A/z.flac',
        title: 'Alpha',
        artist: 'Artist',
        album: 'Album',
        year: 2000,
        duration: 201,
        trackNumber: 1
      },
      {
        id: 'a',
        source: 'local',
        filePath: 'D:/Music/A/a.flac',
        title: 'Zulu',
        artist: 'Artist',
        album: 'Album',
        year: 2000,
        duration: 202,
        trackNumber: 1
      },
      {
        id: 'other',
        source: 'local',
        filePath: 'D:/Music/B/other.flac',
        title: 'Other',
        artist: 'Artist',
        album: 'Album',
        year: 2000,
        duration: 203
      }
    ]
  })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  const collections = db.queryCollections('albums', { limit: 200 })
  const seeds = collections.items.map((summary) => {
    const id = legacyExperienceAlbumId(summary.id)
    const records = db.queryTracks({ albumId: summary.id, sort: 'trackNumber' }).tracks
    const album: MusicAlbum = {
      id,
      title: summary.name,
      artist: summary.artist ?? '',
      year: 2000,
      genreId: 'unknown',
      rawGenres: [],
      folder: '',
      producers: [],
      offline: false,
      tracks: records.map((record) => ({
        id: record.id,
        albumId: id,
        title: String(record.title),
        artist: 'Artist',
        duration: Number(record.duration),
        format: 'flac',
        relativePath: '',
        audioUrl: '',
        browserPlayable: true
      }))
    }
    return { album, collectionId: summary.id, contentRevision: collections.revision, force: false }
  })
  const plugin = {
    id: PLUGIN,
    enabled: true,
    status: 'enabled',
    apiVersion: 4,
    version: '1.0.0',
    type: ['ui'],
    permissions: ['ui:inject', 'library:write', 'network', 'settings'],
    paths: { dataDir },
    contributes: {
      experiences: [{ id: 'library', name: 'Rhine', entry: 'ui/index.html', bridgeVersion: 2 }]
    }
  } as TwilightPluginDescriptor
  const manager = { list: async () => [plugin], listExtensions: async () => [] }
  writeFileSync(
    join(dataDir, 'music-metadata.json'),
    JSON.stringify({
      revision: 7,
      value: { config: { musicBrainzContact: 'https://example.com' }, albums: {} }
    })
  )
  const database = new Proxy({} as EntityMetadataDatabaseApi & LegacyMusicAuthorityDatabase, {
    get:
      (_, key) =>
      async (...args: unknown[]) =>
        (db[key as keyof LibraryDatabase] as (...args: unknown[]) => unknown).apply(db, args)
  })
  let serial = 0
  const batch = (operation: LegacyMusicLookup, entries = seeds) => {
    const id = `batch-${++serial}`
    db.legacyMusicBatchBegin(
      {
        id,
        pluginId: PLUGIN,
        operation,
        expected: entries.length,
        documentRevision: db.legacyMusicRead(PLUGIN)!.revision
      },
      1000
    )
    db.legacyMusicBatchStage(id, entries, 1000)
    db.legacyMusicBatchPublish(id, 1000)
    return id
  }
  const state = { scanning: false }
  const errors: unknown[] = [],
    services: CoreEntityMetadataService[] = [],
    experiences: CorePluginExperiences[] = []
  const owner = (legacy: LegacyMusicLookupProvider, activate = true, api = database) => {
    const value = new CoreEntityMetadataService({
      database: api,
      provider: publicProvider,
      legacy: () => legacy,
      // Old explicit actions do not acquire the new automatic opt-in prerequisite.
      policy: () => ({
        enabled: false,
        publicServiceApproved: false,
        wikipediaText: false,
        contact: ''
      }),
      now: Date.now,
      changed: () => {},
      failed: (error) => errors.push(error)
    })
    services.push(value)
    if (activate) value.activate()
    return value
  }
  const experience = (tasks?: CoreEntityMetadataService) => {
    const value = new CorePluginExperiences(
      manager,
      {
        queryCollections: async (...args) => db.queryCollections(...args),
        queryTracks: async (...args) => db.queryTracks(...args)
      },
      () => state.scanning,
      async () => ({ saved: true }),
      database,
      tasks
    )
    experiences.push(value)
    return value
  }
  db.legacyMusicBegin(
    PLUGIN,
    7,
    { config: { musicBrainzContact: 'https://example.com' }, albums: {} },
    0,
    collections.revision
  )
  db.legacyMusicPublish(PLUGIN, 7, collections.revision)
  t.after(async () => {
    await Promise.all(services.map((service) => service.shutdown()))
    await Promise.all(experiences.map((service) => service.shutdown()))
    db.close()
    rmSync(root, { recursive: true, force: true })
    assert.deepEqual(errors, [])
  })
  return { root, path, db, seeds, plugin, manager, database, batch, owner, experience, errors, state }
}
const idleLookup = (): LegacyMusicLookupProvider => ({
  blockedReason: async () => null,
  lookup: async () => introduction()
})

test('the production experience operations use the one durable Core worker and retain status semantics', async (t) => {
  const f = fixture(t),
    seen: LegacyMusicTaskWork[] = []
  const core = f.owner({
    blockedReason: async () => null,
    lookup: async (work) => {
      seen.push(work)
      if (work.operation === 'introductions') return introduction()
      if (work.operation === 'credits')
        return {
          state: 'legacy_result',
          taskState: 'completed',
          outcome: 'matched',
          reason: null,
          lookup: {
            operation: 'credits',
            value: {
              status: 'matched',
              credits: [
                {
                  name: 'Person',
                  role: '编曲',
                  source: 'QQ Music',
                  trackId: work.album.tracks[0].id
                }
              ]
            }
          }
        }
      return {
        state: 'legacy_result',
        taskState: 'needs_review',
        outcome: 'not_found',
        reason: 'ambiguous',
        lookup: {
          operation: 'enrich',
          value: { online: { status: 'uncertain', checkedAt: '2026-10-24' } }
        }
      }
    }
  })
  const service = f.experience(core)
  const before = readFileSync(join(f.root, 'plugin', 'music-metadata.json'), 'utf8')
  for (const op of ['introductions', 'credits', 'enrich'] as const) {
    const accepted = (await service.music(PLUGIN, op, { force: true })) as unknown as {
      batchId: string
      total: number
    }
    assert.ok(accepted.batchId)
    assert.equal(accepted.total, 2)
    await until(() => !f.db.legacyMusicTaskStatus(PLUGIN, op)!.running)
    const status = (await service.music(PLUGIN, 'status', {})) as unknown as Record<
      string,
      { completed: number; total: number; updated: number; needsReview: number }
    >
    assert.equal(status[op].completed, 2)
    assert.equal(status[op].total, 2)
    assert.equal(status[op].updated, op === 'enrich' ? 0 : 2)
    assert.equal(status[op].needsReview, op === 'enrich' ? 2 : 0)
  }
  assert.equal(seen.length, 6)
  assert.ok(
    seen.every((work) =>
      work.album.tracks.every((track) => track.audioUrl === '' && track.relativePath === '')
    )
  )
  assert.equal(f.db.metadataJobs({}).items.filter((job) => job.type === 'legacy').length, 6)
  assert.equal(f.db.sql.prepare('SELECT count(*) n FROM metadata_identity_links').get()!.n, 0)
  assert.equal(readFileSync(join(f.root, 'plugin', 'music-metadata.json'), 'utf8'), before)
  for (const seed of f.seeds) {
    const album = (f.db.legacyMusicRead(PLUGIN)!.value.albums as Record<string, MusicAlbum>)[
      seed.album.id
    ]
    assert.equal(album.description, 'New introduction')
    assert.equal(album.producers[0].role, '编曲')
  }
})

test('unpublished pages never execute; a restart abandons them and preserves published work', (t) => {
  const f = fixture(t),
    revision = f.db.legacyMusicRead(PLUGIN)!.revision
  f.db.legacyMusicBatchBegin(
    {
      id: 'staging',
      pluginId: PLUGIN,
      operation: 'credits',
      expected: 2,
      documentRevision: revision
    },
    1000
  )
  f.db.legacyMusicBatchStage('staging', [f.seeds[0]], 1000)
  assert.equal(f.db.metadataClaim(1000), null)
  assert.equal(f.db.metadataNextAttempt(), null)
  assert.throws(() => f.db.legacyMusicBatchPublish('staging', 1000), /incomplete/)
  f.batch('introductions')
  const lost = f.db.metadataClaim(1000)!
  f.db.metadataRecover(1001)
  assert.equal(f.db.legacyMusicTaskStatus(PLUGIN, 'credits')!.state, 'abandoned')
  assert.equal(f.db.legacyMusicTaskStatus(PLUGIN, 'credits')!.cancelled, 1)
  assert.equal(f.db.metadataFinish(lost, introduction('Late'), 1002), false)
  const next = f.db.metadataClaim(1002)!
  assert.equal(next.job.id, lost.job.id)
  assert.ok(next.job.generation > lost.job.generation)
  assert.equal(f.db.metadataFinish(next, introduction('Recovered'), 1003), true)
  assert.equal(
    (f.db.legacyMusicRead(PLUGIN)!.value.albums as Record<string, MusicAlbum>)[next.legacy!.albumId]
      .description,
    'Recovered'
  )
})

test('bad staged pages roll back and a later valid request is recoverable', (t) => {
  const f = fixture(t),
    revision = f.db.legacyMusicRead(PLUGIN)!.revision
  f.db.legacyMusicBatchBegin(
    {
      id: 'bad',
      pluginId: PLUGIN,
      operation: 'introductions',
      expected: 2,
      documentRevision: revision
    },
    1000
  )
  assert.throws(
    () =>
      f.db.legacyMusicBatchStage('bad', [f.seeds[0], { ...f.seeds[1], contentRevision: -1 }], 1000),
    /已变化/
  )
  assert.equal(f.db.metadataJobs({}).total, 0)
  assert.equal(f.db.metadataClaim(1000), null)
  f.db.metadataRecover(1001)
  assert.equal(f.db.legacyMusicTaskStatus(PLUGIN, 'introductions')!.state, 'abandoned')
  f.batch('introductions')
  assert.ok(f.db.metadataClaim(1002))
})

test('lookup result and job status publish in one transaction and keep a single pre-batch history snapshot', (t) => {
  const f = fixture(t)
  f.batch('introductions')
  const work = f.db.metadataClaim(1000)!
  const before = f.db.legacyMusicRead(PLUGIN)!
  f.db.sql.exec(
    "CREATE TRIGGER fail_legacy_status BEFORE UPDATE ON metadata_jobs WHEN new.state='completed' BEGIN SELECT RAISE(ABORT,'queue full'); END"
  )
  assert.throws(() => f.db.metadataFinish(work, introduction(), 1001), /queue full/)
  assert.deepEqual(f.db.legacyMusicRead(PLUGIN), before)
  assert.equal(f.db.metadataJobs({ jobId: work.job.id }).items[0].state, 'running')
  f.db.sql.exec('DROP TRIGGER fail_legacy_status')
  assert.equal(f.db.metadataFinish(work, introduction(), 1002), true)
  f.db.metadataFinish(f.db.metadataClaim(1003)!, introduction(), 1004)
  assert.deepEqual(f.db.legacyMusicHistory(PLUGIN).revisions, [7])
  assert.deepEqual(f.db.legacyMusicHistoryRead(PLUGIN, 7), before)
})

test('batch cancellation rejects late results without cancelling another lookup', (t) => {
  const f = fixture(t)
  const id = f.batch('introductions')
  f.batch('credits')
  const work = f.db.metadataClaim(1000)!
  assert.equal(work.job.legacy!.batchId, id)
  const cancelled = f.db.legacyMusicBatchCancel(PLUGIN, 'introductions', 1001)!
  assert.equal(cancelled.cancelled, 2)
  assert.equal(cancelled.running, false)
  assert.equal(f.db.metadataFinish(work, introduction('Late'), 1002), false)
  assert.equal(f.db.metadataClaim(1003)!.legacy!.operation, 'credits')
  assert.deepEqual(f.db.legacyMusicRead(PLUGIN)!.value.albums, {})
})

test('manual A-B-A edits and delete-recreate invalidate old results, while unrelated albums do not', (t) => {
  const f = fixture(t),
    selected = f.seeds[0],
    other = f.seeds[1]
  const edit = (albums: Record<string, unknown>) =>
    f.db.legacyMusicEdit(PLUGIN, {
      ...f.db.legacyMusicRead(PLUGIN)!,
      value: { ...f.db.legacyMusicRead(PLUGIN)!.value, albums }
    })
  edit({ [selected.album.id]: { localNote: 'A' } })
  for (const mode of ['aba', 'recreate', 'unrelated']) {
    f.batch('introductions', [selected])
    const work = f.db.metadataClaim(1000)!
    if (mode === 'aba') {
      edit({ [selected.album.id]: { localNote: 'B' } })
      edit({ [selected.album.id]: { localNote: 'A' } })
    } else if (mode === 'recreate') {
      edit({})
      edit({ [selected.album.id]: { localNote: 'A' } })
    } else
      edit({
        [selected.album.id]: { localNote: 'A' },
        [other.album.id]: { description: 'Other manual' }
      })
    assert.equal(f.db.metadataFinish(work, introduction(), 1001), mode === 'unrelated')
  }
  const albums = f.db.legacyMusicRead(PLUGIN)!.value.albums as Record<string, MusicAlbum>
  assert.equal(albums[other.album.id].description, 'Other manual')
  assert.equal(albums[selected.album.id].description, 'New introduction')
})

test('track tag changes reject old results without depending on the display sort for equal track numbers', (t) => {
  const f = fixture(t),
    selected = f.seeds.find((seed) => seed.album.tracks.length === 2)!
  f.batch('introductions', [selected])
  const work = f.db.metadataClaim(1000)!
  const version = f.db.getTracksByIds(['z']).versions.z
  f.db.patchTracks([{ id: 'z', expectedVersion: version, patch: { title: 'Changed' } }])
  assert.equal(f.db.metadataFinish(work, introduction(), 1001), false)
  // Seed a fresh snapshot with the current library revision.
  const refreshed: LegacyMusicTaskSeed = {
    ...selected,
    contentRevision: f.db.queryCollections('albums').revision
  }
  f.batch('introductions', [refreshed])
  assert.ok(f.db.metadataClaim(1002))
})

test('different automatic operations merge latest source data and never overwrite external-ai text', (t) => {
  const f = fixture(t),
    selected = f.seeds[0]
  f.batch('introductions', [selected])
  f.batch('enrich', [selected])
  f.batch('credits', [selected])
  const first = f.db.metadataClaim(1000)!
  f.db.metadataFinish(first, introduction('Wiki result'), 1001)
  const mb = f.db.metadataClaim(1002)!
  assert.equal(mb.legacy!.operation, 'enrich')
  f.db.metadataFinish(
    mb,
    {
      state: 'legacy_result',
      taskState: 'completed',
      outcome: 'matched',
      reason: null,
      lookup: {
        operation: 'enrich',
        value: {
          online: { status: 'matched' },
          description: mb.legacy!.album.description,
          rawGenres: ['Rock'],
          producers: [{ name: 'Producer', role: 'producer', source: 'MusicBrainz' }]
        }
      }
    },
    1003
  )
  const qq = f.db.metadataClaim(1004)!
  f.db.metadataFinish(
    qq,
    {
      state: 'legacy_result',
      taskState: 'completed',
      outcome: 'matched',
      reason: null,
      lookup: {
        operation: 'credits',
        value: {
          status: 'matched',
          credits: [
            {
              name: 'Arranger',
              role: '编曲',
              source: 'QQ Music',
              trackId: selected.album.tracks[0].id
            }
          ]
        }
      }
    },
    1005
  )
  const document = f.db.legacyMusicRead(PLUGIN)!,
    albums = document.value.albums as Record<string, MusicAlbum>
  assert.equal(albums[selected.album.id].description, 'Wiki result')
  assert.deepEqual(
    albums[selected.album.id].producers.map((person) => person.source),
    ['MusicBrainz', 'QQ Music']
  )
  albums[selected.album.id].description = 'Imported text'
  albums[selected.album.id].descriptionSource = {
    name: 'User',
    url: 'https://example.com',
    method: 'external-ai'
  }
  f.db.legacyMusicEdit(PLUGIN, document)
  f.batch('enrich', [selected])
  const work = f.db.metadataClaim(1006)!
  f.db.metadataFinish(
    work,
    {
      state: 'legacy_result',
      taskState: 'completed',
      outcome: 'matched',
      reason: null,
      lookup: {
        operation: 'enrich',
        value: {
          description: 'Replace me',
          descriptionSource: { name: 'wiki', url: 'https://en.wikipedia.org/wiki/Album' }
        }
      }
    },
    1007
  )
  assert.equal(
    (f.db.legacyMusicRead(PLUGIN)!.value.albums as Record<string, MusicAlbum>)[selected.album.id]
      .description,
    'Imported text'
  )
})

test('persistent busy status protects original task, preview, import, reconcile and restore entry points', async (t) => {
  const f = fixture(t),
    core = f.owner(idleLookup(), false),
    service = f.experience(core)
  f.batch('introductions')
  for (const op of ['task', 'preview', 'import', 'reconcile', 'restore'])
    await assert.rejects(service.music(PLUGIN, op, {}), /查询正在进行/)
  const status = (await service.music(PLUGIN, 'status', {})) as {
    introductions: { running: boolean }
  }
  assert.equal(status.introductions.running, true)
  f.state.scanning = true
  await service.music(PLUGIN, 'cancel', { operation: 'introductions' })
  f.state.scanning = false
  const task = (await service.music(PLUGIN, 'task', {})) as { albums: unknown[] }
  assert.equal(task.albums.length, 2)
})

test('permission revocation blocks a late provider commit', async (t) => {
  const f = fixture(t)
  let release!: (value: Result) => void,
    started = false
  const checks = createLegacyMusicLookupProvider({ plugins: f.manager })
  const core = f.owner({
    blockedReason: checks.blockedReason,
    lookup: async () => {
      started = true
      return new Promise((resolve) => {
        release = resolve
      })
    }
  })
  await core.startLegacyMusic(PLUGIN, 'introductions', 7, [f.seeds[0]])
  await until(() => started)
  f.plugin.permissions = f.plugin.permissions.filter((permission) => permission !== 'network')
  release(introduction('Unauthorized'))
  await until(() => f.db.legacyMusicTaskStatus(PLUGIN, 'introductions')!.blocked === 1)
  assert.deepEqual(f.db.legacyMusicRead(PLUGIN)!.value.albums, {})
})

test('a partial retry retains useful personnel, cools the whole batch and survives recovery', (t) => {
  const f = fixture(t)
  f.batch('credits')
  const work = f.db.metadataClaim(1000)!,
    selected = work.legacy!.album
  f.db.metadataFinish(
    work,
    {
      state: 'legacy_result',
      taskState: 'retry_wait',
      outcome: 'partial',
      reason: 'source 429',
      nextAttemptAt: 60000,
      lookup: {
        operation: 'credits',
        value: {
          status: 'partial',
          error: 'source 429',
          retryAt: new Date(60000).toISOString(),
          credits: [
            { name: 'Arranger', role: '编曲', source: 'QQ Music', trackId: selected.tracks[0].id }
          ]
        }
      }
    },
    1001
  )
  assert.equal(f.db.legacyMusicTaskStatus(PLUGIN, 'credits')!.updated, 1)
  assert.equal(f.db.metadataClaim(1002), null)
  f.db.metadataRecover(2000)
  assert.equal(f.db.metadataNextAttempt(), 60000)
  assert.equal(f.db.metadataClaim(59999), null)
  const retry = f.db.metadataClaim(60000)!
  assert.equal(retry.job.id, work.job.id)
  assert.equal(retry.job.attempts, 2)
  assert.equal(
    (f.db.legacyMusicRead(PLUGIN)!.value.albums as Record<string, MusicAlbum>)[selected.id]
      .producers[0].name,
    'Arranger'
  )
})

test('a blocked source stops remaining batch traffic and preserves independent operation demands', (t) => {
  const f = fixture(t)
  f.batch('credits')
  f.batch('introductions')
  const work = f.db.metadataClaim(1000)!
  f.db.metadataFinish(work, { state: 'blocked', reason: 'source HTTP 403' }, 1001)
  const status = f.db.legacyMusicTaskStatus(PLUGIN, 'credits')!
  assert.equal(status.blocked, 2)
  assert.equal(status.running, false)
  assert.equal(f.db.metadataClaim(1002)!.legacy!.operation, 'introductions')
})

test('real wiki and MB adapters preserve uncertain versus not-found and stop requests on revocation', async (t) => {
  const f = fixture(t),
    seed = f.seeds[0]
  const work: LegacyMusicTaskWork = {
    ...seed,
    pluginId: PLUGIN,
    batchId: 'provider',
    albumId: seed.album.id,
    operation: 'introductions',
    title: seed.album.title,
    contact: 'https://example.com'
  }
  let calls = 0
  const provider = createLegacyMusicLookupProvider({
    plugins: f.manager,
    fetcher: async () => {
      calls++
      return Response.json({ query: { pages: [] }, releases: [] })
    }
  })
  const uncertain = await provider.lookup(
    { ...work, album: { ...work.album, year: undefined } },
    1,
    new AbortController().signal
  )
  assert.equal(uncertain.taskState, 'needs_review')
  assert.equal(calls, 0)
  const missing = await provider.lookup(work, 1, new AbortController().signal)
  assert.equal(missing.taskState, 'completed')
  assert.equal(missing.outcome, 'not_found')
  const mb = await provider.lookup(
    { ...work, operation: 'enrich' },
    1,
    new AbortController().signal
  )
  assert.equal(mb.taskState, 'completed')
  assert.equal(mb.outcome, 'not_found')
  calls = 0
  const revoke = createLegacyMusicLookupProvider({
    plugins: f.manager,
    fetcher: async () => {
      calls++
      f.plugin.enabled = false
      return Response.json({ query: { pages: [] } })
    }
  })
  await revoke.lookup(work, 1, new AbortController().signal)
  assert.equal(calls, 1)
  assert.equal(await revoke.blockedReason(work), 'experience_disabled')
})

test('real QQ adapter retains partial credits and maps HTTP authentication, retry and permanent failures', async (t) => {
  const f = fixture(t),
    seed = f.seeds.find((value) => value.album.tracks.length === 2)!
  const work: LegacyMusicTaskWork = {
    ...seed,
    pluginId: PLUGIN,
    batchId: 'provider',
    albumId: seed.album.id,
    operation: 'credits',
    title: seed.album.title,
    contact: '',
    force: true
  }
  let now = 10 ** 13,
    calls = 0
  const partial = createLegacyMusicLookupProvider({
    plugins: f.manager,
    now: () => now,
    fetcher: async (_input, init) => {
      calls++
      const body = JSON.parse(String(init!.body))
      if (calls === 3) return new Response('{}', { status: 429, headers: { 'retry-after': '120' } })
      const key = Object.keys(body).find((key) => key !== 'comm')!,
        module = body[key].module
      return Response.json({
        code: 0,
        [key]: {
          code: 0,
          data: module.includes('Search')
            ? {
                body: {
                  song: {
                    list: [
                      {
                        mid: 'abc12345',
                        name: seed.album.tracks[0].title,
                        singer: [{ name: 'Artist' }],
                        interval: seed.album.tracks[0].duration
                      }
                    ]
                  }
                }
              }
            : { Lst: [{ Title: '编曲', Producers: [{ Name: 'Real provider person' }] }] }
        }
      })
    }
  })
  const result = await partial.lookup(work, 1, new AbortController().signal)
  assert.equal(result.lookup.operation, 'credits')
  if (result.lookup.operation !== 'credits') throw new Error('wrong lookup')
  assert.equal(result.lookup.value.credits[0].name, 'Real provider person')
  assert.equal(result.outcome, 'partial')
  assert.equal(result.taskState, 'retry_wait')
  assert.ok(result.nextAttemptAt! >= now + 120000)
  assert.equal(calls, 3)
  for (const status of [401, 403, 400, 503]) {
    now += 3600000
    const provider = createLegacyMusicLookupProvider({
      plugins: f.manager,
      now: () => now,
      fetcher: async () => new Response('{}', { status, headers: { 'retry-after': '60' } })
    })
    const result = await provider.lookup(work, 1, new AbortController().signal)
    assert.equal(
      result.taskState,
      status === 401 || status === 403 ? 'blocked' : status === 503 ? 'retry_wait' : 'failed'
    )
    if (status === 503) assert.ok(result.nextAttemptAt! >= now + 60000)
  }
})

test('cancelling the real QQ provider does not manufacture a source cooldown or cache failure', async (t) => {
  const f = fixture(t),
    seed = f.seeds[0]
  const work: LegacyMusicTaskWork = {
    ...seed,
    pluginId: PLUGIN,
    batchId: 'cancel-provider',
    albumId: seed.album.id,
    operation: 'credits',
    title: seed.album.title,
    contact: '',
    force: true
  }
  const controller = new AbortController()
  let started = false
  const provider = createLegacyMusicLookupProvider({
    plugins: f.manager,
    now: () => 2 * 10 ** 13,
    fetcher: async (_input, init) => {
      started = true
      return new Promise<Response>((_resolve, reject) =>
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
      )
    }
  })
  const task = provider.lookup(work, 1, controller.signal)
  await until(() => started)
  controller.abort(new Error('User cancelled'))
  await assert.rejects(task, /User cancelled/)
  assert.equal(existsSync(join(f.root, 'plugin', 'qq-credits-cache.json')), false)
})

test('an explicit wiki prohibition keeps legacy MB personnel available without fetching wiki text', async (t) => {
  const f = fixture(t),
    seed = f.seeds[0],
    releaseId = '11111111-1111-4111-8111-111111111111'
  const work: LegacyMusicTaskWork = {
    ...seed,
    album: { ...seed.album, online: { status: 'matched', releaseId } },
    pluginId: PLUGIN,
    batchId: 'policy',
    albumId: seed.album.id,
    operation: 'enrich',
    title: seed.album.title,
    contact: 'https://example.com'
  }
  const seen: string[] = []
  const provider = createLegacyMusicLookupProvider({
    plugins: f.manager,
    disabled: (operation) => (operation === 'introductions' ? 'wikipedia_text_disabled' : null),
    fetcher: async (input) => {
      const url = new URL(String(input))
      seen.push(url.hostname)
      return Response.json(
        url.pathname.includes('/release-group/')
          ? {
              relations: [
                { type: 'wikidata', url: { resource: 'https://www.wikidata.org/wiki/Q123' } }
              ]
            }
          : {
              'release-group': { id: releaseId },
              relations: [{ type: 'producer', artist: { name: 'Producer', id: releaseId } }]
            }
      )
    }
  })
  const result = await provider.lookup(work, 1, new AbortController().signal)
  assert.deepEqual(seen, ['musicbrainz.org', 'musicbrainz.org'])
  assert.equal(result.taskState, 'completed')
  assert.equal(result.outcome, 'partial')
  assert.equal(result.reason, 'wikipedia_text_disabled')
  assert.equal(result.lookup.operation, 'enrich')
  if (result.lookup.operation === 'enrich')
    assert.equal(result.lookup.value.producers![0].name, 'Producer')
})

test('three consecutive terminal failures pause remaining work, while a successful lookup resets the streak', (t) => {
  const f = fixture(t),
    original = f.seeds[0]
  const document = f.db.exportDocument()
  for (let n = 0; n < 6; n++)
    document.tracks.push({
      source: 'local',
      title: 'Extra',
      artist: 'Artist',
      duration: 200,
      id: `extra-${n}`,
      filePath: `D:/Extra/${n}/one.flac`,
      album: `Extra ${n}`
    })
  f.db.replaceDocument(document)
  while (f.db.catalogStatus().localPending) f.db.catalogAdvance()
  const collections = f.db.queryCollections('albums', { limit: 200 })
  const seeds = collections.items
    .filter((item) => item.name.startsWith('Extra'))
    .map((item) => ({
      ...original,
      collectionId: item.id,
      contentRevision: collections.revision,
      album: {
        ...original.album,
        id: legacyExperienceAlbumId(item.id),
        tracks: [{ ...original.album.tracks[0], id: `extra-${item.name.slice(-1)}` }]
      }
    }))
  f.batch('introductions', seeds)
  f.db.metadataFinish(f.db.metadataClaim(1000)!, { state: 'failed', reason: 'bad input' }, 1001)
  f.db.metadataFinish(f.db.metadataClaim(1002)!, introduction(), 1003)
  for (let n = 0; n < 3; n++)
    f.db.metadataFinish(
      f.db.metadataClaim(1004 + n * 2)!,
      { state: 'failed', reason: 'bad response' },
      1005 + n * 2
    )
  assert.equal(f.db.legacyMusicTaskStatus(PLUGIN, 'introductions')!.failed, 4)
  assert.equal(f.db.legacyMusicTaskStatus(PLUGIN, 'introductions')!.updated, 1)
  assert.equal(f.db.legacyMusicTaskStatus(PLUGIN, 'introductions')!.blocked, 1)
  assert.equal(f.db.metadataClaim(1010), null)
})

test('automatic patches do not invalidate staging another operation; manual edits still do', (t) => {
  const f = fixture(t)
  f.batch('introductions', [f.seeds[0]])
  const work = f.db.metadataClaim(1000)!
  f.db.legacyMusicBatchBegin(
    { id: 'overlap', pluginId: PLUGIN, operation: 'credits', expected: 1, documentRevision: 7 },
    1000
  )
  f.db.metadataFinish(work, introduction(), 1001)
  f.db.legacyMusicBatchStage('overlap', [f.seeds[0]], 1002)
  assert.equal(f.db.legacyMusicBatchPublish('overlap', 1003).running, true)
  f.db.legacyMusicBatchBegin(
    { id: 'manual', pluginId: PLUGIN, operation: 'enrich', expected: 1, documentRevision: 8 },
    1004
  )
  f.db.legacyMusicEdit(PLUGIN, { revision: 8, value: f.db.legacyMusicRead(PLUGIN)!.value })
  assert.throws(() => f.db.legacyMusicBatchStage('manual', [f.seeds[0]], 1005), /已变化/)
})

test('an accepted publication with a lost acknowledgement resumes without creating duplicate tasks', async (t) => {
  const f = fixture(t)
  const api = new Proxy(f.database, {
    get: (target, key) =>
      key === 'legacyMusicBatchPublish'
        ? async (...args: Parameters<LibraryDatabase['legacyMusicBatchPublish']>) => {
            f.db.legacyMusicBatchPublish(...args)
            throw new Error('publication ACK lost')
          }
        : Reflect.get(target, key)
  })
  const core = f.owner(idleLookup(), true, api)
  await assert.rejects(core.startLegacyMusic(PLUGIN, 'introductions', 7, f.seeds), /ACK lost/)
  await until(() => f.db.legacyMusicTaskStatus(PLUGIN, 'introductions')!.completed === 2)
  assert.equal(f.db.metadataJobs({}).total, 2)
  assert.equal(f.db.legacyMusicTaskStatus(PLUGIN, 'introductions')!.state, 'published')
})

test('Core cancellation aborts the active request and a new forced old-entry query can run', async (t) => {
  const f = fixture(t)
  let started = false,
    aborted = false,
    hold = true
  const core = f.owner({
    blockedReason: async () => null,
    lookup: async (_work, _attempts, signal) => {
      if (!hold) return introduction()
      started = true
      return new Promise<Result>((_resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => {
            aborted = true
            reject(signal.reason)
          },
          { once: true }
        )
      )
    }
  })
  const service = f.experience(core)
  await service.music(PLUGIN, 'introductions', { force: true })
  await until(() => started)
  await service.music(PLUGIN, 'cancel', { operation: 'introductions' })
  await until(() => aborted)
  assert.equal(f.db.legacyMusicTaskStatus(PLUGIN, 'introductions')!.cancelled, 2)
  hold = false
  await service.music(PLUGIN, 'introductions', { force: true })
  await until(() => f.db.legacyMusicTaskStatus(PLUGIN, 'introductions')!.updated === 2)
})

test('v19 upgrades snapshot the actual WAL data and seed manual input revisions', (t) => {
  const f = fixture(t)
  f.db.legacyMusicEdit(PLUGIN, {
    revision: 7,
    value: { albums: { original: { localNote: 'Keep' } } }
  })
  f.db.sql.exec(LEGACY_MUSIC_TASKS_SQL + 'PRAGMA user_version=19')
  const upgraded = new LibraryDatabase(f.path)
  try {
    assert.equal(upgraded.sql.prepare('PRAGMA user_version').get()!.user_version, 21)
    assert.equal(
      upgraded.sql.prepare('SELECT revision FROM metadata_legacy_inputs').get()!.revision,
      8
    )
    const backup = readdirSync(f.root).find((name) => name.includes('v19-backup'))!
    const snapshot = new DatabaseSync(join(f.root, backup), { readOnly: true })
    try {
      assert.equal(snapshot.prepare('PRAGMA user_version').get()!.user_version, 19)
      assert.equal(
        snapshot.prepare('SELECT revision FROM metadata_legacy_documents').get()!.revision,
        8
      )
    } finally {
      snapshot.close()
    }
  } finally {
    upgraded.close()
  }
})

test('a partial v20 DDL failure rolls back to the usable v19 document', (t) => {
  const f = fixture(t)
  f.db.sql.exec(LEGACY_MUSIC_TASKS_SQL + 'PRAGMA user_version=19')
  const exec = DatabaseSync.prototype.exec
  t.mock.method(DatabaseSync.prototype, 'exec', function (this: DatabaseSync, sql: string) {
    if (sql.includes('CREATE TABLE metadata_legacy_batches')) {
      exec.call(this, sql.slice(0, sql.indexOf('CREATE TABLE metadata_legacy_batches')))
      throw new Error('legacy task DDL full')
    }
    return exec.call(this, sql)
  })
  assert.throws(() => new LibraryDatabase(f.path), /DDL full/)
  assert.equal(f.db.sql.prepare('PRAGMA user_version').get()!.user_version, 19)
  assert.equal(
    f.db.sql
      .prepare("SELECT count(*) n FROM sqlite_master WHERE name='metadata_legacy_inputs'")
      .get()!.n,
    0
  )
  assert.equal(f.db.legacyMusicRead(PLUGIN)!.revision, 7)
})
