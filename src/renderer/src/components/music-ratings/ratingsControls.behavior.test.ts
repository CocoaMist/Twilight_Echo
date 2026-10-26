/* eslint-disable vue/one-component-per-file */
import assert from 'node:assert/strict'
import test from 'node:test'
import { h, ref, shallowRef } from 'vue'
import * as vue from 'vue'
import { component, mount, settle } from './ratingsTestRenderer.ts'
import * as ratingsModel from './personalRatingsView.ts'
import * as trackModel from './trackRatingsView.ts'
import * as targetsModel from './ratingTargetsView.ts'
import * as metadataModel from '../music-metadata/entityMetadataView.ts'
import * as reviewModel from '../music-metadata/identityReviewView.ts'
import * as historyModel from '../music-metadata/identityHistoryView.ts'
import * as albumModel from '../music-versions/albumVersionsView.ts'
import { getTrackSource } from '../../../../shared/trackSourceIdentity.ts'
import type { MusicRatingsDetail, MusicRatingImpact } from '../../../../shared/musicRatings.ts'
import type { Track } from '../../types/music.ts'

const blank = { render: () => null }
const rating = (entityId: string, steps: number | null = 7, revision = 1): MusicRatingsDetail => ({
  entityId,
  kind: 'recording',
  scope: 'entity',
  value: { steps, revision, updatedAt: 100 },
  token: { ratingsRevision: revision, linkRevision: 0, targetKey: `entity:${entityId}` }
})
function fixture() {
  const snapshot = shallowRef({
    epoch: 'one',
    ratingsRevision: 1,
    entityMetadataRevision: 1,
    catalogRevision: 1,
    libraryRevision: 1,
    settingsRevision: 1,
    sequence: 0
  })
  const queries: Array<{ name: string; query: any }> = [],
    writes: Array<{ name: string; query: any }> = []
  let saved = rating('recording-one'),
    fail = false
  const core = {
    state: snapshot,
    query: async (name: string, query: any): Promise<any> => {
      queries.push({ name, query })
      if (name === 'ratings.targets')
        return {
          entityId: query.entityId,
          offset: query.offset ?? 0,
          total: 1,
          items: [{ id: query.entityId, kind: 'recording', title: 'Recording', artist: 'Artist' }]
        }
      if (name === 'ratings.detail') return { ...saved, entityId: query.entityId }
      if (name === 'ratings.history')
        return {
          entityId: query.entityId,
          kind: 'recording',
          scope: 'entity',
          offset: query.offset ?? 0,
          total: 8,
          items: [{ ...saved.value, seq: 1, reason: 'set' }]
        }
      throw new Error(`Unexpected ${name}`)
    },
    command: async (name: string, query: any) => {
      writes.push({ name, query })
      if (fail) throw new Error('network interrupted')
      saved = rating(query.entityId, query.steps, snapshot.value.ratingsRevision + 1)
      snapshot.value = { ...snapshot.value, ratingsRevision: saved.token.ratingsRevision }
      return saved
    }
  }
  const Panel = component('./PersonalRatingsPanel.vue', {
    './personalRatingsView.ts': ratingsModel,
    './ratingTargetsView.ts': targetsModel,
    '../music-preferences/PersonalPreferencesPanel.vue': { default: blank },
    '../music-tags/MusicTagsPanel.vue': { default: blank },
    '../../stores/coreConnection.ts': { useCoreConnection: () => core }
  })
  return {
    snapshot,
    queries,
    writes,
    core,
    Panel,
    fail: () => {
      fail = true
    }
  }
}

