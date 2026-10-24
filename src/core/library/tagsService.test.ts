import assert from 'node:assert/strict'
import test from 'node:test'
import { CoreMusicTagsService } from './tagsService.ts'
import type { CorePlaybackSession } from '../playback/session.ts'
import type { MusicTag, MusicTagsDatabaseApi, MusicTagsPlaybackPage, MusicTagsToken } from '../../shared/musicTags.ts'
import type { LibraryQueueSeedItem } from '../../shared/libraryQueueBuild.ts'
import type { TrackData } from '../../shared/track.ts'

const token = (): MusicTagsToken => ({ tagsRevision: 1, catalogRevision: 2, contentRevision: 3, linkRevision: 4 })
const tag = (): MusicTag => ({ id: 'tag:one', name: 'Night', nameRevision: 1, membersRevision: 1, memberCount: 1, updatedAt: 1 })
const track = (n: number): TrackData => ({ id: `track:${n}`, source: n % 2 ? 'ncm' : 'local', ncmSongId: n,
  title: `Song ${n}`, artist: 'Artist', album: 'Album', duration: 100, filePath: n % 2 ? '' : `D:/private/${n}.flac`,
  fileName: `${n}.flac`, size: 0, cover: null, lyrics: 'not retained in queue' })
function fixture(total = 205) {
  let current = token(), changes = 0, queries = 0, restoreCalls = 0
  let accepted: LibraryQueueSeedItem[] = [{ id: 'old-queue' }], selected = -1
  const batches: number[] = []
  let afterProduce: (() => void) | undefined, afterBeforeAdopt: (() => void) | undefined, afterAppend: (() => void) | undefined
  let pageOverride: ((page: MusicTagsPlaybackPage) => MusicTagsPlaybackPage) | undefined
  const database: MusicTagsDatabaseApi = {
    tagsState: async () => ({ ...current }),
    tagsList: async () => ({ token: { ...current }, offset: 0, total: 1, items: [tag()] }),
    tagsEntity: async q => ({ token: { ...current }, entityId: q.entityId, offset: 0, total: 1, items: [tag()] }),
    tagsMembers: async () => ({ token: { ...current }, tag: tag(), offset: 0, total: 0, items: [] }),
    tagsRecordings: async () => ({ token: { ...current }, tag: tag(), offset: 0, total: 0, items: [] }),
    tagsCreate: async () => ({ token: { ...current }, tag: tag() }),
    tagsRename: async () => ({ token: { ...current }, tag: tag() }),
    tagsDelete: async q => ({ token: { ...current }, deletedId: q.tagId }),
    tagsMemberSet: async () => ({ token: { ...current }, tag: tag() }),
    tagsPlaybackPage: async query => {
      queries++
      assert.equal(query.limit, 100)
      assert.deepEqual(query.token, token())
      const offset = query.offset ?? 0
      const items = Array.from({ length: Math.min(query.limit ?? 50, Math.max(0, total - offset)) }, (_, i) => {
        const n = offset + i
        return { recordingId: `recording:${n}`, sourceId: `source:${n}`, title: `Song ${n}`, artist: 'Artist', provider: n % 2 ? 'ncm' : 'local', sourceCount: 1, track: track(n) }
      })
      const page = { token: { ...current }, tag: tag(), offset, total, items }
      return pageOverride ? pageOverride(page) : page
    }
  }
  const playback: Pick<CorePlaybackSession, 'fromPages'> = {
    async fromPages(produce, options = {}, signal) {
      options.guard?.()
      const staged: LibraryQueueSeedItem[] = []
      await produce(async items => {
        signal?.throwIfAborted(); batches.push(items.length); staged.push(...items); afterAppend?.()
      })
      afterProduce?.()
      await options.beforeAdopt?.(true)
      afterBeforeAdopt?.()
      options.guard?.()
      signal?.throwIfAborted()
      selected = typeof options.selectedIndex === 'function' ? options.selectedIndex() : options.selectedIndex ?? 0
      accepted = staged
    }
  }
  const service = new CoreMusicTagsService({ database, playback, now: () => 10, changed: () => { changes++ } })
  const controller = new AbortController()
  const restore = async (item: TrackData, signal: AbortSignal) => { signal.throwIfAborted(); restoreCalls++; return item }
  return { service, controller, restore, database, read: () => ({ accepted, batches, selected, changes, queries, restoreCalls }),
    setToken(value: MusicTagsToken) { current = { ...value } },
    afterProduce(fn: () => void) { afterProduce = fn }, afterBeforeAdopt(fn: () => void) { afterBeforeAdopt = fn },
    afterAppend(fn: () => void) { afterAppend = fn }, pageOverride(fn: (page: MusicTagsPlaybackPage) => MusicTagsPlaybackPage) { pageOverride = fn } }
}

test('tags service plays bounded private pages into hidden builder and starts at requested source without copying lyrics', async () => {
  const f = fixture()
  const result = await f.service.play({ tagId: 'tag:one', token: token(), sourceId: 'source:150' }, f.controller.signal, f.restore)
  assert.deepEqual(result, { total: 205, selectedIndex: 150 })
  const state = f.read()
  assert.deepEqual(state.batches, [100, 100, 5]); assert.equal(state.queries, 3); assert.equal(state.restoreCalls, 205)
  assert.equal(state.selected, 150); assert.equal(state.accepted.length, 205)
  assert.equal(state.accepted[0].localSnapshot!.filePath, 'D:/private/0.flac')
  assert.equal(state.accepted[1].snapshot!.filePath, '')
  assert.equal(state.accepted[0].localSnapshot!.lyrics, null)
  assert.equal(state.accepted[0].localSnapshot!.sourceSelection, 'explicit')
  assert.equal(state.accepted[1].snapshot!.sourceSelection, 'explicit')
  f.service.observe({ ...token(), tagsRevision: 2 })
  assert.equal(f.read().accepted.length, 205, 'editing tags after adoption does not change the frozen queue')
})

