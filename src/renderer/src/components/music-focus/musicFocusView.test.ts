import assert from 'node:assert/strict'
import test from 'node:test'
import { effectScope, shallowRef } from 'vue'
import type { MusicFocusQuery } from '../../../../shared/musicFocus.ts'
import { compileFocusDraft, focusDraft, newFocusNode } from './musicFocusDraft.ts'
import { createMusicFocusView, observeMusicFocusView } from './musicFocusView.ts'
import { focusFixture } from './musicFocusTest.fixture.ts'

test('draft roundtrips every AST leaf, nested boolean groups, exact ranges and ordered sorts', () => {
  const query: MusicFocusQuery = {
    version: 1,
    entity: 'release',
    scope: 'catalog',
    where: {
      all: [
        {
          any: [
            {
              source: {
                provider: 'local',
                format: 'FLAC',
                bitDepth: { gte: 24 },
                sampleRate: { eq: 96000 }
              }
            },
            { not: { genre: { id: 'jazz', includeDescendants: true } } }
          ]
        },
        {
          rating: {
            target: 'self',
            mode: 'effective',
            provider: 'test',
            gteStars: 2.5,
            lteStars: 5
          }
        },
        { tag: { id: 'night' } },
        { year: { target: 'release', exists: true, gte: 1990, lte: 2010 } },
        { lastPlayed: { exists: false } },
        { notPlayedWithinDays: 90 },
        { automaticPlaybackBlocked: false },
        { preference: 'favorite' },
        { classification: { dimension: 'language', values: ['unknown', 'zh'] } },
        { text: 'Miles' }
      ]
    },
    sort: [
      { field: 'personalRating', direction: 'desc' },
      { field: 'title', direction: 'asc' }
    ]
  }
  assert.deepEqual(compileFocusDraft(focusDraft(query)).query, query)
  assert.deepEqual(compileFocusDraft(focusDraft()).query, {
    version: 1,
    entity: 'recording',
    scope: 'library',
    sort: [{ field: 'title', direction: 'asc' }]
  })
})

test('partial drafts reject empty values, invalid ranges, depth and duplicate sort without coercing zero', () => {
  const d = focusDraft()
  d.root.children = [newFocusNode('notPlayedWithinDays')]
  d.root.children[0].fields.days = ''
  assert.equal(compileFocusDraft(d).query, null)
  d.root.children[0].fields.days = '0'
  assert.ok(compileFocusDraft(d).query)
  d.root.children[0].fields.days = '-1'
  assert.equal(compileFocusDraft(d).query, null)
  d.root.children[0].fields.days = '0'
  d.sort.push({ field: 'title', direction: 'desc' })
  assert.equal(compileFocusDraft(d).query, null)
  d.sort.pop()
  for (let i = 0; i < 8; i++) d.root = { ...newFocusNode('all'), children: [d.root] }
  assert.equal(compileFocusDraft(d).query, null)
})

test('collapsed view is request-free; explicit result and facets consume one token with bounded paging', async () => {
  const f = focusFixture(),
    v = createMusicFocusView(f.api)
  v.setEpoch('one')
  v.setContext('library')
  assert.equal(f.queries.length, 0)
  await v.toggle()
  assert.deepEqual(
    f.queries.map((item) => item.name),
    ['focus.saved.list']
  )
  await v.evaluate()
  assert.equal(v.state.value.page!.items.length, 20)
  assert.equal(v.state.value.page!.total, 23)
  assert.deepEqual(f.queries.at(-1)!.query.token, v.state.value.page!.token)
  await v.page(20)
  assert.equal(v.state.value.page!.items.length, 3)
  assert.equal(
    f.queries.every((item) => item.query.limit <= 20),
    true
  )
  v.dispose()
})

test('editing withdraws old counts and result sources without evaluation, preserving draft until refresh', async () => {
  const f = focusFixture(),
    v = createMusicFocusView(f.api)
  v.setEpoch('one')
  v.setContext('library')
  await v.evaluate()
  const before = f.queries.length
  v.add(v.state.value.draft.root.id, 'rating')
  assert.equal(v.state.value.page, null)
  assert.equal(v.state.value.facets, null)
  assert.equal(f.queries.length, before)
  await v.play('source-0')
  assert.equal(f.writes.length, 0)
  await v.evaluate()
  assert.deepEqual(f.queries.at(-2)!.query.query.where, {
    all: [{ rating: { target: 'self', mode: 'personal', gteStars: 4 } }]
  })
  v.dispose()
})

