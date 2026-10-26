import assert from 'node:assert/strict'
import test from 'node:test'
import { shallowRef } from 'vue'
import { createMusicExplorationView, observeMusicExplorationView } from './musicExplorationView.ts'
import { explorationFixture, explorationItem } from './musicExplorationTest.fixture.ts'

test('typed lookup never searches by a person name and missing references stay empty', async () => {
  const f = explorationFixture(), view = createMusicExplorationView(f.api)
  const reference = { provider: 'mb', kind: 'artist' as const, idType: 'mbid', value: 'person' }
  await view.setContext(undefined, reference, '')
  assert.deepEqual(f.calls[0].query.reference, reference)
  assert.equal(view.state.value.detail?.entity?.id, 'person')
  assert.equal(f.calls.some(call => call.name === 'query'), false)
  await view.setContext(undefined, { ...reference, value: 'missing' }, '')
  assert.equal(view.state.value.detail?.entity, null)
  assert.equal(view.state.value.relations, null)
  view.dispose()
})

test('role participation and cached scope keep totals, exact IDs and the frozen page token', async () => {
  const f = explorationFixture(), view = createMusicExplorationView(f.api)
  await view.setContext('person', undefined, '')
  assert.equal(view.state.value.relations?.total, 14)
  assert.equal(view.state.value.relations?.items.length, 12)
  const token = view.state.value.detail!.token
  await view.page(12)
  assert.equal(view.state.value.relations?.items[0].entity.id, 'recording-13')
  assert.equal(f.calls.at(-1)!.query.token, token)
  await view.setRole('composer'); await view.setScope('catalog')
  assert.deepEqual(f.calls.at(-1)!.query.roles, ['composer'])
  assert.equal(f.calls.at(-1)!.query.scope, 'catalog')
  await view.navigate(f.entities.get('other-person')!)
  assert.equal(view.state.value.relations?.total, 0, 'same name never implies same participation')
  await view.back(); assert.equal(view.state.value.detail?.entity?.id, 'person')
  view.dispose()
})

test('mixed relation tokens withdraw the whole result without automatic retry', async () => {
  const f = explorationFixture(), view = createMusicExplorationView(f.api)
  f.mixTokens(); await view.setContext('work', undefined, '')
  assert.equal(view.state.value.detail, null); assert.equal(view.state.value.relations, null)
  assert.equal(view.state.value.blocked, true); assert.equal(f.calls.length, 2)
  view.dispose()
})

test('manual performance saves only explicitly selected ordered recordings using current revision', async () => {
  const f = explorationFixture(), view = createMusicExplorationView(f.api)
  await view.setContext('work', undefined, '')
  assert.equal(view.state.value.relations?.items[0].relation.kind, 'work_recording', 'direct work relationship needs no invented performance')
  view.newPerformance(); view.title('My performance')
  assert.equal(view.canSave.value, false)
  await view.choose(); assert.equal(view.state.value.picker?.total, 14)
  await view.choose(12); assert.equal(view.state.value.picker?.items[0].id, 'recording-13')
  view.addRecording(f.entities.get('recording-1')!); view.addRecording(f.entities.get('recording-2')!)
  view.moveRecording(1, -1); await view.save()
  assert.deepEqual(f.writes[0].query, { workId: 'work', title: 'My performance', recordingIds: ['recording-2', 'recording-1'], revision: 1 })
  assert.equal(view.state.value.editor, null); assert.match(view.state.value.notice, /已保存/)
  await view.editPerformance('new-performance')
  const edited = view.state.value.editor as { recordings: Array<{ id: string }> } | null
  assert.deepEqual(edited?.recordings.map(item => item.id), ['recording-2', 'recording-1'])
  view.dispose()
})

test('editing retains exact ordered relation targets rather than multiplying displayed identity equivalents', async () => {
  const f = explorationFixture()
  await f.api.save({ workId: 'work', title: 'Explicit', recordingIds: ['recording-2','recording-1'], revision: 1 })
  const original = f.edges.find(edge => edge.relation.kind === 'performance_recording')!
  f.edges.push({ ...original, entity: explorationItem('equivalent-physical-recording') })
  const view = createMusicExplorationView(f.api); await view.setContext('work', undefined, '')
  await view.editPerformance('new-performance')
  assert.deepEqual(view.state.value.editor?.recordings.map(item => item.id), ['recording-2','recording-1'])
  view.dispose()
})

