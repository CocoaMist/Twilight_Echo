import assert from 'node:assert/strict'
import test from 'node:test'
import { shallowRef } from 'vue'
import type {
  MusicPreferencesDetail,
  MusicPreferencesSet
} from '../../../../shared/musicPreferences.ts'
import {
  createPersonalPreferencesView,
  observePersonalPreferencesView,
  preferenceLabel,
  preferenceOrganizationOnly
} from './personalPreferencesView.ts'

const detail = (
  state: 'none' | 'favorite' | 'ban' = 'none',
  revision = 1
): MusicPreferencesDetail => ({
  entityId: 'one',
  kind: 'recording',
  scope: 'entity',
  value: { state, revision, updatedAt: 100 },
  token: { preferencesRevision: revision, linkRevision: 0, targetKey: 'entity:one' }
})
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function fixture() {
  let current = detail()
  const writes: MusicPreferencesSet[] = []
  const view = createPersonalPreferencesView({
    detail: async () => current,
    set: async (query) => {
      writes.push(query)
      current = detail(query.state, current.token.preferencesRevision + 1)
    }
  })
  return { view, writes, current: () => current }
}

test('work and exact source-person organization keep their scope and labels through an unknown write', async () => {
  for (const kind of ['work', 'artist'] as const) {
    const work = { ...detail(), entityId: kind, kind }, writes: MusicPreferencesSet[] = []
    const view = createPersonalPreferencesView({
      detail: async () => work,
      set: async request => { writes.push(request); throw new Error('lost reply') }
    })
    await view.setContext(kind, 'exploration')
    assert.equal(view.state.value.organizationOnly, true)
    await view.ban()
    assert.equal(view.state.value.organizationOnly, true)
    assert.equal(preferenceLabel({ state: 'ban', revision: 1, updatedAt: 0 }, view.state.value.organizationOnly), '不推荐')
    assert.equal(writes[0].entityId, kind)
    assert.equal(writes[0].state, 'ban')
    assert.equal(writes.length, 1)
    view.dispose()
  }
  assert.equal(preferenceOrganizationOnly({ ...detail(), kind: 'artist', scope: 'identity' }), false)
  assert.equal(preferenceLabel({ state: 'ban', revision: 1, updatedAt: 0 }), '禁播')
})

test('favorite and ban are explicit mutually exclusive writes; unfavorite cannot clear a ban', async () => {
  const { view, writes } = fixture()
  await view.setContext('one', 'track')
  await view.favorite()
  assert.equal(view.state.value.detail?.value?.state, 'favorite')
  await view.ban()
  assert.equal(view.state.value.detail?.value?.state, 'ban')
  await view.cancelFavorite()
  assert.equal(writes.length, 2)
  await view.unban()
  assert.deepEqual(
    writes.map((query) => query.state),
    ['favorite', 'ban', 'none']
  )
  assert.equal(view.state.value.detail?.value?.state, 'none')
  assert.equal(view.state.value.draft, undefined)
  assert.equal(writes[1].token.preferencesRevision, 2)
})

test('an unknown write result keeps intent and requires an explicit read, without replay', async () => {
  const writes: MusicPreferencesSet[] = []
  let current = detail()
  const view = createPersonalPreferencesView({
    detail: async () => current,
    set: async (query) => {
      writes.push(query)
      current = detail(query.state, 2)
      throw new Error('lost receipt')
    }
  })
  await view.setContext('one', '')
  await view.ban()
  assert.equal(view.state.value.detail, null)
  assert.equal(view.state.value.draft, 'ban')
  assert.match(view.state.value.error, /保存结果未确认/)
  await view.save()
  assert.equal(writes.length, 1)
  await view.refresh()
  assert.equal((view.state.value.detail as MusicPreferencesDetail | null)?.value?.state, 'ban')
  assert.equal(view.state.value.draft, undefined)
  assert.equal(writes.length, 1)
})