test('list-facet snapshot mismatch withdraws both instead of mixing counts', async () => {
  const f = focusFixture(),
    api = {
      ...f.api,
      facets: async (...args: Parameters<typeof f.api.facets>) => {
        const page = await f.api.facets(...args)
        return { ...page, token: { ...page.token, historyRevision: 8 } }
      }
    },
    v = createMusicFocusView(api)
  v.setEpoch('one')
  v.setContext('library')
  await v.evaluate()
  assert.equal(v.state.value.page, null)
  assert.equal(v.state.value.facets, null)
  assert.equal(v.state.value.blocked, true)
  v.dispose()
})

test('saved creation works with zero library results; rename and query update use independent CAS', async () => {
  const f = focusFixture(0, 0),
    v = createMusicFocusView(f.api)
  v.setEpoch('one')
  v.setContext('library')
  await v.toggle()
  v.setName('空库计划')
  await v.create()
  assert.equal(f.saved.length, 1)
  await v.openSaved(v.state.value.saved!.items[0])
  assert.equal(v.state.value.page!.total, 0)
  v.startRename(v.state.value.selectedSaved!)
  v.setRenameName('稍后听')
  await v.rename()
  assert.equal(v.state.value.selectedName, '稍后听')
  assert.deepEqual(Object.keys(f.writes.at(-1)!.query).sort(), ['id', 'name', 'nameRevision'])
  v.add(v.state.value.draft.root.id, 'automaticPlaybackBlocked')
  await v.update()
  assert.deepEqual(Object.keys(f.writes.at(-1)!.query).sort(), ['id', 'query', 'queryRevision'])
  assert.deepEqual(f.saved[0].query.where, { all: [{ automaticPlaybackBlocked: false }] })
  v.dispose()
})

test('write conflict retains edited conditions and intent, rereading never resends or overwrites draft', async () => {
  const f = focusFixture(),
    v = createMusicFocusView(f.api)
  v.setEpoch('one')
  v.setContext('library')
  await v.toggle()
  await v.openSaved(v.state.value.saved!.items[0])
  const rootId = v.state.value.draft.root.id
  v.setField(rootId, 'days', '180')
  f.saved[0].queryRevision++
  await v.update()
  assert.equal(v.state.value.intent!.kind, 'update')
  assert.equal(v.state.value.draft.root.fields.days, '180')
  assert.equal(v.state.value.saved, null)
  const writes = f.writes.length
  await v.readSaved()
  assert.equal(f.writes.length, writes)
  assert.equal(v.state.value.draft.root.fields.days, '180')
  await v.saveIntent()
  assert.equal(f.writes.at(-1)!.query.queryRevision, 2)
  assert.deepEqual(f.saved[0].query.where, { notPlayedWithinDays: 180 })
  v.dispose()
})

test('delete is confirmation-only and carries both current revisions', async () => {
  const f = focusFixture(),
    v = createMusicFocusView(f.api)
  v.setEpoch('one')
  v.setContext('library')
  await v.toggle()
  v.requestDelete(v.state.value.saved!.items[0])
  assert.equal(f.writes.length, 0)
  v.cancelDelete()
  assert.equal(f.writes.length, 0)
  v.requestDelete(v.state.value.saved!.items[0])
  await v.confirmDelete()
  assert.deepEqual(f.writes[0].query, { id: 'saved-0', nameRevision: 1, queryRevision: 1 })
  v.dispose()
})

test('catalog results cannot play, invalid source anchors are refused, library play uses frozen query/token', async () => {
  const f = focusFixture(),
    v = createMusicFocusView(f.api)
  v.setEpoch('one')
  v.setContext('library')
  await v.evaluate()
  await v.play('outside-source')
  assert.equal(f.writes.length, 0)
  const token = v.state.value.page!.token
  await v.play('source-2')
  assert.deepEqual(f.writes[0].query.token, token)
  assert.equal(f.writes[0].query.sourceId, 'source-2')
  v.edit((draft) => ({ ...draft, scope: 'catalog' }))
  await v.evaluate()
  await v.play()
  assert.equal(f.writes.length, 1)
  v.dispose()
})

test('unknown playback outcomes reconcile the original request ID; pending stays locked and not-committed unlocks', async () => {
  const f = focusFixture(),
    v = createMusicFocusView(f.api)
  v.setEpoch('one')
  v.setContext('library')
  await v.evaluate()
  f.failPlay(Object.assign(new Error('lost reply'), { code: 'OUTCOME_UNKNOWN' }))
  await v.play()
  assert.equal(v.state.value.playUncertain, true)
  const receipt = v.state.value.playReceipt!
  assert.equal(receipt.epoch, 'one')
  assert.equal(receipt.requestId, f.playRequests[0].requestId)
  assert.match(receipt.requestId, /^[a-f0-9-]{36}$/)
  await v.play()
  await v.evaluate()
  v.invalidate(true)
  assert.equal(f.writes.length, 1)
  assert.equal(v.state.value.playUncertain, true)
  v.acknowledgePlay()
  assert.equal(v.state.value.playUncertain, true)
  f.setPlayStatus({ status: 'pending' })
  await v.reconcilePlay()
  assert.equal(v.state.value.playUncertain, true)
  assert.deepEqual(f.queries.at(-1)!.query, receipt)
  await v.play()
  assert.equal(f.writes.length, 1)
  f.setPlayStatus({ status: 'not_committed' })
  await v.reconcilePlay()
  assert.equal(v.state.value.playUncertain, false)
  assert.equal(v.state.value.playReceipt, null)
  assert.match(v.state.value.playNotice, /未提交/)
  assert.equal(f.writes.length, 1)
  v.dispose()
})