test('empty, stale selected source, authorization failure, and incomplete pages all preserve previous queue', async () => {
  const empty = fixture(0)
  await assert.rejects(empty.service.play({ tagId: 'tag:one', token: token() }, empty.controller.signal, empty.restore), /暂无库内歌曲/)
  assert.deepEqual(empty.read().accepted, [{ id: 'old-queue' }])
  const missing = fixture(1)
  await assert.rejects(missing.service.play({ tagId: 'tag:one', token: token(), sourceId: 'absent' }, missing.controller.signal, missing.restore), { code: 'STALE_REVISION' })
  assert.deepEqual(missing.read().accepted, [{ id: 'old-queue' }])
  const unauthorized = fixture(1)
  await assert.rejects(unauthorized.service.play({ tagId: 'tag:one', token: token() }, unauthorized.controller.signal), { code: 'FORBIDDEN' })
  assert.deepEqual(unauthorized.read().accepted, [{ id: 'old-queue' }])
  const incomplete = fixture(1)
  incomplete.pageOverride(page => ({ ...page, items: [] }))
  await assert.rejects(incomplete.service.play({ tagId: 'tag:one', token: token() }, incomplete.controller.signal, incomplete.restore), /分页不完整/)
  assert.deepEqual(incomplete.read().accepted, [{ id: 'old-queue' }])
})

test('cancellation while appending never replaces the existing queue', async () => {
  const f = fixture()
  f.afterAppend(() => f.controller.abort(new Error('cancelled by caller')))
  await assert.rejects(f.service.play({ tagId: 'tag:one', token: token() }, f.controller.signal, f.restore), /cancelled by caller/)
  assert.deepEqual(f.read().accepted, [{ id: 'old-queue' }]); assert.equal(f.read().queries, 1)
})

test('beforeAdopt reads current durable state even if its event has not arrived', async () => {
  for (const key of ['tagsRevision', 'catalogRevision', 'contentRevision', 'linkRevision'] as const) {
    const f = fixture(1)
    f.afterProduce(() => f.setToken({ ...token(), [key]: token()[key] + 1 }))
    await assert.rejects(f.service.play({ tagId: 'tag:one', token: token() }, f.controller.signal, f.restore), { code: 'STALE_REVISION' })
    assert.deepEqual(f.read().accepted, [{ id: 'old-queue' }], key)
  }
})

test('synchronous adoption guard rejects durable changes after the final asynchronous read', async () => {
  const f = fixture(1)
  f.afterBeforeAdopt(() => f.service.observe({ ...token(), linkRevision: 5 }))
  await assert.rejects(f.service.play({ tagId: 'tag:one', token: token() }, f.controller.signal, f.restore), { code: 'STALE_REVISION' })
  assert.deepEqual(f.read().accepted, [{ id: 'old-queue' }])
})

test('older read replies cannot roll back a newer event or reopen an obsolete playback token', async () => {
  const f = fixture(1), latest = { ...token(), tagsRevision: 2, linkRevision: 5 }
  f.service.observe(latest)
  const page = await f.service.list({})
  assert.deepEqual(page.token, token())
  assert.deepEqual(f.service.getToken(), latest)
  assert.equal(f.service.getRevision(), 2); assert.equal(f.service.getLinkRevision(), 5)
  await assert.rejects(f.service.play({ tagId: 'tag:one', token: token() }, f.controller.signal, f.restore), { code: 'STALE_REVISION' })
  assert.equal(f.read().queries, 0)
})

test('write wrappers pass independent CAS inputs to local database and observe returned revision', async () => {
  const f = fixture(1), calls: unknown[] = []
  f.database.tagsRename = async (input, now) => { calls.push([input, now]); return { token: { ...token(), tagsRevision: 2 }, tag: { ...tag(), name: 'Later', nameRevision: 2 } } }
  const value = await f.service.rename({ tagId: 'tag:one', name: 'Later', nameRevision: 1 })
  assert.equal(value.tag.name, 'Later')
  assert.deepEqual(calls, [[{ tagId: 'tag:one', name: 'Later', nameRevision: 1 }, 10]])
  assert.equal(f.service.getRevision(), 2)
  await f.service.entity({ entityId: 'recording:one' }); await f.service.members({ tagId: 'tag:one' }); await f.service.recordings({ tagId: 'tag:one' })
  assert.equal(f.service.getRevision(), 2)
})

test('a valid newer token can be verified before adoption and a forged future token cannot poison observed revisions', async () => {
  const f = fixture(1)
  f.service.observe({ tagsRevision: 0, catalogRevision: 0, contentRevision: 0, linkRevision: 0 })
  assert.deepEqual(await f.service.play({ tagId: 'tag:one', token: token() }, f.controller.signal, f.restore), { total: 1, selectedIndex: 0 })
  await assert.rejects(f.service.play({ tagId: 'tag:one', token: { ...token(), tagsRevision: 999 } }, f.controller.signal, f.restore), { code: 'STALE_REVISION' })
  assert.deepEqual(f.service.getToken(), token())
})
