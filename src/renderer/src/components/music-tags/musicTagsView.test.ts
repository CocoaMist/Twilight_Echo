import assert from 'node:assert/strict'
import test from 'node:test'
import { shallowRef } from 'vue'
import { createMusicTagsView, MUSIC_TAGS_PAGE_SIZE, observeMusicTagsView } from './musicTagsView.ts'
import { tagsFixture } from './musicTagsTest.fixture.ts'

test('entity tags and all-tags pages keep full totals and carry the frozen token', async () => {
  const f = tagsFixture(14)
  for (const tag of f.tags)
    f.references.set(tag.id, [
      {
        id: 'physical-local',
        kind: 'recording',
        title: 'Local',
        artist: '',
        inLibrary: false,
        sourceCount: 0
      }
    ])
  const view = createMusicTagsView(f.api)
  await view.setContext('physical-local', 'track')
  assert.equal(view.state.value.entity?.total, 14)
  assert.equal(view.state.value.entity?.items.length, MUSIC_TAGS_PAGE_SIZE)
  await view.entityPage(12)
  assert.equal(view.state.value.entity?.items.length, 2)
  assert.deepEqual(f.queries.at(-1)?.query.token, f.token())
  await view.toggleManager()
  await view.listPage(12)
  assert.equal(view.state.value.list?.total, 14)
  assert.equal(view.state.value.list?.items.length, 2)
  view.dispose()
})

test('name edits and exact physical member edits use separate revisions, never album project IDs', async () => {
  const f = tagsFixture(),
    view = createMusicTagsView(f.api)
  await view.setContext('physical-release', 'manual-album-context')
  await view.toggleManager()
  await view.member(f.tag('tag-1'), true)
  assert.deepEqual(f.writes[0], {
    name: 'tags.member.set',
    query: { tagId: 'tag-1', entityId: 'physical-release', present: true, membersRevision: 1 }
  })
  view.startRename(f.tag('tag-1'))
  view.setRenameName('夜间专辑')
  await view.rename()
  assert.deepEqual(f.writes[1], {
    name: 'tags.rename',
    query: { tagId: 'tag-1', name: '夜间专辑', nameRevision: 1 }
  })
  assert.equal(f.references.get('tag-1')?.length, 1)
  view.dispose()
})

test('create is explicit and deletion waits for a separate confirmation', async () => {
  const f = tagsFixture(),
    view = createMusicTagsView(f.api)
  await view.setContext('one', 'one')
  await view.toggleManager()
  view.setCreateName('')
  await view.create()
  assert.equal(f.writes.length, 0)
  view.setCreateName('跑步')
  await view.create()
  assert.deepEqual(f.writes[0], { name: 'tags.create', query: { name: '跑步', tagsRevision: 1 } })
  view.requestDelete(f.tag('tag-1'))
  assert.equal(f.writes.length, 1)
  view.cancelDelete()
  await view.confirmDelete()
  assert.equal(f.writes.length, 1)
  view.requestDelete(f.tag('tag-1'))
  await view.confirmDelete()
  assert.deepEqual(f.writes[1], {
    name: 'tags.delete',
    query: { tagId: 'tag-1', nameRevision: 1, membersRevision: 1 }
  })
  view.dispose()
})

test('offline references remain removable while recordings are the separate live expanded result', async () => {
  const f = tagsFixture(),
    view = createMusicTagsView(f.api)
  f.references.set('tag-1', [
    {
      id: 'release-missing',
      kind: 'release',
      title: '离线专辑',
      artist: '',
      inLibrary: false,
      sourceCount: 0
    }
  ])
  f.recordings.set('tag-1', [
    {
      recordingId: 'physical-song',
      title: 'Song',
      artist: '',
      sourceId: 'source-local',
      provider: 'local',
      sourceCount: 2
    }
  ])
  await view.setContext('current', 'one')
  await view.select(f.tag('tag-1'))
  assert.equal(view.state.value.members?.items[0].inLibrary, false)
  assert.equal(view.state.value.recordings?.total, 1)
  await view.member(view.state.value.members!.tag, false, 'release-missing')
  assert.equal(f.writes[0].query.entityId, 'release-missing')
  assert.equal(f.recordings.get('tag-1')?.length, 1)
  view.dispose()
})