test('compiled half-star controls keep drafts separate, save a fenced receipt, clear explicitly and page lazy history', async (t) => {
  const f = fixture()
  const ui = mount(t, () => h(f.Panel, { entityId: 'recording-one', label: '录音' }))
  await settle()
  assert.match(ui.text(), /已保存：3.5 星/)
  assert.match(ui.text(), /暂无资料评分/)
  assert.equal(
    f.queries.some((query) => query.name === 'ratings.history'),
    false
  )
  ui.button('4.5 星').props.onClick()
  await settle()
  assert.match(ui.text(), /已保存：3.5 星/)
  assert.match(ui.text(), /未保存草稿：4.5 星/)
  ui.button('保存评分').props.onClick()
  await settle()
  assert.deepEqual(f.writes[0], {
    name: 'ratings.set',
    query: { entityId: 'recording-one', token: rating('recording-one').token, steps: 9 }
  })
  assert.match(ui.text(), /已保存：4.5 星/)
  assert.match(ui.text(), /评分已保存/)
  ui.button('清除评分').props.onClick()
  await settle()
  assert.equal(f.writes[1].query.steps, null)
  assert.match(ui.text(), /已保存：未评分/)
  ui.button('查看评分历史').props.onClick()
  await settle()
  assert.deepEqual(f.queries.find((query) => query.name === 'ratings.history')!.query, {
    entityId: 'recording-one',
    offset: 0,
    limit: 6
  })
  ui.button('下一页评分').props.onClick()
  await settle()
  assert.equal(f.queries.at(-1)!.query.offset, 6)
})

test('compiled controls withdraw stale values without tick polling and preserve a failed draft for explicit reread', async (t) => {
  const f = fixture(),
    ui = mount(t, () => h(f.Panel, { entityId: 'recording-one', label: '录音' }))
  await settle()
  ui.button('5 星').props.onClick()
  await settle()
  const reads = f.queries.length
  f.snapshot.value = { ...f.snapshot.value, sequence: 3 }
  await settle()
  assert.equal(f.queries.length, reads)
  assert.match(ui.text(), /已保存：3.5 星/)
  f.snapshot.value = { ...f.snapshot.value, ratingsRevision: 2 }
  await settle()
  assert.doesNotMatch(ui.text(), /已保存：/)
  assert.match(ui.text(), /保留的草稿：5 星/)
  assert.equal(f.queries.length, reads)
  ui.button('重新读取评分').props.onClick()
  await settle()
  f.fail()
  ui.button('保存评分').props.onClick()
  await settle()
  assert.match(ui.text(), /保存结果未确认/)
  assert.match(ui.text(), /保留的草稿：5 星/)
  assert.doesNotMatch(ui.text(), /评分已保存/)
})

test('first unknown rating revision becoming known does not abort the compiled initial detail read', async (t) => {
  const f = fixture(),
    original = f.core.query
  f.snapshot.value = { ...f.snapshot.value, ratingsRevision: null as any }
  f.core.query = async (name, query) => {
    if (name !== 'ratings.detail') return original(name, query)
    f.queries.push({ name, query })
    await Promise.resolve()
    f.snapshot.value = { ...f.snapshot.value, ratingsRevision: 0 }
    return rating(query.entityId, 7, 0)
  }
  const ui = mount(t, () => h(f.Panel, { entityId: 'recording-one', label: '录音' }))
  await settle()
  assert.match(ui.text(), /已保存：3.5 星/)
  assert.doesNotMatch(ui.text(), /请重新读取评分/)
  assert.equal(f.queries.filter((query) => query.name === 'ratings.detail').length, 1)
  f.snapshot.value = { ...f.snapshot.value, ratingsRevision: 1 }
  await settle()
  assert.doesNotMatch(ui.text(), /已保存：/)
  assert.match(ui.text(), /请重新读取评分/)
})

