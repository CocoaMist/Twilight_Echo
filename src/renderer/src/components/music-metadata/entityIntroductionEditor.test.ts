import assert from 'node:assert/strict'
import test from 'node:test'
import { ref, shallowRef } from 'vue'
import { LibraryDatabase } from '../../../../main/library/libraryDatabase.ts'
import type {
  EntityMetadataDetail,
  EntityMetadataOverride
} from '../../../../shared/entityMetadata.ts'
import { createEntityIntroductionEditor } from './entityIntroductionEditor.ts'
import { createEntityMetadataView, collectionMetadataContext } from './entityMetadataView.ts'

const detail = (id = 'a', revision = 0): EntityMetadataDetail => ({
  entityId: id,
  revision,
  targetId: null,
  link: null,
  name: 'Name',
  introduction: { value: 'External text', language: 'en', origin: 'external', attribution: null },
  override: null,
  facts: []
})
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function fixture(
  t: test.TestContext,
  api: {
    override?: (request: EntityMetadataOverride) => Promise<unknown>
    refresh?: () => Promise<void>
  } = {}
) {
  const current = shallowRef<EntityMetadataDetail | null>(detail())
  const selected = ref<string | null>('a'),
    scope = ref('local:artist:en:epoch1'),
    available = ref(true)
  const calls: EntityMetadataOverride[] = []
  let reads = 0
  const editor = createEntityIntroductionEditor({
    scope: () => scope.value,
    selected: () => selected.value,
    detail: () => current.value,
    available: () => available.value,
    language: () => 'en',
    override: async (request) => {
      calls.push(request)
      return api.override?.(request)
    },
    refresh: async () => {
      reads++
      await api.refresh?.()
    }
  })
  t.after(editor.dispose)
  return { editor, current, selected, scope, available, calls, reads: () => reads }
}

test('manual drafts start with only manual text, enforce bounds and submit the loaded entity/revision/language once', async (t) => {
  const pending = deferred<unknown>()
  const f = fixture(t, { override: () => pending.promise })
  f.editor.begin('value')
  assert.equal(f.editor.state.value.value, '', 'external prose is not relabelled as manual text')
  assert.equal(f.editor.canSubmit.value, false)
  for (const invalid of ['  \n ', 'x'.repeat(20001), 'bad\0text']) {
    f.editor.value(invalid)
    await f.editor.submit()
    assert.equal(f.calls.length, 0)
  }
  f.editor.value('我的介绍')
  f.editor.language('zh-Hant')
  const saving = f.editor.submit()
  await f.editor.submit()
  f.editor.cancel()
  assert.equal(f.editor.state.value.saving, true)
  f.editor.value('late edit')
  assert.equal(f.editor.state.value.value, '我的介绍')
  assert.deepEqual(f.calls, [
    { entityId: 'a', revision: 0, mode: 'value', value: '我的介绍', language: 'zh-Hant' }
  ])
  pending.resolve({ ...detail('wrong'), introduction: { value: 'wrong raw source context' } })
  await saving
  assert.equal(f.reads(), 1, 'success rereads through the current source context')
  assert.equal(f.editor.state.value.mode, null)
  assert.equal(f.editor.state.value.notice, '介绍已保存')
})

test('background invalidation preserves a draft and requires explicit acknowledgement before rebasing its revision', async (t) => {
  const f = fixture(t)
  f.editor.begin('value')
  f.editor.value('My draft')
  f.current.value = null
  await f.editor.submit()
  assert.equal(f.calls.length, 0)
  f.current.value = {
    ...detail('a', 1),
    override: { mode: 'value', value: 'Other editor', language: 'en' }
  }
  assert.equal(f.editor.needsReview.value, true)
  assert.equal(f.editor.state.value.revision, 0)
  assert.equal(f.editor.state.value.value, 'My draft')
  await f.editor.submit()
  assert.equal(f.calls.length, 0)
  f.editor.acceptLatest()
  assert.equal(f.editor.state.value.value, 'My draft')
  assert.equal(f.editor.state.value.revision, 1)
  await f.editor.submit()
  assert.equal(f.calls[0].revision, 1)
})

test('a stale server revision rereads without replay and keeps the draft until intentional review and resubmission', async (t) => {
  let attempt = 0
  const f = fixture(t, {
    override: async () => {
      if (++attempt === 1) throw Object.assign(new Error('stale'), { code: 'STALE_REVISION' })
    },
    refresh: async () => {
      f.current.value = detail('a', 4)
    }
  })
  f.editor.begin('value')
  f.editor.value('Preserved')
  await f.editor.submit()
  assert.equal(f.calls.length, 1)
  assert.equal(f.reads(), 1)
  assert.match(f.editor.state.value.error, /草稿已保留/)
  assert.equal(f.editor.state.value.value, 'Preserved')
  assert.equal(f.editor.state.value.revision, 0)
  await f.editor.submit()
  assert.equal(f.calls.length, 1)
  f.editor.acceptLatest()
  await f.editor.submit()
  assert.equal(f.calls.length, 2)
  assert.equal(f.calls[1].revision, 4)
})

test('unknown command outcomes and permission errors retain drafts and never retry automatically', async (t) => {
  for (const code of ['OUTCOME_UNKNOWN', 'FORBIDDEN']) {
    const f = fixture(t, {
      override: async () => {
        throw Object.assign(new Error(code), { code })
      }
    })
    f.editor.begin('clear')
    await f.editor.submit()
    assert.equal(f.editor.state.value.mode, 'clear')
    assert.equal(f.editor.needsReview.value, true)
    assert.equal(f.reads(), 1)
    await f.editor.submit()
    assert.equal(f.calls.length, 1)
  }
})