test('stale writes retain intent without replay, reread obtains the new independent member revision', async () => {
  const f = tagsFixture(),
    view = createMusicTagsView(f.api)
  await view.setContext('one', 'one')
  await view.toggleManager()
  f.tags[0].membersRevision = 9
  await view.member(view.state.value.list!.items[0], true)
  assert.equal(view.state.value.blocked, true)
  assert.equal(view.state.value.intent?.kind, 'member')
  assert.equal(view.canSaveIntent.value, false)
  await view.refresh()
  assert.equal(f.writes.length, 1)
  assert.equal(view.canSaveIntent.value, true)
  await view.saveIntent()
  assert.equal(f.writes[1].query.membersRevision, 9)
  assert.equal(view.state.value.intent, null)
  view.dispose()
})

test('lost receipt preserves intent and a reread never repeats a mutation', async () => {
  const f = tagsFixture(),
    view = createMusicTagsView(f.api)
  await view.setContext('one', 'one')
  f.failWrite(new Error('disconnected'))
  view.setCreateName('夜间')
  await view.create()
  assert.match(view.state.value.error, /保存结果未确认/)
  assert.equal(view.state.value.intent?.kind, 'create')
  await view.refresh()
  assert.equal(f.writes.length, 1)
  assert.equal(view.state.value.createName, '夜间')
  view.discardIntent()
  assert.equal(view.state.value.intent, null)
  view.dispose()
})

test('revision invalidation preserves name draft; unknown-to-known bootstrap is not a change', async () => {
  const f = tagsFixture(),
    view = createMusicTagsView(f.api),
    snapshot = shallowRef({
      epoch: 'one',
      tagsRevision: null as number | null,
      catalogRevision: 1,
      libraryRevision: 1,
      tagsLinkRevision: 0,
      sequence: 0
    })
  const stop = observeMusicTagsView(view, {
    entityId: () => 'one',
    scope: () => 'one',
    snapshot: () => snapshot.value
  })
  await new Promise((resolve) => setImmediate(resolve))
  snapshot.value = { ...snapshot.value, tagsRevision: 1 }
  assert.equal(view.state.value.blocked, false)
  view.setCreateName('保留草稿')
  snapshot.value = { ...snapshot.value, sequence: 1 }
  assert.equal(view.ready.value, true)
  snapshot.value = { ...snapshot.value, tagsLinkRevision: 1 }
  assert.equal(view.state.value.entity, null)
  assert.equal(view.state.value.createName, '保留草稿')
  assert.equal(view.state.value.blocked, true)
  stop()
  view.dispose()
})

test('an epoch change discards late command receipts and requires an explicit read', async () => {
  const f = tagsFixture(),
    view = createMusicTagsView(f.api)
  await view.setContext('old', 'one')
  await view.toggleManager()
  let done!: () => void
  const original = f.api.memberSet
  f.api.memberSet = async (query) => {
    await new Promise<void>((resolve) => {
      done = resolve
    })
    return original(query)
  }
  const save = view.member(f.tag('tag-1'), true)
  view.invalidate(true)
  done()
  await save
  assert.equal(view.state.value.entity, null)
  assert.equal(view.state.value.blocked, true)
  assert.equal(view.state.value.intent?.kind, 'member')
  assert.equal(f.queries.length, 3)
  view.dispose()
})