test('a stale CAS keeps intent across reread until user chooses to save or discard', async () => {
  let writes = 0
  const view = createPersonalPreferencesView({
    detail: async () => detail('none', 3),
    set: async () => {
      writes++
      throw Object.assign(new Error('stale'), { code: 'STALE_REVISION' })
    }
  })
  await view.setContext('one', '')
  await view.favorite()
  assert.equal(view.state.value.blocked, true)
  assert.equal(view.state.value.draft, 'favorite')
  await view.refresh()
  assert.equal(view.canSave.value, true)
  assert.equal(writes, 1)
  view.discardDraft()
  assert.equal(view.canSave.value, false)
})

test('changing context discards old drafts and ignores late reads and writes', async () => {
  const reading = deferred<MusicPreferencesDetail>(),
    writing = deferred<unknown>()
  let calls = 0
  const view = createPersonalPreferencesView({
    detail: async (id) => (++calls === 1 ? reading.promise : { ...detail(), entityId: id }),
    set: async () => writing.promise
  })
  const oldRead = view.setContext('old', '')
  await view.setContext('one', '')
  reading.resolve({ ...detail('ban'), entityId: 'old' })
  await oldRead
  assert.equal(view.state.value.detail?.entityId, 'one')
  const oldWrite = view.favorite()
  await view.setContext('two', '')
  writing.resolve(detail('favorite'))
  await oldWrite
  assert.equal(view.state.value.detail?.entityId, 'two')
  assert.equal(view.state.value.notice, '')
  assert.equal(view.state.value.draft, undefined)
})

test('known preference, identity and catalog revisions withdraw receipts; sequence ticks do not', async () => {
  const { view } = fixture()
  const snapshot = shallowRef({
    epoch: 'one',
    preferencesRevision: 1,
    entityMetadataRevision: 1,
    catalogRevision: 1,
    libraryRevision: 1,
    sequence: 0
  })
  const stop = observePersonalPreferencesView(view, {
    entityId: () => 'one',
    scope: () => '',
    snapshot: () => snapshot.value
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  snapshot.value = { ...snapshot.value, sequence: 1 }
  assert.ok(view.state.value.detail)
  snapshot.value = { ...snapshot.value, preferencesRevision: 2 }
  assert.equal(view.state.value.detail, null)
  await view.refresh()
  snapshot.value = { ...snapshot.value, entityMetadataRevision: 2 }
  assert.equal(view.state.value.detail, null)
  await view.refresh()
  snapshot.value = { ...snapshot.value, catalogRevision: 2 }
  assert.equal(view.state.value.detail, null)
  stop()
  view.dispose()
})

test('first unknown revision becoming known allows the initial read; epoch isolates in-flight writes', async () => {
  const snapshot = shallowRef({ epoch: 'one', preferencesRevision: null as number | null })
  const writing = deferred<unknown>()
  const view = createPersonalPreferencesView({
    detail: async () => {
      snapshot.value = { ...snapshot.value, preferencesRevision: 0 }
      return detail('none', 0)
    },
    set: async () => writing.promise
  })
  const stop = observePersonalPreferencesView(view, {
    entityId: () => 'one',
    scope: () => '',
    snapshot: () => snapshot.value
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.ok(view.state.value.detail)
  const saving = view.ban()
  snapshot.value = { ...snapshot.value, epoch: 'two' }
  writing.resolve(detail('ban'))
  await saving
  assert.equal(view.state.value.detail, null)
  assert.equal(view.state.value.notice, '')
  assert.equal(view.state.value.saving, false)
  assert.equal(view.state.value.blocked, true)
  stop()
  view.dispose()
})

test('successful command with failed receipt reread is not labelled as saved', async () => {
  let reads = 0
  const view = createPersonalPreferencesView({
    detail: async () => {
      if (++reads > 1) throw new Error('read disconnected')
      return detail()
    },
    set: async () => ({})
  })
  await view.setContext('one', '')
  await view.favorite()
  assert.equal(view.state.value.detail, null)
  assert.equal(view.state.value.draft, 'favorite')
  assert.equal(view.state.value.blocked, true)
  assert.match(view.state.value.notice, /已提交，请重新读取/)
  assert.doesNotMatch(view.state.value.notice, /已保存/)
})
