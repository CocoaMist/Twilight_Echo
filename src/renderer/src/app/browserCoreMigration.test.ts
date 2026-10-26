import assert from 'node:assert/strict'
import test from 'node:test'
import { CoreStateDatabase } from '../../../main/library/coreStateDatabase.ts'
import {
  CORE_STATE_BATCH_BYTES,
  CORE_STATE_DOMAINS,
  coreStateBatches,
  type CoreStateRow
} from '../../../shared/coreState.ts'
import { isCoreRequest } from '../../../shared/coreProtocol.ts'
import { migrateBrowserMusicData, openBrowserMusicMigrationSource } from './browserCoreMigration.ts'

function storageFixture(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial))
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    }
  }
}
function apiFixture(database: CoreStateDatabase) {
  return {
    coreStateStatus: async () => database.status(),
    coreMigrationBegin: async (...args: Parameters<CoreStateDatabase['begin']>) =>
      database.begin(...args),
    coreMigrationStage: async (...args: Parameters<CoreStateDatabase['stage']>) =>
      database.stage(...args),
    coreMigrationCommit: async (id: string) => database.commit(id)
  }
}

test('browser migration retains an oversized legacy version row, multibyte identities and every personal field across a lost stage reply', async () => {
  // A valid document below the old 8 Mi-character limit can exceed 4 MiB UTF-8.
  const largeVersion = {
    id: 'large',
    label: '大版本',
    sources: Array.from({ length: 1000 }, (_, i) => `local:${i}:${'汉'.repeat(3000)}`),
    preferredSource: null
  }
  const document = {
    version: 1,
    tracks: {
      versions: [
        largeVersion,
        { id: 'other', label: 'Other', sources: ['ncm:1'], preferredSource: 'ncm:1' }
      ],
      families: [{ id: 'family', versions: ['large', 'other'], preferredVersion: 'large' }]
    },
    albums: { versions: [], families: [] }
  }
  const versions = JSON.stringify(document)
  assert.ok(versions.length < 8 * 1024 * 1024)
  assert.ok(Buffer.byteLength(versions) > CORE_STATE_BATCH_BYTES)
  const statistics = {
    days: { '2026-10-21': 42 },
    tracks: {
      'cue:track:1': {
        title: '第一首',
        artist: 'A',
        seconds: 42,
        plays: 2,
        skips: 1,
        completions: 1,
        lastPlayed: 1,
        addedAt: 0
      }
    }
  }
  const storage = storageFixture({
    'twilight.music-versions.v1': versions,
    'twilight-echo:listening-stats:v1': JSON.stringify(statistics),
    'twilight.library-inbox.v1': JSON.stringify({
      version: 1,
      entries: [['decision', { fingerprint: 'file:v1', status: 'ignored' }]]
    }),
    'twilight.podcast.defaultPlaybackRate': '1.25',
    'twilight-echo:eq-auto-preamp:v1': '1',
    'twilight-echo:eq-manual-preamp:v1': '-3'
  })
  const database = new CoreStateDatabase(':memory:'),
    api = apiFixture(database)
  let frozen = 0,
    closed = 0,
    droppedReply = false
  const stage = api.coreMigrationStage
  api.coreMigrationStage = async (...args) => {
    assert.equal(
      isCoreRequest({
        kind: 'command',
        name: 'migration.stage',
        requestId: 'fixture',
        epoch: 'epoch',
        payload: { id: args[0], batch: args[1], domain: args[2], rows: args[3] }
      }),
      true
    )
    const status = await stage(...args)
    if (!droppedReply) {
      droppedReply = true
      throw new Error('Injected lost stage reply')
    }
    return status
  }
  const options = {
    api,
    storage,
    freezeBusinessWrites: () => {
      frozen++
    },
    newId: () => 'migration',
    source: async () => {
      assert.ok(frozen > 0)
      const source = await openBrowserMusicMigrationSource(storage)
      return {
        ...source,
        close: async () => {
          closed++
          await source.close()
        }
      }
    }
  }
  try {
    await assert.rejects(migrateBrowserMusicData(options), /lost stage reply/)
    assert.equal(database.status().complete, false)
    assert.deepEqual(database.read('versions').rows, [])
    assert.equal(database.status().nextBatch, 1)
    // A stale browser hint cannot replace the database's active migration ID.
    storage.setItem('twilight.core-migration.session.v1', 'stale-browser-hint')
    const result = await migrateBrowserMusicData(options)
    assert.equal(result.complete, true)
    const versionRows: CoreStateRow[] = []
    let after: string | undefined
    do {
      const page = database.read('versions', after)
      versionRows.push(...page.rows)
      after = page.next ?? undefined
    } while (after)
    assert.equal(versionRows.length, 3)
    assert.deepEqual(
      versionRows.find((row) => row.key === 'tracks:versions:large')!.value,
      largeVersion
    )
    assert.deepEqual(database.read('statistics-tracks').rows[0], {
      key: 'cue:track:1',
      value: statistics.tracks['cue:track:1']
    })
    assert.deepEqual(
      database.read('eq-preferences').rows.map((row) => row.value),
      [true, -3]
    )
    assert.equal(storage.getItem('twilight.music-versions.v1'), versions)
    assert.equal(storage.getItem('twilight-echo:listening-stats:v1'), JSON.stringify(statistics))
    assert.equal(closed, 2)
    assert.equal(frozen, 2)
    assert.equal(storage.getItem('twilight.core-migration.complete.v1'), 'migration')
    for (const domain of CORE_STATE_DOMAINS)
      assert.equal(result.counts[domain], result.manifest!.counts[domain])
  } finally {
    database.close()
  }
})

test('row/byte page boundaries are deterministic independently of IndexedDB cursor page size', async () => {
  const rows = Array.from({ length: 130 }, (_, i) => ({
    key: `row:${i}`,
    value: { fingerprint: '文'.repeat(15_000), status: 'done' }
  }))
  async function* pages(size: number) {
    for (let offset = 0; offset < rows.length; offset += size)
      yield rows.slice(offset, offset + size)
  }
  const batches = async (size: number) => {
    const values: CoreStateRow[][] = []
    for await (const batch of coreStateBatches('inbox', pages(size))) values.push(batch)
    return values
  }
  const first = await batches(128),
    second = await batches(37)
  assert.deepEqual(first, second)
  assert.equal(first.length, 2)
  assert.deepEqual(first.flat(), rows)
  for (const batch of first) {
    assert.ok(batch.length <= 128)
    assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= CORE_STATE_BATCH_BYTES)
  }
})

test('ordinary oversized rows fail before publication and retain the browser source for recovery', async () => {
  const storage = storageFixture({
    'twilight.library-inbox.v1': JSON.stringify({
      version: 1,
      entries: [['big', { fingerprint: 'x'.repeat(CORE_STATE_BATCH_BYTES), status: 'done' }]]
    })
  })
  const database = new CoreStateDatabase(':memory:')
  try {
    await assert.rejects(
      migrateBrowserMusicData({
        api: apiFixture(database),
        storage,
        freezeBusinessWrites() {},
        source: () => openBrowserMusicMigrationSource(storage),
        newId: () => 'migration'
      }),
      /supported legacy data limit/
    )
    assert.equal(database.status().complete, false)
    assert.ok(storage.getItem('twilight.library-inbox.v1'))
    assert.deepEqual(database.read('inbox').rows, [])
  } finally {
    database.close()
  }
})