test('manual playback versions require a physical target choice and never receive rating writes themselves', async (t) => {
  const f = fixture(),
    original = f.core.query
  f.core.query = async (name, query) => {
    if (name !== 'ratings.targets') return original(name, query)
    f.queries.push({ name, query })
    return {
      entityId: 'manual-album',
      offset: query.offset,
      total: 8,
      items: [
        {
          id: 'physical-first-pressing',
          kind: 'release',
          title: 'Same album',
          artist: 'Same artist'
        },
        { id: 'physical-remaster', kind: 'release', title: 'Same album', artist: 'Same artist' }
      ]
    }
  }
  const ui = mount(t, () => h(f.Panel, { entityId: 'manual-album', label: '具体发行' }))
  await settle()
  assert.equal(
    f.queries.some((query) => query.name === 'ratings.detail'),
    false
  )
  assert.match(ui.text(), /评分不会合并不同录音或发行/)
  ui.button('Same album · Same artist · physical-remaster').props.onClick()
  await settle()
  assert.equal(
    f.queries.find((query) => query.name === 'ratings.detail')!.query.entityId,
    'physical-remaster'
  )
  ui.button('4.5 星').props.onClick()
  await settle()
  ui.button('保存评分').props.onClick()
  await settle()
  assert.equal(f.writes[0].query.entityId, 'physical-remaster')
  f.snapshot.value = { ...f.snapshot.value, catalogRevision: 2 }
  await settle()
  assert.doesNotMatch(ui.text(), /已保存：/)
  assert.match(ui.text(), /重新读取具体评分条目/)
  ui.button('重新读取评分').props.onClick()
  await settle()
  assert.match(ui.text(), /已保存：4.5 星/)
  ui.button('下一组评分条目').props.onClick()
  await settle()
  assert.deepEqual(f.queries.findLast((query) => query.name === 'ratings.targets')!.query, {
    entityId: 'manual-album',
    offset: 6,
    limit: 6
  })
  assert.equal(
    f.queries
      .filter((query) => query.name === 'ratings.detail')
      .every((query) => query.query.entityId !== 'manual-album'),
    true
  )
})

function trackPanel(f: ReturnType<typeof fixture>) {
  return component('./TrackRatingsPanel.vue', {
    './trackRatingsView.ts': trackModel,
    '../../../../shared/trackSourceIdentity.ts': { getTrackSource },
    './PersonalRatingsPanel.vue': { default: f.Panel },
    '../../stores/coreConnection.ts': { useCoreConnection: () => f.core }
  })
}
test('actual track dialog resolves local and streaming IDs and requires a choice among same-title recordings', async (t) => {
  const f = fixture(),
    original = f.core.query
  f.core.query = async (name, query) => {
    if (name === 'ratings.targets' && query.entityId === 'manual-stream-recording') {
      f.queries.push({ name, query })
      assert.deepEqual(query.trackContext, { provider: 'ncm', id: '42' })
      return {
        entityId: query.entityId,
        offset: 0,
        total: 1,
        items: [
          {
            id: 'physical-stream-recording',
            kind: 'recording',
            title: 'Original track',
            artist: 'Original artist'
          }
        ]
      }
    }
    if (name !== 'catalog.query') return original(name, query)
    f.queries.push({ name, query })
    const ids =
      query.context.provider === 'local'
        ? ['recording-one', 'recording-two']
        : ['manual-stream-recording']
    return {
      revision: 1,
      offset: 0,
      total: ids.length,
      items: ids.map((id) => ({
        id,
        kind: 'recording',
        title: 'Same title',
        artist: 'Same artist',
        sourceCount: 1,
        identity: 'source'
      }))
    }
  }
  const Host = trackPanel(f)
  const Dialog = component('../TrackInfoDialog.vue', {
    '@renderer/composables/useNativeDialog': { useNativeDialog() {} },
    '@renderer/app/useDismissLayer': { useEscapeToClose() {} },
    '@renderer/stores/useMusicStore.ts': {
      useMusicStore: () => ({ refreshLibraryIndex: async () => {} })
    },
    '@renderer/utils/localTrackRemovalPolicy.ts': { selectLocalLibraryActionTracks: () => [] },
    '@renderer/components/CoverImg.vue': { default: blank },
    '@renderer/components/LocalLibraryTagManager.vue': { default: blank },
    '@renderer/components/music-metadata/TrackCreditsPanel.vue': { default: blank },
    '@renderer/components/music-ratings/TrackRatingsPanel.vue': { default: Host }
  })
  const track = ref<Track>({
    id: 'D:/one.flac',
    source: 'local',
    title: 'Same title',
    artist: 'Same artist',
    album: '',
    duration: 60,
    size: 0
  })
  const ui = mount(t, () => h(Dialog, { track: track.value }))
  await settle()
  assert.deepEqual(f.queries[0].query.context, {
    type: 'track',
    provider: 'local',
    id: 'D:/one.flac'
  })
  assert.equal(
    f.queries.some((query) => query.name === 'ratings.detail'),
    false
  )
  const choices = ui
    .nodes()
    .filter((node) => node.tag === 'button' && node.props['aria-pressed'] === false)
  assert.equal(choices.length, 2)
  choices[1].props.onClick()
  await settle()
  assert.equal(
    f.queries.find((query) => query.name === 'ratings.detail')!.query.entityId,
    'recording-two'
  )
  track.value = { ...track.value, id: '42', source: 'ncm' }
  await settle()
  assert.deepEqual(f.queries.findLast((query) => query.name === 'catalog.query')!.query.context, {
    type: 'track',
    provider: 'ncm',
    id: '42'
  })
  assert.equal(
    f.queries.findLast((query) => query.name === 'ratings.detail')!.query.entityId,
    'physical-stream-recording'
  )
})