test('unknown save keeps draft, requires reread and explicit acknowledgement, and is never replayed', async () => {
  const f = explorationFixture(), view = createMusicExplorationView(f.api)
  await view.setContext('work', undefined, ''); view.newPerformance(); view.title('Keep draft'); view.addRecording(f.entities.get('recording-1')!)
  f.fail(); await view.save(); await view.save()
  assert.equal(f.writes.length, 1); assert.equal(view.state.value.uncertain, true)
  assert.equal(view.state.value.editor?.title, 'Keep draft')
  await view.refresh(); assert.equal(f.writes.length, 1); assert.equal(view.canSave.value, false)
  view.acknowledgeUnknown(); assert.equal(view.canSave.value, true); assert.equal(f.writes.length, 1)
  view.dispose()
})

test('stale save retains selected order but does not mislabel a definite rejection as unknown', async () => {
  const f = explorationFixture(), view = createMusicExplorationView(f.api)
  await view.setContext('work', undefined, ''); view.newPerformance(); view.title('Draft'); view.addRecording(f.entities.get('recording-2')!)
  f.fail(Object.assign(new Error('stale'), { code: 'STALE_REVISION' })); await view.save()
  assert.equal(view.state.value.uncertain, false); assert.equal(view.state.value.blocked, true)
  assert.equal(view.state.value.editor?.recordings[0].id, 'recording-2')
  await view.refresh(); assert.equal(view.canSave.value, true); assert.equal(f.writes.length, 1)
  view.dispose()
})

test('delete is a separate request and unknown deletion is not retried by reread', async () => {
  const f = explorationFixture(), view = createMusicExplorationView(f.api)
  await view.setContext('work', undefined, ''); view.requestDelete('performance')
  assert.equal(f.writes.length, 0)
  f.fail(); await view.confirmDelete(); await view.refresh(); await view.confirmDelete()
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].name, 'delete')
  assert.equal(view.state.value.deleteId, 'performance'); assert.equal(view.state.value.uncertain, true)
  view.dispose()
})

test('snapshot revision changes withdraw pages while preserving edits; unrelated sequence does not', async () => {
  const f = explorationFixture(), view = createMusicExplorationView(f.api)
  const snapshot = shallowRef({ epoch: 'one', explorationRevision: null as number | null, catalogRevision: 1, sequence: 0 })
  const stop = observeMusicExplorationView(view, { entityId: () => 'work', reference: () => undefined, scope: () => '', snapshot: () => snapshot.value })
  await new Promise<void>(r => setImmediate(r))
  snapshot.value = { ...snapshot.value, explorationRevision: 1, sequence: 1 }
  assert.equal(view.state.value.blocked, false)
  view.newPerformance(); view.title('Preserved')
  snapshot.value = { ...snapshot.value, sequence: 2 }; assert.equal(view.state.value.blocked, false)
  snapshot.value = { ...snapshot.value, explorationRevision: 2 }
  assert.equal(view.state.value.detail, null); assert.equal(view.state.value.editor?.title, 'Preserved')
  assert.equal(view.state.value.blocked, true)
  stop(); view.dispose()
})

test('context changes abort old reads and late responses cannot overwrite the next exact anchor', async () => {
  const f = explorationFixture(), original = f.api.detail
  let resolve!: (value: ReturnType<typeof f.detail>) => void
  f.api.detail = (query, signal) => query.entityId === 'person' ? new Promise(r => { resolve = r }) : original(query, signal)
  const view = createMusicExplorationView(f.api), first = view.setContext('person', undefined, '')
  await view.setContext('work', undefined, '')
  resolve(f.detail('person')); await first
  assert.equal(view.state.value.detail?.entity?.id, 'work')
  view.addRecording(explorationItem('arbitrary', 'work')); assert.equal(view.state.value.editor, null)
  view.dispose()
})

test('permission expiry withdraws visible detail, relations and choices without another query while retaining edits', async () => {
  const f = explorationFixture(), view = createMusicExplorationView(f.api)
  f.token().expiresAt = Date.now() + 45
  await view.setContext('work', undefined, '')
  view.newPerformance(); view.title('Keep user draft'); await view.choose()
  assert.ok(view.state.value.picker); const calls = f.calls.length
  await new Promise<void>(resolve => setTimeout(resolve, 70))
  assert.equal(view.state.value.detail, null); assert.equal(view.state.value.relations, null); assert.equal(view.state.value.picker, null)
  assert.equal(view.state.value.editor?.title, 'Keep user draft'); assert.equal(view.state.value.blocked, true)
  assert.match(view.state.value.notice, /许可已到期/); assert.equal(f.calls.length, calls)
  view.dispose()
})
