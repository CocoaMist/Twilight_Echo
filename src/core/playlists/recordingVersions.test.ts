import assert from 'node:assert/strict'
import test from 'node:test'
import { CoreStateDatabase } from '../../main/library/coreStateDatabase.ts'
import { emptyCoreStateCounts } from '../../shared/coreState.ts'
import { emptyMusicVersions, editMusicVersions } from '../../shared/musicVersions.ts'
import { CoreRecordingVersions } from './recordingVersions.ts'
import type { CoreVersionsApi } from '../../shared/coreVersions.ts'

function fixture(t: test.TestContext) {
  const db = new CoreStateDatabase(':memory:')
  db.begin('upgrade', { version: 1, counts: emptyCoreStateCounts() })
  db.commit('upgrade')
  let changes = 0,
    serial = 0,
    writes = 0
  const api = {
    coreStateRead: async (...args: Parameters<CoreStateDatabase['read']>) => db.read(...args),
    coreVersionsReplace: async (...args: Parameters<CoreVersionsApi['coreVersionsReplace']>) => {
      writes++
      return db.replaceVersions(...args)
    }
  }
  const versions = new CoreRecordingVersions(
    api,
    () => changes++,
    () => `v${++serial}`
  )
  t.after(() => db.close())
  return {
    db,
    api,
    versions,
    get changes() {
      return changes
    },
    get writes() {
      return writes
    }
  }
}

test('Core version edits retain source/family/preference rules, publish after SQL ACK and survive a fresh owner', async (t) => {
  const f = fixture(t)
  await f.versions.initialize()
  const edit = (operation: Parameters<typeof editMusicVersions>[2], keys: string[], label = '') =>
    f.versions.edit({ revision: f.versions.getRevision(), scope: 'tracks', operation, keys, label })
  await edit('sources', ['local:a', 'ncm:1'], 'Master')
  await edit('family', ['ncm:1', 'local:b'], 'Live')
  await edit('prefer-source', ['ncm:1'])
  await edit('prefer-version', ['local:b'])
  const saved = f.versions.snapshot()
  assert.equal(saved.tracks.versions.length, 2)
  assert.equal(
    saved.tracks.versions.find((v) => v.sources.includes('ncm:1'))!.preferredSource,
    'ncm:1'
  )
  assert.equal(
    saved.tracks.families[0].preferredVersion,
    saved.tracks.versions.find((v) => v.sources.includes('local:b'))!.id
  )
  const attached = new CoreRecordingVersions(f.api)
  await attached.initialize()
  assert.deepEqual(attached.snapshot(), saved)
  assert.equal(attached.getRevision(), 5)
  const page = await attached.page({ revision: 5, scope: 'tracks', kind: 'versions', limit: 1 })
  assert.equal(page.total, 2)
  assert.equal(page.items.length, 1)
  assert.equal(f.changes, 4)
})

test('concurrent commands reject stale previews; queued cancellation and failed writes leave no optimistic graph', async (t) => {
  const f = fixture(t)
  await f.versions.initialize()
  let release!: () => void, entered!: () => void
  const blocked = new Promise<void>((r) => (release = r)),
    saving = new Promise<void>((r) => (entered = r))
  const replace = f.api.coreVersionsReplace
  f.api.coreVersionsReplace = async (...args) => {
    entered()
    await blocked
    return replace(...args)
  }
  const payload = {
    revision: 1,
    scope: 'tracks' as const,
    operation: 'sources' as const,
    keys: ['a', 'b'],
    label: 'Master'
  }
  const first = f.versions.edit(payload),
    stale = assert.rejects(
      f.versions.edit(payload),
      (e: { code: string }) => e.code === 'STALE_REVISION'
    )
  const cancel = new AbortController()
  cancel.abort(new Error('cancelled'))
  const cancelled = assert.rejects(f.versions.edit(payload, cancel.signal), /cancelled/)
  await saving
  assert.deepEqual(f.versions.snapshot(), emptyMusicVersions())
  release()
  await first
  await stale
  await cancelled
  f.api.coreVersionsReplace = async () => {
    throw Error('disk write failed')
  }
  await assert.rejects(
    f.versions.edit({
      ...payload,
      revision: 2,
      operation: 'label',
      keys: ['a'],
      label: 'Rejected'
    }),
    /disk write failed/
  )
  assert.equal(f.versions.snapshot().tracks.versions[0].label, 'Master')
  assert.equal(f.versions.getRevision(), 2)
  await f.versions.flush()
})

test('a lost committed response is resolved by read and never replays its graph mutation', async (t) => {
  const f = fixture(t)
  await f.versions.initialize()
  const replace = f.api.coreVersionsReplace
  f.api.coreVersionsReplace = async (...args) => {
    await replace(...args)
    throw Error('response lost')
  }
  await assert.rejects(
    f.versions.edit({
      revision: 1,
      scope: 'albums',
      operation: 'sources',
      keys: ['a', 'b'],
      label: 'Album'
    }),
    /response lost/
  )
  assert.equal(f.writes, 1)
  assert.equal(f.versions.getRevision(), 2)
  assert.equal(f.versions.snapshot().albums.versions[0].label, 'Album')
  assert.deepEqual(
    (await f.versions.page({ revision: 2, scope: 'albums', kind: 'versions' })).items,
    f.versions.snapshot().albums.versions
  )
})

test('complete version replacement is atomic across hundreds of large rows and family references', async (t) => {
  const f = fixture(t)
  const document = emptyMusicVersions()
  for (let i = 0; i < 600; i++)
    document.tracks.versions.push({
      id: `v${String(i).padStart(4, '0')}`,
      label: 'Master',
      sources: [`${i}:${'x'.repeat(8000)}`],
      preferredSource: null
    })
  document.tracks.families.push({
    id: 'family',
    versions: document.tracks.versions.map((v) => v.id),
    preferredVersion: 'v0599'
  })
  assert.ok(Buffer.byteLength(JSON.stringify(document)) > 4 * 1024 * 1024)
  assert.equal(f.db.replaceVersions(document, 1), 2)
  await f.versions.initialize()
  assert.deepEqual(f.versions.snapshot(), document)
  f.db.sql.exec(
    "CREATE TRIGGER reject_version BEFORE INSERT ON core_state WHEN NEW.key='tracks:versions:v0001' BEGIN SELECT RAISE(ABORT, 'disk simulation'); END;"
  )
  assert.throws(() => f.db.replaceVersions(emptyMusicVersions(), 1), /revision conflict/)
  const next = structuredClone(document)
  next.tracks.versions[0].label = 'Changed'
  assert.throws(() => f.db.replaceVersions(next, 2), /disk simulation/)
  await f.versions.initialize()
  assert.equal(f.versions.getRevision(), 2)
  assert.deepEqual(f.versions.snapshot(), document)
})