test('album page keeps rating the selected physical release while browsing its project layer', async (t) => {
  const f = fixture(),
    original = f.core.query
  const token = {
    genresRevision: 1,
    catalogRevision: 1,
    contentRevision: 1,
    metadataRevision: 1,
    asOf: 100,
    expiresAt: null,
    contextKey: 'one'
  }
  const releases = [
    {
      id: 'release-group',
      entityId: 'physical-release',
      title: 'Original pressing',
      artist: 'Artist',
      current: true,
      identity: 'unidentified',
      metadataTargetId: null,
      sourceCount: 1,
      playbackVersionCount: 1
    },
    {
      id: 'remaster-group',
      entityId: 'physical-remaster',
      title: 'Remastered edition',
      artist: 'Artist',
      current: false,
      identity: 'unidentified',
      metadataTargetId: null,
      sourceCount: 1,
      playbackVersionCount: 1
    }
  ]
  f.core.query = async (name, query) => {
    if (name === 'albums.browse')
      return {
        token,
        project: null,
        projectCount: 0,
        currentRelease: releases[0],
        offset: 0,
        total: 2,
        items: releases,
        externalCatalog: 'unavailable'
      }
    if (name === 'albums.sources')
      return {
        token,
        release: releases.find((release) => release.id === query.releaseId),
        offset: 0,
        total: 0,
        items: [],
        providers: [],
        providerCount: 0
      }
    if (name === 'catalog.query') {
      f.queries.push({ name, query })
      return {
        revision: 1,
        offset: 0,
        total: 1,
        items: [
          {
            id: query.kind === 'release' ? 'physical-release' : 'album-project',
            kind: query.kind,
            title: 'Album',
            artist: 'Artist',
            identity: 'source',
            sourceCount: 1
          }
        ]
      }
    }
    if (name === 'catalog.sources') return { revision: 1, offset: 0, total: 0, items: [] }
    if (name === 'metadata.entity.detail')
      return {
        entityId: query.entityId,
        targetId: null,
        link: null,
        revision: 0,
        name: 'Album',
        introduction: null,
        override: null,
        facts: []
      }
    return original(name, query)
  }
  const Albums = component('../music-versions/AlbumVersionsPanel.vue', {
    vue: { ...vue, defineAsyncComponent: () => blank },
    './albumVersionsView.ts': albumModel,
    '../../stores/coreConnection.ts': { useCoreConnection: () => f.core },
    '../music-ratings/PersonalRatingsPanel.vue': { default: f.Panel }
  })
  const Panel = component('../music-metadata/EntityMetadataPanel.vue', {
    vue: { ...vue, defineAsyncComponent: () => Albums },
    './entityMetadataView.ts': metadataModel,
    '../../stores/coreConnection.ts': { useCoreConnection: () => f.core },
    '../../stores/useSettingsStore.ts': {
      useSettingsStore: () => ({ settings: ref({ musicIdentification: { language: 'en' } }) })
    },
    '../../app/useLocale.ts': { useLocale: () => ({ locale: ref('en-US') }) },
    './MetadataAttribution.vue': { default: blank },
    './IntroductionEditor.vue': { default: blank },
    './EntityArtwork.vue': { default: blank },
    './IdentityReviewPanel.vue': { default: blank },
    '../music-preferences/PersonalPreferencesPanel.vue': { default: blank }
  })
  const ui = mount(t, () =>
    h(Panel, {
      target: {
        kind: 'release',
        sourceProvider: 'local',
        context: { type: 'collection', collection: 'albums', id: 'Album' }
      }
    })
  )
  await settle()
  assert.equal(
    f.queries.find((query) => query.name === 'ratings.detail')!.query.entityId,
    'physical-release'
  )
  const remaster = ui
    .nodes()
    .find(
      (node) =>
        node.tag === 'button' &&
        node.children.some((child) => child.tag === 'strong' && child.text === 'Remastered edition')
    )!
  assert.ok(remaster)
  remaster.props.onClick()
  await settle()
  assert.equal(
    f.queries.findLast((query) => query.name === 'ratings.detail')!.query.entityId,
    'physical-remaster'
  )
  assert.match(ui.text(), /评分对象：Remastered edition/)
  assert.equal(
    ui.nodes().filter((node) => node.props['aria-label'] === '具体发行评分').length,
    1,
    'one release choice drives one rating editor'
  )
  ui.button('专辑作品').props.onClick()
  await settle()
  assert.equal(
    f.queries
      .filter((query) => query.name === 'ratings.detail')
      .every((query) => ['physical-release', 'physical-remaster'].includes(query.query.entityId)),
    true
  )
  assert.match(ui.text(), /具体发行评分/)
  assert.match(ui.text(), /评分对象：Remastered edition/)
  assert.equal(
    f.queries.filter((query) => query.name === 'catalog.query').at(-1)!.query.kind,
    'album_project'
  )
})