test('context changes abort old reads and never apply an old entity response', async () => {
  const f = tagsFixture(),
    original = f.api.entity
  let complete!: () => void
  f.api.entity = async (query, signal) => {
    if (query.entityId === 'old')
      await new Promise<void>((resolve) => {
        complete = resolve
      })
    return original(query, signal)
  }
  const view = createMusicTagsView(f.api),
    old = view.setContext('old', 'one')
  await view.setContext('new', 'two')
  complete()
  await old
  assert.equal(view.state.value.entity?.entityId, 'new')
  view.dispose()
})

test('play uses the frozen complete tag and optional source anchor, not current Renderer rows', async () => {
  const f = tagsFixture(),
    view = createMusicTagsView(f.api)
  f.recordings.set(
    'tag-1',
    Array.from({ length: 15 }, (_, index) => ({
      recordingId: `song-${index}`,
      title: 'Song',
      artist: '',
      sourceId: `source-${index}`,
      provider: 'local',
      sourceCount: 1
    }))
  )
  await view.setContext('one', 'one')
  await view.select(f.tag('tag-1'))
  await view.play('source-3')
  assert.equal(view.state.value.recordings?.items.length, 12)
  assert.deepEqual(f.writes[0], {
    name: 'tags.play',
    query: { tagId: 'tag-1', token: f.token(), sourceId: 'source-3' }
  })
  assert.match(view.state.value.playNotice, /15 首，从第 4 首开始/)
  view.dispose()
})

test('cancel preparation aborts once, keeps the unknown outcome warning, and ignores late success', async () => {
  const f = tagsFixture(),
    view = createMusicTagsView(f.api)
  f.recordings.set('tag-1', [
    {
      recordingId: 'one',
      title: 'One',
      artist: '',
      sourceId: 'source',
      provider: 'local',
      sourceCount: 1
    }
  ])
  let done!: () => void, signal!: AbortSignal
  f.api.play = async (_query, value) => {
    signal = value
    await new Promise<void>((resolve) => {
      done = resolve
    })
    return { total: 1, selectedIndex: 0 }
  }
  await view.setContext('one', 'one')
  await view.select(f.tag('tag-1'))
  const pending = view.play()
  view.cancelPlay()
  assert.equal(signal.aborted, true)
  done()
  await pending
  assert.match(view.state.value.playNotice, /核对当前队列，不要重复点击/)
  assert.equal(view.state.value.playing, false)
  view.dispose()
})

test('unknown playback outcomes are never replayed by refresh', async () => {
  const f = tagsFixture(),
    view = createMusicTagsView(f.api)
  f.recordings.set('tag-1', [
    {
      recordingId: 'one',
      title: 'One',
      artist: '',
      sourceId: 'source',
      provider: 'local',
      sourceCount: 1
    }
  ])
  let calls = 0
  f.api.play = async () => {
    calls++
    throw new Error('receipt lost')
  }
  await view.setContext('one', 'one')
  await view.select(f.tag('tag-1'))
  await view.play()
  assert.match(view.state.value.playError, /核对当前队列/)
  await view.refresh()
  assert.equal(calls, 1)
  view.dispose()
})

test('a removed last-page item resets mutation pages instead of showing an inverted range', async () => {
  const f = tagsFixture(13),
    view = createMusicTagsView(f.api)
  await view.setContext('one', 'one')
  await view.toggleManager()
  await view.listPage(12)
  view.requestDelete(view.state.value.list!.items[0])
  await view.confirmDelete()
  assert.equal(view.state.value.list?.offset, 0)
  assert.equal(view.state.value.list?.total, 12)
  assert.equal(view.state.value.list?.items.length, 12)
  view.dispose()
})

test('mixed read tokens withdraw all pages and never retry automatically', async () => {
  const f = tagsFixture(),
    view = createMusicTagsView(f.api),
    original = f.api.list
  f.api.list = async (query, signal) => {
    const page = await original(query, signal)
    return { ...page, token: { ...page.token, tagsRevision: 9 } }
  }
  await view.setContext('one', 'one')
  await view.toggleManager()
  assert.equal(view.state.value.blocked, true)
  assert.equal(view.state.value.entity, null)
  assert.equal(view.state.value.list, null)
  assert.equal(f.queries.filter((item) => item.name === 'tags.list').length, 1)
  view.dispose()
})