test('clear and reset are deliberate separate commands, never empty manual values', async (t) => {
  const f = fixture(t)
  f.current.value = {
    ...detail(),
    override: { mode: 'value', value: 'Old manual', language: 'zh-Hant' }
  }
  f.editor.begin('value')
  assert.equal(f.editor.state.value.value, 'Old manual')
  assert.equal(f.editor.state.value.language, 'zh-Hant')
  f.editor.cancel()
  assert.equal(f.calls.length, 0)
  for (const mode of ['clear', 'reset'] as const) {
    f.editor.begin(mode)
    await f.editor.submit()
    assert.deepEqual(f.calls.at(-1), { entityId: 'a', revision: 0, mode, language: 'zh-Hant' })
  }
})

test('navigation, layer, language, source context and Core epoch changes cannot submit a previous draft', async (t) => {
  const f = fixture(t)
  for (const scope of [
    'local:release',
    'local:album_project',
    'local:album_project:zh-Hant',
    'ncm:album_project:zh-Hant',
    'epoch2'
  ]) {
    f.editor.begin('value')
    f.editor.value('Old scope')
    f.scope.value = scope
    await f.editor.submit()
    assert.equal(f.editor.state.value.mode, null)
    assert.equal(f.calls.length, 0)
  }
  f.editor.begin('value')
  f.editor.value('Old entity')
  f.selected.value = 'b'
  f.current.value = detail('b')
  await f.editor.submit()
  assert.equal(f.editor.state.value.mode, null)
  assert.equal(f.calls.length, 0)
})

test('temporarily missing or removed membership cannot write; late saves cannot refresh another page', async (t) => {
  const pending = deferred<unknown>()
  const f = fixture(t, { override: () => pending.promise })
  f.editor.begin('value')
  f.editor.value('Draft')
  f.selected.value = null
  f.current.value = null
  await f.editor.submit()
  assert.equal(f.calls.length, 0)
  assert.equal(f.editor.state.value.value, 'Draft')
  f.selected.value = 'a'
  f.current.value = detail()
  const saving = f.editor.submit()
  f.scope.value = 'other page'
  f.selected.value = 'b'
  f.current.value = detail('b')
  pending.resolve(null)
  await saving
  assert.equal(f.reads(), 0)
  assert.equal(f.editor.state.value.notice, '')
})

test('late failures after disposal cannot mutate draft state or trigger new reads', async (t) => {
  const pending = deferred<unknown>()
  const f = fixture(t, { override: () => pending.promise })
  f.editor.begin('clear')
  const saving = f.editor.submit()
  f.editor.dispose()
  const state = f.editor.state.value
  pending.reject(new Error('late'))
  await saving
  assert.equal(f.editor.state.value, state)
  assert.equal(f.reads(), 0)
})

test('original collection reading and real SQLite overrides stay coherent for value, clear, reset and conflicting writers', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  db.replaceDocument({
    version: 2,
    revision: 0,
    folders: [],
    exclusions: [],
    tracks: [
      {
        id: 'one',
        source: 'local',
        filePath: 'D:/one.flac',
        title: 'One',
        artist: 'Name',
        album: 'Album'
      }
    ]
  })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  let now = 1000
  const calls: EntityMetadataOverride[] = []
  const view = createEntityMetadataView({
    catalog: async (query) => db.catalogQuery(query),
    sources: async (query) => db.catalogSources(query),
    detail: async (id, language, sourceProvider) =>
      db.metadataDetail(id, language, { sourceProvider })
  })
  t.after(view.dispose)
  const target = collectionMetadataContext('artists', 'artist:Name')!
  await view.setContext(target, 'en')
  const id = view.state.value.detail!.entityId
  const editor = createEntityIntroductionEditor({
    scope: () => 'local:Name',
    selected: () => view.state.value.selected?.id ?? null,
    detail: () => view.state.value.detail,
    available: () => !view.state.value.detailLoading,
    language: () => 'en',
    refresh: view.refreshDetail,
    override: async (request) => {
      calls.push(request)
      return db.metadataOverride(request, now++)
    }
  })
  t.after(editor.dispose)
  editor.begin('value')
  editor.value('My introduction')
  await editor.submit()
  assert.equal(view.state.value.detail!.introduction!.value, 'My introduction')
  editor.begin('value')
  editor.value('My conflict draft')
  db.metadataOverride(
    { entityId: id, revision: 1, mode: 'value', value: 'Other writer', language: 'en' },
    now++
  )
  await editor.submit()
  assert.equal(view.state.value.detail!.introduction!.value, 'Other writer')
  assert.equal(editor.state.value.value, 'My conflict draft')
  assert.equal(editor.state.value.revision, 1)
  editor.acceptLatest()
  await editor.submit()
  assert.equal(view.state.value.detail!.introduction!.value, 'My conflict draft')
  editor.begin('clear')
  await editor.submit()
  assert.equal(view.state.value.detail!.introduction, null)
  assert.equal(view.state.value.detail!.override!.mode, 'clear')
  editor.begin('reset')
  await editor.submit()
  assert.equal(view.state.value.detail!.override, null)
  assert.equal(db.metadataJobs({}).total, 0, 'overrides and reset do not start network jobs')
  assert.ok(calls.every((c) => c.entityId === id))
})