const impact = (): MusicRatingImpact => ({
  revision: 8,
  current: { steps: 7, revision: 3, updatedAt: 100 },
  target: { steps: 9, revision: 4, updatedAt: 200 },
  conflict: true,
  action: 'choose'
})
function identityFixture() {
  const snapshot = shallowRef({
    epoch: 'one',
    entityMetadataRevision: 1,
    ratingsRevision: 8,
    catalogRevision: 1,
    libraryRevision: 1,
    sequence: 0
  })
  const writes: Array<{ name: string; query: any }> = []
  const current = { entityId: 'recording-one', kind: 'recording', link: null, references: [] }
  const candidate = {
    id: 'candidate',
    entityId: 'recording-one',
    kind: 'recording',
    revision: 2,
    linkRevision: 0,
    state: 'candidate',
    suppressed: false,
    name: 'Recording',
    summary: '',
    provider: 'fixture',
    references: [],
    evidence: { matches: [], missing: [], conflicts: [], incomplete: false, provenance: 'fixture' }
  }
  const item = {
    seq: 4,
    state: 'confirmed',
    changedAt: 100,
    targetId: 'target',
    name: 'Recording',
    references: [],
    hasSnapshot: true,
    restoredFrom: null
  }
  const core = {
    state: snapshot,
    query: async (name: string, query: any) => {
      if (name === 'identification.detail') return current
      if (name === 'identification.candidates') return { total: 1, items: [candidate] }
      if (name === 'identification.preview')
        return {
          candidate,
          current,
          proposedTargetId: 'target',
          action: 'link',
          stale: false,
          conflicts: [],
          canConfirm: true,
          ratingImpact: impact()
        }
      if (name === 'identification.history')
        return {
          entityId: current.entityId,
          inputVersion: 'input',
          current,
          offset: 0,
          total: 1,
          items: [item]
        }
      if (name === 'identification.restorePreview')
        return {
          request: query,
          current,
          history: item,
          references: [],
          action: 'link',
          stale: false,
          conflicts: [],
          canRestore: true,
          ratingImpact: impact()
        }
      throw new Error(`Unexpected ${name}`)
    },
    command: async (name: string, query: any) => {
      writes.push({ name, query })
      return current
    }
  }
  const Impact = component('./IdentityRatingImpact.vue', {
    './personalRatingsView.ts': ratingsModel
  })
  const History = component('../music-metadata/IdentityHistoryPanel.vue', {
    './identityHistoryView.ts': historyModel,
    './identityReviewView.ts': reviewModel,
    './IdentityReferences.vue': { default: blank },
    '../music-ratings/IdentityRatingImpact.vue': { default: Impact },
    '../music-preferences/IdentityPreferenceImpact.vue': { default: blank },
    '../../stores/coreConnection.ts': { useCoreConnection: () => core }
  })
  const Review = component('../music-metadata/IdentityReviewPanel.vue', {
    './identityReviewView.ts': reviewModel,
    './IdentityHistoryPanel.vue': { default: History },
    './IdentityReferences.vue': { default: blank },
    '../music-ratings/IdentityRatingImpact.vue': { default: Impact },
    '../music-preferences/IdentityPreferenceImpact.vue': { default: blank },
    '../../stores/coreConnection.ts': { useCoreConnection: () => core }
  })
  return { snapshot, writes, Review }
}

