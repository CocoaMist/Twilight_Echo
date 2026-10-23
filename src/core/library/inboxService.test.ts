import assert from 'node:assert/strict'
import test from 'node:test'
import { CoreInboxService } from './inboxService.ts'
import { buildInboxIssues } from './inbox.ts'
import { libraryTrack } from '../playback/libraryTrack.ts'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import { CoreStateDatabase } from '../../main/library/coreStateDatabase.ts'
import { emptyCoreStateCounts, type CoreStateRow } from '../../shared/coreState.ts'
import type { LibraryTrackRecord } from '../../shared/libraryDatabase.ts'
import type { DuplicateDetectionResult } from '../../shared/duplicateDetection.ts'

const track = (id: string): LibraryTrackRecord => ({
  id,
  filePath: `D:/private/${id}.wav`,
  title: `Title ${id}`,
  artist: 'Artist',
  album: 'Album'
})
function fixture(t: test.TestContext, tracks = [track('one')], imported: CoreStateRow[] = []) {
  const library = new LibraryDatabase(':memory:')
  library.replaceDocument({ version: 2, revision: 4, tracks, folders: [], exclusions: [] })
  const state = new CoreStateDatabase(':memory:')
  state.begin('upgrade', {
    version: 1,
    counts: { ...emptyCoreStateCounts(), inbox: imported.length }
  })
  for (let i = 0; i < imported.length; i += 128)
    state.stage('upgrade', i / 128, 'inbox', imported.slice(i, i + 128))
  state.commit('upgrade')
  let serial = 0,
    writes = 0,
    loseReply = false
  let evidence = {
    revision: library.getMetadata().revision,
    result: {
      groups: [],
      suggestions: [],
      contentHashUnavailableIds: []
    } as DuplicateDetectionResult
  }
  const owners: CoreInboxService[] = []
  const create = async () => {
    const service = new CoreInboxService({
      database: {
        queryTracks: async (query) => library.queryTracks(query),
        getMetadata: async () => library.getMetadata(),
        coreStateRead: async (...args) => state.read(...args),
        coreInboxWrite: async (rows, revision, deletes, libraryRevision) => {
          assert.equal(libraryRevision, library.getMetadata().revision)
          writes++
          const result = state.write('inbox', rows, revision, deletes)
          if (loseReply) {
            loseReply = false
            throw new Error('Lost write reply')
          }
          return result
        }
      },
      duplicates: () => evidence,
      newId: () => `inbox:${++serial}`,
      changed: () => {}
    })
    owners.push(service)
    await service.initialize()
    return service
  }
  t.after(async () => {
    for (const owner of owners) await owner.shutdown()
    library.close()
    state.close()
  })
  return {
    library,
    state,
    create,
    writes: () => writes,
    loseReply: () => {
      loseReply = true
    },
    evidence: (value: typeof evidence) => {
      evidence = value
    }
  }
}

test('browser decisions survive SQL import and owner restart; concurrent old revisions cannot overwrite them', async (t) => {
  const source = track('one'),
    issue = buildInboxIssues([libraryTrack(source)])[0]
  const f = fixture(
    t,
    [source],
    [{ key: issue.key, value: { fingerprint: issue.fingerprint, status: 'ignored', order: 1 } }]
  )
  const service = await f.create(),
    view = await service.refresh()
  assert.equal((await service.page(view)).items[0].status, 'ignored')
  const command = { ...view, indexes: [0], status: 'done' as const }
  const first = service.mark(command),
    second = service.mark({ ...command, status: 'pending' })
  const updated = await first
  await assert.rejects(second, { code: 'STALE_REVISION' })
  assert.equal(updated.counts.done.cover, 1)
  const restarted = await f.create()
  assert.equal((await restarted.refresh()).counts.done.cover, 1)
  const next = { ...source, addedAt: 123 }
  f.library.replaceDocument({
    version: 2,
    revision: f.library.getMetadata().revision + 1,
    tracks: [next],
    folders: [],
    exclusions: []
  })
  await assert.rejects(service.mark({ ...updated, indexes: [0], status: 'ignored' }), {
    code: 'STALE_REVISION'
  })
  assert.equal((await restarted.refresh()).counts.pending.cover, 1)
})

test('lost committed reply reloads the result and never replays the write', async (t) => {
  const f = fixture(t),
    service = await f.create(),
    view = await service.refresh()
  f.loseReply()
  await assert.rejects(service.mark({ ...view, indexes: [0], status: 'done' }), /Lost write reply/)
  assert.equal(f.writes(), 1)
  assert.equal(service.state()!.counts.done.cover, 1)
  await assert.rejects(service.mark({ ...view, indexes: [0], status: 'ignored' }), {
    code: 'STALE_REVISION'
  })
  assert.equal(f.writes(), 1)
})

test('decision retention uses browser insertion order rather than SQL key order', async (t) => {
  const imported = Array.from({ length: 20000 }, (_, i) => ({
    key: `old:${String(20000 - i).padStart(5, '0')}`,
    value: { fingerprint: 'old', status: 'done', order: i + 1 }
  }))
  const f = fixture(t, undefined, imported),
    service = await f.create(),
    view = await service.refresh()
  await service.mark({ ...view, indexes: [0], status: 'ignored' })
  const keys = new Set<string>()
  let after: string | undefined
  do {
    const page = f.state.read('inbox', after, 128)
    page.rows.forEach((row) => keys.add(row.key))
    after = page.next ?? undefined
  } while (after)
  assert.equal(keys.size, 20000)
  assert.equal(keys.has(imported[0].key), false)
  assert.equal(keys.has(imported.at(-1)!.key), true)
})

test('duplicate evidence is revision fenced and membership changes reset the review decision', async (t) => {
  const tracks = [track('one'), track('two'), track('three')],
    f = fixture(t, tracks),
    service = await f.create()
  const result = (members: LibraryTrackRecord[]): DuplicateDetectionResult => ({
    groups: [
      {
        key: 'same',
        kind: 'metadataCandidate',
        confidence: 'possible',
        items: members.map(libraryTrack)
      }
    ],
    suggestions: [],
    contentHashUnavailableIds: []
  })
  const revision = f.library.getMetadata().revision
  f.evidence({ revision: revision - 1, result: result(tracks) })
  await assert.rejects(service.refresh('duplicates'), { code: 'STALE_REVISION' })
  f.evidence({ revision, result: result(tracks.slice(0, 2)) })
  const view = await service.refresh('duplicates'),
    page = await service.page({ ...view, kind: 'duplicate' })
  await service.mark({ ...view, indexes: [page.items[0].index], status: 'done' })
  f.evidence({ revision, result: result([tracks[0], tracks[2]]) })
  assert.equal((await service.refresh('duplicates')).counts.pending.duplicate, 2)
})

test('large inbox remains Core-owned and public pages omit private identities and paths', async (t) => {
  const f = fixture(
      t,
      Array.from({ length: 431 }, (_, i) => track(String(i)))
    ),
    service = await f.create()
  const view = await service.refresh(),
    page = await service.page({ ...view, offset: 200, limit: 200 })
  assert.equal(view.total, 431)
  assert.equal(page.items.length, 200)
  assert.equal(page.items[0].index, 200)
  assert.doesNotMatch(JSON.stringify({ view, page }), /filePath|private|fingerprint|"key"/)
  const replacement = await service.refresh()
  assert.notEqual(replacement.id, view.id)
  await assert.rejects(service.page(view), { code: 'STALE_REVISION' })
})
