import assert from 'node:assert/strict'
import test from 'node:test'
import { createGenreWorkspaceView, GENRE_WORKSPACE_PAGE_SIZE } from './genreWorkspaceView.ts'
import type {
  GenreEdit,
  GenreMap,
  GenrePage,
  GenreQuery,
  GenreUnmappedPage,
  GenreUnmappedQuery,
  MusicGenreNode
} from '../../../../shared/musicGenres.ts'

const node = (
  id = 'jazz',
  parentId: string | null = null,
  ancestorIds: string[] = []
): MusicGenreNode => ({
  id,
  name: id === 'jazz' ? '爵士' : id,
  nameEn: id,
  parentId,
  ancestorIds,
  dictionaryVersion: 1,
  userModified: false,
  childCount: id === 'jazz' ? 1 : 0
})
const raw = {
  provider: 'local',
  value: 'Jazz-ish',
  normalized: 'jazz-ish',
  ignored: false,
  targetCount: 3
}
function fixture() {
  let revision = 7,
    fail = false
  const treeReads: GenreQuery[] = [],
    rawReads: GenreUnmappedQuery[] = [],
    writes: Array<GenreEdit | GenreMap> = []
  let changes = 0
  const view = createGenreWorkspaceView({
    tree: async (query) => {
      treeReads.push(query)
      if (query.revision !== undefined && query.revision !== revision)
        throw new Error('REVISION_CONFLICT')
      return {
        revision,
        dictionaryVersion: 1,
        offset: query.offset ?? 0,
        total: 21,
        items: [query.parentId === 'jazz' ? node('bebop', 'jazz', ['jazz']) : node()]
      }
    },
    unmapped: async (query) => {
      rawReads.push(query)
      return {
        revision,
        offset: query.offset ?? 0,
        total: 21,
        items: [{ ...raw, ignored: !!query.includeIgnored }]
      }
    },
    edit: async (query) => {
      writes.push(query)
      if (fail) throw new Error('REVISION_CONFLICT')
      return { revision: ++revision }
    },
    map: async (query) => {
      writes.push(query)
      if (fail) throw new Error('REVISION_CONFLICT')
      return { revision: ++revision, genreId: 'created' }
    },
    changed: () => {
      changes++
    }
  })
  return {
    view,
    treeReads,
    rawReads,
    writes,
    changes: () => changes,
    fail: (value: boolean) => {
      fail = value
    }
  }
}

test('genre workspace stays lazy, browses bounded hierarchy pages, and searches all layers separately', async () => {
  const f = fixture(),
    view = f.view
  view.setScope('epoch')
  assert.equal(f.treeReads.length + f.rawReads.length, 0)
  await view.toggle()
  assert.deepEqual(f.treeReads[0], { parentId: null, offset: 0, limit: GENRE_WORKSPACE_PAGE_SIZE })
  assert.equal(view.ready.value, true)
  await view.browse(node())
  assert.deepEqual(f.treeReads.at(-1), {
    parentId: 'jazz',
    offset: 0,
    limit: GENRE_WORKSPACE_PAGE_SIZE,
    revision: 7
  })
  await view.search('  bop ')
  assert.deepEqual(f.treeReads.at(-1), {
    search: 'bop',
    offset: 0,
    limit: GENRE_WORKSPACE_PAGE_SIZE,
    revision: 7
  })
  await view.treePage(20)
  assert.equal(f.treeReads.at(-1)?.offset, 20)
  await view.rawPage(20)
  assert.equal(f.rawReads.at(-1)?.offset, 20)
  assert.equal(f.writes.length, 0)
  view.dispose()
})

test('mapping requires an explicit target and preserves provider, original word and current revision', async () => {
  const f = fixture(),
    view = f.view
  await view.toggle()
  await view.map()
  assert.equal(f.writes.length, 0)
  view.selectRaw(raw)
  assert.equal(view.canMap.value, false)
  view.chooseMapTarget(node())
  await view.map()
  assert.deepEqual(f.writes, [
    { revision: 7, provider: 'local', value: 'Jazz-ish', genreId: 'jazz' }
  ])
  assert.equal(view.state.value.revision, 8)
  assert.equal(view.state.value.selectedRaw, null)
  assert.equal(f.changes(), 1)
})

