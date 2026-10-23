import assert from 'node:assert/strict'
import test from 'node:test'
import { nextTick } from 'vue'
import { coreLibraryFixture } from './coreLibraryTestFixture.ts'
import { createCoreMusicStore } from './library/coreMusicStore.ts'
import type { Playlist } from '../../../shared/playlists.ts'

const clone = <T>(value: T): T => structuredClone(value)
const base = (aggregate = false): Playlist[] => [
  { id: 'favorite', name: 'Favorite', trackIds: [], isDefault: true, createdAt: '' },
  {
    id: 'shared',
    name: 'Road Mix',
    trackIds: ['local:one'],
    createdAt: '',
    ...(aggregate ? { kind: 'aggregate' as const } : {})
  }
]
const tick = async () => {
  await nextTick()
  await new Promise<void>((resolve) => setImmediate(resolve))
}

test('Core CAS recovery keeps concurrent authoritative members and rejects a queued stale renderer edit without replay', async (t) => {
  let revision = 1,
    authoritative = base(),
    saves = 0
  let release!: () => void, started!: () => void
  const hold = new Promise<void>((resolve) => {
    release = resolve
  })
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const envelope = () => ({
    version: 2 as const,
    revision,
    savedAt: '',
    data: clone(authoritative)
  })
  const f = await coreLibraryFixture(t, {
    repository: {
      load: async () => envelope(),
      save: async (data, expected) => {
        saves++
        assert.equal(expected, revision)
        if (saves === 1) {
          revision++
          authoritative.push({
            id: 'remote',
            name: 'Remote Only',
            trackIds: ['remote:track'],
            createdAt: ''
          })
          throw Object.assign(new Error('playlist revision changed'), {
            code: 'ERR_PERSISTENCE_REVISION_CONFLICT',
            current: envelope()
          })
        }
        if (saves === 2) {
          started()
          await hold
        }
        authoritative = clone(data)
        revision++
        return envelope()
      }
    }
  })
  const store = createCoreMusicStore(f.core)
  t.after(store.dispose)
  await store.loadPlaylists()
  const rename = store.renamePlaylist('shared', 'Road Renamed')
  await ready
  const cover = store.setPlaylistCover('shared', 'cover://second-action')
  const stale = assert.rejects(cover, { code: 'STALE_REVISION' })
  release()
  await rename
  await stale
  assert.equal(saves, 2)
  assert.ok(store.playlists.value.some((playlist) => playlist.id === 'remote'))
  assert.equal(store.playlistPersistenceNotice.value?.kind, 'revision-conflict-recovered')
  await store.setPlaylistCover('shared', 'cover://second-action')
  assert.equal(saves, 3)
  assert.equal(authoritative.find((playlist) => playlist.id === 'shared')?.name, 'Road Renamed')
  assert.equal(
    authoritative.find((playlist) => playlist.id === 'shared')?.cover,
    'cover://second-action'
  )
  assert.equal('trackIds' in store.playlists.value[0], false)
})

test('Core CAS replay preserves aggregate fields and concurrent members while the renderer retains descriptors only', async (t) => {
  let revision = 1,
    authoritative = base(true),
    saves = 0
  const envelope = () => ({
    version: 2 as const,
    revision,
    savedAt: '',
    data: clone(authoritative)
  })
  const f = await coreLibraryFixture(t, {
    repository: {
      load: async () => envelope(),
      save: async (data, expected) => {
        assert.equal(expected, revision)
        saves++
        if (saves === 1) {
          authoritative[1].trackIds.push('ncm:concurrent')
          revision++
          throw Object.assign(new Error('playlist revision changed'), {
            code: 'ERR_PERSISTENCE_REVISION_CONFLICT',
            current: envelope()
          })
        }
        authoritative = clone(data)
        revision++
        return envelope()
      }
    }
  })
  const store = createCoreMusicStore(f.core)
  t.after(store.dispose)
  await store.loadPlaylists()
  await store.setPlaylistPinned('shared', true)
  await store.setPlaylistHiddenSources('shared', ['ncm'])
  await store.setPlaylistVariantPreference('shared', 'local:one', 'ncm')
  const createdId = await store.createAggregatePlaylist('New aggregate')
  await tick()
  const merged = authoritative.find((playlist) => playlist.id === 'shared')!
  assert.equal(merged.kind, 'aggregate')
  assert.ok(merged.pinnedAt)
  assert.deepEqual(merged.hiddenSources, ['ncm'])
  assert.deepEqual(merged.variantPreferences, { 'local:one': 'ncm' })
  assert.deepEqual(merged.trackIds, ['local:one', 'ncm:concurrent'])
  assert.equal(authoritative.find((playlist) => playlist.id === createdId)?.kind, 'aggregate')
  assert.equal(store.playlists.value.find((playlist) => playlist.id === 'shared')?.count, 2)
})
