import assert from 'node:assert/strict'
import test from 'node:test'
import { shallowRef, nextTick } from 'vue'
import { createCoreMusicVersions } from './coreMusicVersions.ts'
import type { CoreSnapshot } from '../../../../shared/coreProtocol.ts'
import type { CoreVersionsEdit, CoreVersionsQuery } from '../../../../shared/coreVersions.ts'
import { emptyMusicVersions, editMusicVersions } from '../../../../shared/musicVersions.ts'

function fixture(t: test.TestContext) {
  let document = emptyMusicVersions(),
    revision = 0,
    serial = 0,
    loseReply = false
  const state = shallowRef({
    phase: 'ready',
    epoch: 'epoch-one',
    versionsRevision: revision
  } as CoreSnapshot)
  const reads: CoreVersionsQuery[] = [],
    writes: CoreVersionsEdit[] = []
  let gate: (() => Promise<void>) | null = null
  const core = {
    state,
    attach: async () => state.value,
    query: async (name: string, query: CoreVersionsQuery) => {
      assert.equal(name, 'versions.page')
      assert.equal(query.revision, revision)
      assert.ok((query.limit ?? 128) <= 128)
      reads.push(query)
      const rows = document[query.scope][query.kind],
        offset = query.offset ?? 0
      const result = {
        revision,
        total: rows.length,
        offset,
        items: structuredClone(rows.slice(offset, offset + (query.limit ?? 128)))
      }
      if (gate) {
        const wait = gate
        gate = null
        await wait()
      }
      return result
    },
    command: async (name: string, edit: CoreVersionsEdit) => {
      assert.equal(name, 'versions.edit')
      assert.equal(edit.revision, revision)
      writes.push(structuredClone(edit))
      document = editMusicVersions(
        document,
        edit.scope,
        edit.operation,
        edit.keys,
        edit.label,
        () => `core-${++serial}`
      )
      revision++
      state.value = { ...state.value, versionsRevision: revision }
      if (loseReply) throw Object.assign(new Error('Write reply lost'), { code: 'OUTCOME_UNKNOWN' })
      return { revision }
    }
  } as unknown as Parameters<typeof createCoreMusicVersions>[0]
  const store = createCoreMusicVersions(core)
  t.after(() => store.dispose())
  return {
    store,
    core,
    state,
    reads,
    writes,
    replace(next = emptyMusicVersions(), epoch = state.value.epoch) {
      document = next
      revision++
      state.value = { ...state.value, epoch, versionsRevision: revision }
    },
    setGate(wait: () => Promise<void>) {
      gate = wait
    },
    loseReply() {
      loseReply = true
    }
  }
}

test('version projection reads every bounded graph page, builds immutable source indexes and does not need browser storage', async (t) => {
  const f = fixture(t),
    document = emptyMusicVersions()
  document.tracks.versions = Array.from({ length: 259 }, (_, i) => ({
    id: `v${i}`,
    label: 'Version',
    sources: [`local:${i}`],
    preferredSource: null
  }))
  document.albums.versions = [
    { id: 'album', label: 'Album', sources: ['album:a', 'album:b'], preferredSource: 'album:b' }
  ]
  f.replace(document)
  await f.store.load()
  assert.equal(f.store.get().tracks.versions.length, 259)
  assert.equal(f.store.sourceVersion('tracks', 'local:258')?.id, 'v258')
  assert.equal(f.store.sourceVersion('albums', 'album:a')?.preferredSource, 'album:b')
  assert.deepEqual(
    f.reads.filter((q) => q.scope === 'tracks' && q.kind === 'versions').map((q) => q.offset),
    [0, 128, 256]
  )
  assert.throws(() => f.store.get().tracks.versions.push(document.tracks.versions[0]), TypeError)
  assert.equal(f.writes.length, 0)
})

test('version preview is a draft; saving sends one finite Core edit and adopts the authoritative identities', async (t) => {
  const f = fixture(t)
  await f.store.load()
  const draft = f.store.preview('tracks', 'sources', ['local:a', 'ncm:b'], 'Master')
  assert.equal(f.writes.length, 0)
  assert.equal(f.store.get().tracks.versions.length, 0)
  await f.store.save(draft.after, draft.before)
  assert.deepEqual(f.writes, [
    {
      revision: 0,
      scope: 'tracks',
      operation: 'sources',
      keys: ['local:a', 'ncm:b'],
      label: 'Master'
    }
  ])
  assert.equal(f.store.get().tracks.versions[0].id, 'core-1')
  assert.equal(f.store.sourceVersion('tracks', 'ncm:b')?.id, 'core-1')
  assert.equal(f.store.revision.value, 1)
  const second = createCoreMusicVersions(f.core)
  t.after(() => second.dispose())
  await second.load()
  assert.deepEqual(second.get(), f.store.get())
  assert.equal(f.writes.length, 1)
})

test('a changed Core revision rejects an old draft without writing; an unknown committed reply is read, never replayed', async (t) => {
  const f = fixture(t)
  await f.store.load()
  const old = f.store.preview('tracks', 'sources', ['local:a', 'ncm:b'], 'Old')
  f.replace()
  await assert.rejects(f.store.save(old.after, old.before), /重新预览/)
  assert.equal(f.writes.length, 0)
  await f.store.load()
  const next = f.store.preview('albums', 'sources', ['album:a', 'album:b'], 'Album')
  f.loseReply()
  await assert.rejects(f.store.save(next.after, next.before), /reply lost/)
  await f.store.load()
  assert.equal(f.store.get().albums.versions.length, 1)
  assert.equal(f.writes.length, 1)
  assert.equal(f.store.error.value, '')
})

test('an old epoch read cannot overwrite a newer Core projection', async (t) => {
  const f = fixture(t)
  let release!: () => void
  f.setGate(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  const old = f.store.load()
  const document = emptyMusicVersions()
  document.tracks.versions = [
    { id: 'new', label: 'New epoch', sources: ['local:new'], preferredSource: null }
  ]
  f.replace(document, 'epoch-two')
  await nextTick()
  await f.store.load()
  release()
  await old.catch(() => {})
  assert.equal(f.store.sourceVersion('tracks', 'local:new')?.id, 'new')
  assert.equal(f.store.revision.value, 1)
})