test('create-and-map is a single write; ignores retain source-specific raw evidence and can be reversed', async () => {
  const f = fixture(),
    view = f.view
  await view.toggle()
  view.selectRaw(raw)
  view.create(true)
  assert.equal(view.canSave.value, false)
  view.patchDraft({ name: '融合爵士', nameEn: 'Jazz fusion' })
  await view.save()
  assert.deepEqual(f.writes[0], {
    revision: 7,
    provider: 'local',
    value: 'Jazz-ish',
    create: { name: '融合爵士', nameEn: 'Jazz fusion', parentId: null }
  })
  view.selectRaw(raw)
  await view.ignore()
  assert.deepEqual(f.writes[1], {
    revision: 8,
    provider: 'local',
    value: 'Jazz-ish',
    genreId: null,
    ignored: true
  })
  await view.filterRaw('', true)
  view.selectRaw({ ...raw, ignored: true })
  await view.ignore(false)
  assert.deepEqual(f.writes[2], {
    revision: 9,
    provider: 'local',
    value: 'Jazz-ish',
    genreId: null,
    ignored: false
  })
})

test('parent choice rejects the selected node and known descendants; updates keep stable genre ID', async () => {
  const f = fixture(),
    view = f.view
  await view.toggle()
  view.select(node())
  assert.equal(view.parentAllowed(node()), false)
  assert.equal(view.parentAllowed(node('deep', 'bebop', ['jazz', 'bebop'])), false)
  view.setParent(node('deep', 'bebop', ['jazz', 'bebop']))
  assert.equal(view.state.value.draft?.parentId, null)
  view.patchDraft({ name: '爵士乐' })
  view.setParent(node('popular'))
  await view.save()
  assert.deepEqual(f.writes[0], {
    action: 'update',
    revision: 7,
    genreId: 'jazz',
    name: '爵士乐',
    nameEn: 'jazz',
    parentId: 'popular'
  })
})

test('write conflicts retain draft and target and require explicit reread before another submission', async () => {
  const f = fixture(),
    view = f.view
  await view.toggle()
  view.select(node())
  view.patchDraft({ name: '自定义爵士' })
  f.fail(true)
  await view.save()
  assert.equal(view.state.value.draft?.name, '自定义爵士')
  assert.match(view.state.value.error, /REVISION_CONFLICT/)
  assert.equal(view.canSave.value, false)
  await view.save()
  assert.equal(f.writes.length, 1)
  f.fail(false)
  await view.refresh()
  assert.equal(view.canSave.value, true)
  assert.equal(view.state.value.draft?.name, '自定义爵士')
  await view.save()
  assert.equal(f.writes.length, 2)
})

test('late reads cannot repopulate a closed or reattached workspace', async () => {
  let resolveTree!: (page: GenrePage) => void, resolveRaw!: (page: GenreUnmappedPage) => void
  const signals: AbortSignal[] = []
  const view = createGenreWorkspaceView({
    tree: (_query, signal) => {
      signals.push(signal)
      return new Promise((resolve) => {
        resolveTree = resolve
      })
    },
    unmapped: (_query, signal) => {
      signals.push(signal)
      return new Promise((resolve) => {
        resolveRaw = resolve
      })
    },
    edit: async () => {
      throw new Error('unexpected write')
    },
    map: async () => {
      throw new Error('unexpected write')
    },
    changed: () => {}
  })
  const pending = view.toggle()
  await view.toggle()
  assert.equal(
    signals.every((signal) => signal.aborted),
    true
  )
  resolveTree({ revision: 1, dictionaryVersion: 1, offset: 0, total: 1, items: [node()] })
  resolveRaw({ revision: 1, offset: 0, total: 1, items: [raw] })
  await pending
  assert.equal(view.state.value.tree, null)
  assert.equal(view.state.value.unmapped, null)
  assert.equal(view.ready.value, false)
  view.setScope('new-epoch')
  assert.equal(view.state.value.draft, null)
})

test('inconsistent read snapshots and read failures disable writes rather than silently using stale data', async () => {
  const view = createGenreWorkspaceView({
    tree: async () => ({ revision: 3, dictionaryVersion: 1, offset: 0, total: 1, items: [node()] }),
    unmapped: async () => ({ revision: 4, offset: 0, total: 1, items: [raw] }),
    edit: async () => {
      throw new Error('unexpected write')
    },
    map: async () => {
      throw new Error('unexpected write')
    },
    changed: () => {}
  })
  await view.toggle()
  assert.equal(view.ready.value, false)
  assert.match(view.state.value.unmappedError, /分类已发生变化/)
})