test('closing a deleted selected tag lets explicit reread recover other tags', async () => {
  const f = tagsFixture(),
    view = createMusicTagsView(f.api)
  await view.setContext('one', 'one')
  await view.select(f.tag('tag-1'))
  f.tags.shift()
  view.invalidate()
  await view.refresh()
  assert.match(view.state.value.error, /标签已不存在/)
  view.closeSelection()
  await view.refresh()
  await view.toggleManager()
  assert.equal(view.ready.value, true)
  assert.equal(view.state.value.selectedId, null)
  assert.equal(view.state.value.list?.items[0].id, 'tag-2')
  view.dispose()
})

test('global mode bootstraps without an entity, pages all tags and manages retained offline references', async () => {
  const f = tagsFixture(14),
    view = createMusicTagsView(f.api)
  f.references.set('tag-14', [
    {
      id: 'orphan-release',
      kind: 'release',
      title: '离线发行',
      artist: '',
      inLibrary: false,
      sourceCount: 0
    }
  ])
  await view.setContext(null, '')
  assert.equal(view.ready.value, true)
  assert.equal(view.state.value.entity, null)
  assert.equal(f.queries[0].name, 'tags.list')
  await view.toggleManager()
  await view.listPage(12)
  assert.equal(view.state.value.list?.total, 14)
  await view.select(f.tag('tag-14'))
  assert.equal(view.state.value.members?.items[0].id, 'orphan-release')
  assert.equal(view.state.value.recordings?.total, 0)
  await view.member(view.state.value.members!.tag, false, 'orphan-release')
  assert.equal(view.state.value.members?.total, 0)
  assert.equal(f.writes[0].query.entityId, 'orphan-release')
  assert.equal(
    f.queries.some((item) => item.name === 'tags.entity'),
    false
  )
  await view.member(f.tag('tag-14'), true)
  assert.equal(f.writes.length, 1)
  view.dispose()
})

test('global tag names and deletion use the list snapshot without inventing an entity target', async () => {
  const f = tagsFixture(),
    view = createMusicTagsView(f.api)
  await view.setContext(null, 'library-tags')
  view.setCreateName('全局标签')
  await view.create()
  assert.equal(f.writes[0].query.tagsRevision, 1)
  view.startRename(f.tag('tag-1'))
  view.setRenameName('离线收藏')
  await view.rename()
  assert.equal(f.writes[1].query.nameRevision, 1)
  view.requestDelete(f.tag('tag-1'))
  await view.confirmDelete()
  assert.equal(f.writes[2].name, 'tags.delete')
  assert.equal(
    f.queries.every((item) => item.name === 'tags.list'),
    true
  )
  view.dispose()
})

test('global revision changes invalidate the list and preserve failed intent for explicit reread', async () => {
  const f = tagsFixture(),
    view = createMusicTagsView(f.api),
    snapshot = shallowRef({ epoch: 'one', tagsRevision: 1 })
  const stop = observeMusicTagsView(view, {
    entityId: () => null,
    scope: () => 'library-tags',
    snapshot: () => snapshot.value
  })
  await new Promise((resolve) => setImmediate(resolve))
  view.startRename(f.tag('tag-1'))
  view.setRenameName('保留名称')
  f.failWrite(Object.assign(new Error('stale'), { code: 'STALE_REVISION' }))
  await view.rename()
  snapshot.value = { epoch: 'two', tagsRevision: 2 }
  assert.equal(view.state.value.blocked, true)
  assert.equal(view.state.value.list, null)
  assert.equal(view.state.value.intent?.kind, 'rename')
  await view.refresh()
  assert.equal(view.ready.value, true)
  assert.equal(f.writes.length, 1)
  await view.saveIntent()
  assert.equal(f.writes.length, 2)
  stop()
  view.dispose()
})