test('cancel and context changes abort work, preserve query and ignore late playback/read replies', async () => {
  const f = focusFixture()
  let finish: (() => void) | null = null
  const v = createMusicFocusView({
    ...f.api,
    play: async (_query, signal) => {
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      assert.equal(signal.aborted, true)
      return { total: 23, selectedIndex: 0 }
    }
  })
  v.setEpoch('one')
  v.setContext('library')
  await v.evaluate()
  const pending = v.play()
  v.cancelPlay()
  const receipt = v.state.value.playReceipt
  f.setPlayStatus({
    status: 'committed',
    result: { total: 23, selectedIndex: 2 },
    playback: 'failed'
  })
  await v.reconcilePlay()
  assert.match(v.state.value.playNotice, /队列已提交.*播放状态未确认.*不要重复提交/)
  finish!()
  await pending
  assert.equal(v.state.value.playUncertain, false)
  assert.equal(v.state.value.playReceipt, null)
  assert.match(v.state.value.playNotice, /队列已提交.*播放状态未确认.*不要重复提交/)
  assert.deepEqual(f.queries.at(-1)!.query, receipt)
  const draft = v.state.value.draft
  v.setContext('other')
  assert.equal(v.state.value.page, null)
  assert.deepEqual(v.state.value.draft, draft)
  v.dispose()
})

test('adopted pending native playback remains locked until the same receipt confirms startup', async () => {
  const f = focusFixture(),
    v = createMusicFocusView(f.api)
  v.setEpoch('one')
  v.setContext('library')
  await v.evaluate()
  f.failPlay(new Error('reply lost'))
  await v.play()
  const receipt = v.state.value.playReceipt
  f.setPlayStatus({
    status: 'committed',
    result: { total: 23, selectedIndex: 0 },
    playback: 'pending'
  })
  await v.reconcilePlay()
  await v.play()
  assert.equal(v.state.value.playUncertain, true)
  assert.deepEqual(v.state.value.playReceipt, receipt)
  assert.equal(f.writes.length, 1)
  assert.match(v.state.value.playNotice, /队列已提交.*启动仍在处理中/)
  f.setPlayStatus({
    status: 'committed',
    result: { total: 23, selectedIndex: 0 },
    playback: 'confirmed'
  })
  await v.reconcilePlay()
  assert.equal(v.state.value.playUncertain, false)
  assert.equal(v.state.value.playReceipt, null)
  assert.match(v.state.value.playNotice, /播放已启动/)
  assert.equal(f.writes.length, 1)
  v.dispose()
})

test('epoch changes preserve the original receipt and ignore late status replies; only unknown offers manual reconciliation', async () => {
  const f = focusFixture()
  let finish: (() => void) | null = null,
    calls = 0
  const v = createMusicFocusView({
    ...f.api,
    playStatus: async (query, signal) => {
      if (calls++ === 0) {
        await new Promise<void>((resolve) => {
          finish = resolve
        })
        assert.equal(signal.aborted, true)
        return {
          status: 'committed',
          result: { total: 23, selectedIndex: 0 },
          playback: 'confirmed'
        }
      }
      return f.api.playStatus(query, signal)
    }
  })
  v.setEpoch('one')
  v.setContext('library')
  await v.evaluate()
  f.failPlay(new Error('reply lost'))
  await v.play()
  const receipt = v.state.value.playReceipt!
  const checking = v.reconcilePlay()
  v.setEpoch('two')
  finish!()
  await checking
  assert.deepEqual(v.state.value.playReceipt, receipt)
  assert.equal(v.state.value.playChecking, false)
  assert.equal(v.state.value.playStatus, null)
  assert.equal(v.state.value.playUncertain, true)
  f.setPlayStatus({ status: 'unknown' })
  await v.reconcilePlay()
  assert.deepEqual(f.queries.at(-1)!.query, { requestId: receipt.requestId, epoch: 'one' })
  assert.match(v.state.value.playNotice, /无法确定.*是否提交/)
  v.acknowledgePlay()
  assert.equal(v.state.value.playUncertain, false)
  assert.equal(v.state.value.playReceipt, null)
  assert.equal(f.writes.length, 1)
  v.dispose()
})