test('compiled identity confirmation requires an explicit three-way rating choice and sends its revision', async (t) => {
  const f = identityFixture(),
    ui = mount(t, () => h(f.Review, { entityId: 'recording-one', scope: 'one' }))
  await settle()
  ui.button('复核此候选').props.onClick()
  await settle()
  assert.match(ui.text(), /当前条目：3.5 星 · 目标身份：4.5 星/)
  assert.equal(ui.button('确认关联').props.disabled, true)
  ui.button('采用目标评分（4.5 星）').props.onClick()
  await settle()
  assert.equal(ui.button('采用目标评分（4.5 星）').props['aria-pressed'], true)
  ui.button('采用当前评分（3.5 星）').props.onClick()
  await settle()
  assert.equal(ui.button('确认关联').props.disabled, false)
  ui.button('确认关联').props.onClick()
  await settle()
  assert.deepEqual(f.writes[0].query.ratingResolution, { revision: 8, choice: 'current' })
  ui.button('复核此候选').props.onClick()
  await settle()
  const readsBefore = f.writes.length
  f.snapshot.value = { ...f.snapshot.value, ratingsRevision: 9 }
  await settle()
  assert.doesNotMatch(ui.text(), /当前条目：3.5 星/)
  assert.match(ui.text(), /读取最新身份后再复核/)
  assert.equal(f.writes.length, readsBefore)
})

test('compiled history restore uses its own explicit choice and does not reuse a discarded confirmation choice', async (t) => {
  const f = identityFixture(),
    ui = mount(t, () => h(f.Review, { entityId: 'recording-one', scope: 'one' }))
  await settle()
  ui.button('查看关联历史').props.onClick()
  await settle()
  ui.button('比较并恢复').props.onClick()
  await settle()
  assert.equal(ui.button('确认恢复此关联').props.disabled, true)
  ui.button('清除目标评分').props.onClick()
  await settle()
  assert.equal(ui.button('确认恢复此关联').props.disabled, false)
  ui.button('确认恢复此关联').props.onClick()
  await settle()
  assert.equal(f.writes[0].name, 'identification.restore')
  assert.deepEqual(f.writes[0].query.ratingResolution, { revision: 8, choice: 'clear' })
})
