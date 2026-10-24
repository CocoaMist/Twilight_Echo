import assert from 'node:assert/strict'
import test from 'node:test'
import type { EntityMetadataDetail } from '../../../../shared/entityMetadata.ts'
import type {
  MusicCredit,
  MusicCreditsPage,
  MusicCreditsQuery
} from '../../../../shared/musicCredits.ts'
import {
  createMusicCreditsView,
  creditRoleLabel,
  creditTargetLabel,
  musicBrainzReferenceUrl,
  MUSIC_CREDITS_PAGE_SIZE
} from './musicCreditsView.ts'

const detail = (entityId = 'a', revision = 1): EntityMetadataDetail => ({
  entityId,
  revision,
  targetId: `target-${entityId}`,
  name: 'Same name',
  facts: [],
  introduction: null,
  override: null,
  link: { state: 'confirmed', revision, mbid: '' }
})
const page = (revision = 'credits1', offset = 0): MusicCreditsPage => ({
  items: [],
  total: 41,
  offset,
  revision,
  truncated: false
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

test('credits read only confirmed identities, bound every page and keep the detail and credits revisions', async () => {
  const calls: MusicCreditsQuery[] = []
  const view = createMusicCreditsView(async (query) => {
    calls.push(query)
    return page('credits1', query.offset)
  })
  for (const link of [null, { state: 'detached' }, { state: 'rejected' }] as const) {
    await view.setDetail({ ...detail(), link: link as EntityMetadataDetail['link'] })
    assert.equal(view.state.value.page, null)
  }
  assert.equal(calls.length, 0)
  await view.setDetail(detail('a', 7))
  await view.page(20)
  assert.deepEqual(calls, [
    { entityId: 'a', entityRevision: 7, offset: 0, limit: MUSIC_CREDITS_PAGE_SIZE },
    {
      entityId: 'a',
      entityRevision: 7,
      offset: 20,
      limit: MUSIC_CREDITS_PAGE_SIZE,
      revision: 'credits1'
    }
  ])
  assert.equal(view.state.value.page!.offset, 20)
  view.dispose()
})

test('switching or revoking an identity aborts reads and ignores late success and failure', async () => {
  const first = deferred<MusicCreditsPage>(),
    second = deferred<MusicCreditsPage>()
  const signals: AbortSignal[] = []
  const view = createMusicCreditsView(async (query, signal) => {
    signals.push(signal)
    return query.entityId === 'a' ? first.promise : second.promise
  })
  const a = view.setDetail(detail('a'))
  const b = view.setDetail(detail('b'))
  assert.equal(signals[0].aborted, true)
  second.resolve(page('b'))
  await b
  first.reject(new Error('old failure'))
  await a
  assert.equal(view.state.value.page!.revision, 'b')
  const c = view.setDetail(detail('b', 2))
  await view.setDetail(null)
  await c
  assert.equal(signals[2].aborted, true)
  assert.equal(view.state.value.page, null)
  assert.equal(view.state.value.error, '')
  view.dispose()
})

test('failed pagination clears the old list and exposes a stale revision rather than restarting silently', async () => {
  const view = createMusicCreditsView(async (query) => {
    if (query.offset) throw new Error('STALE_REVISION: identity changed')
    return page()
  })
  await view.setDetail(detail())
  await view.page(20)
  assert.equal(view.state.value.page, null)
  assert.match(view.state.value.error, /STALE_REVISION/)
  await view.setDetail(detail('a', 2))
  assert.equal(view.state.value.error, '')
  view.dispose()
})

test('unmount aborts the request and a late response cannot repopulate credits', async () => {
  const pending = deferred<MusicCreditsPage>()
  let signal!: AbortSignal
  const view = createMusicCreditsView(async (_query, input) => {
    signal = input
    return pending.promise
  })
  const load = view.setDetail(detail())
  view.dispose()
  pending.resolve(page())
  await load
  assert.equal(signal.aborted, true)
  assert.equal(view.state.value.page, null)
})

test('unknown and forward roles retain their meaning and reference links require typed MusicBrainz IDs', () => {
  const credit = {
    role: 'producer',
    rawRole: 'executive producer',
    direction: 'backward'
  } as MusicCredit
  assert.equal(creditRoleLabel(credit), '制作')
  assert.equal(creditRoleLabel({ ...credit, direction: 'forward' }), 'executive producer')
  assert.equal(
    creditRoleLabel({ ...credit, role: 'other', rawRole: 'mixing assistant' }),
    'mixing assistant'
  )
  assert.equal(creditTargetLabel('work'), '作品')
  const ref = {
    provider: 'musicbrainz',
    kind: 'album_project',
    idType: 'mbid',
    value: '11111111-1111-4111-8111-111111111111'
  } as const
  assert.equal(musicBrainzReferenceUrl(ref), `https://musicbrainz.org/release-group/${ref.value}`)
  assert.equal(musicBrainzReferenceUrl({ ...ref, provider: 'platform.test' }), null)
  assert.equal(musicBrainzReferenceUrl({ ...ref, value: 'javascript:alert(1)' }), null)
  assert.equal(musicBrainzReferenceUrl({ ...ref, idType: 'native' }), null)
})