test('a failed receipt read preserves the key and cannot unlock playback through manual acknowledgement', async () => {
  const f = focusFixture(),
    v = createMusicFocusView(f.api)
  v.setEpoch('one')
  v.setContext('library')
  await v.evaluate()
  f.failPlay(new Error('reply lost'))
  await v.play()
  const receipt = v.state.value.playReceipt
  f.failRead(new Error('offline'))
  await v.reconcilePlay()
  v.acknowledgePlay()
  await v.play()
  assert.deepEqual(v.state.value.playReceipt, receipt)
  assert.equal(v.state.value.playUncertain, true)
  assert.match(v.state.value.playError, /对账失败/)
  assert.equal(f.writes.length, 1)
  v.dispose()
})

test('snapshot observer ignores sequence, invalidates all dependencies and keeps user drafts', async () => {
  const f = focusFixture(),
    v = createMusicFocusView(f.api),
    scope = effectScope()
  const snapshot = shallowRef({
    epoch: 'one',
    focusRevision: 1,
    focusHistoryRevision: 1,
    tagsLinkRevision: 0,
    sequence: 1
  })
  const stop = scope.run(() =>
    observeMusicFocusView(v, { scope: () => 'library', snapshot: () => snapshot.value })
  )!
  await v.evaluate()
  const reads = f.queries.length
  snapshot.value = { ...snapshot.value, sequence: 2 }
  assert.ok(v.state.value.page)
  snapshot.value = { ...snapshot.value, focusHistoryRevision: 2 }
  assert.equal(v.state.value.page, null)
  assert.equal(v.state.value.facets, null)
  assert.equal(f.queries.length, reads)
  await v.evaluate()
  snapshot.value = { ...snapshot.value, epoch: 'two' }
  assert.equal(v.state.value.blocked, true)
  stop()
  scope.stop()
  v.dispose()
})

test('expired token is withdrawn before accepting the first page', async () => {
  const f = focusFixture(),
    v = createMusicFocusView(f.api)
  f.setToken({ expiresAt: 100 })
  v.setEpoch('one')
  v.setContext('library')
  await v.evaluate()
  assert.equal(v.state.value.page, null)
  assert.equal(v.state.value.blocked, true)
  v.dispose()
})

test('expiry timer withdraws results and counts while retaining the current conditions', async () => {
  const f = focusFixture(),
    v = createMusicFocusView(f.api)
  f.setToken({ expiresAt: 115 })
  v.setEpoch('one')
  v.setContext('library')
  await v.evaluate()
  assert.ok(v.state.value.page)
  const draft = v.state.value.draft
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(v.state.value.page, null)
  assert.equal(v.state.value.facets, null)
  assert.equal(v.state.value.blocked, true)
  assert.deepEqual(v.state.value.draft, draft)
  v.dispose()
})

test('late query replies cannot restore sources or counts after editing changes the draft', async () => {
  const f = focusFixture()
  let finish: (() => void) | null = null
  const v = createMusicFocusView({
    ...f.api,
    query: async (query) => {
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return f.api.query(query, new AbortController().signal)
    }
  })
  v.setEpoch('one')
  v.setContext('library')
  const pending = v.evaluate()
  v.add(v.state.value.draft.root.id, 'rating')
  finish!()
  await pending
  assert.equal(v.state.value.page, null)
  assert.equal(v.state.value.facets, null)
  assert.equal(f.queries.filter((item) => item.name === 'focus.facets').length, 0)
  v.dispose()
})

test('genre/tag choices stay paged and edit only stable IDs with includeDescendants explicit', async () => {
  const f = focusFixture(),
    v = createMusicFocusView(f.api)
  v.setEpoch('one')
  v.setContext('library')
  v.add(v.state.value.draft.root.id, 'genre')
  const node = v.state.value.draft.root.children[0]
  await v.lookup(node.id, 'genre', '', 20)
  assert.equal(v.state.value.choice!.page!.items.length, 2)
  v.choose(node.id, v.state.value.choice!.page!.items[0])
  assert.deepEqual(v.compiled.value.query!.where, {
    all: [{ genre: { id: 'genre-20', includeDescendants: true } }]
  })
  v.setKind(node.id, 'tag')
  await v.lookup(node.id, 'tag')
  v.choose(node.id, v.state.value.choice!.page!.items[0])
  assert.deepEqual(v.compiled.value.query!.where, { all: [{ tag: { id: 'tag-1' } }] })
  v.dispose()
})
