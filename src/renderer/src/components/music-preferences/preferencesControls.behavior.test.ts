/* eslint-disable vue/one-component-per-file */
import assert from 'node:assert/strict'
import test from 'node:test'
import { h, ref, shallowRef } from 'vue'
import * as vue from 'vue'
import { component, mount, settle } from '../music-ratings/ratingsTestRenderer.ts'
import * as preferencesModel from './personalPreferencesView.ts'
import * as ratingsModel from '../music-ratings/personalRatingsView.ts'
import * as targetsModel from '../music-ratings/ratingTargetsView.ts'
import * as trackModel from '../music-ratings/trackRatingsView.ts'
import * as metadataModel from '../music-metadata/entityMetadataView.ts'
import * as reviewModel from '../music-metadata/identityReviewView.ts'
import * as historyModel from '../music-metadata/identityHistoryView.ts'
import * as albumModel from '../music-versions/albumVersionsView.ts'
import { getTrackSource } from '../../../../shared/trackSourceIdentity.ts'
import type {
  MusicPreferencesDetail,
  MusicPreferenceImpact
} from '../../../../shared/musicPreferences.ts'
import type { Track } from '../../types/music.ts'

const blank = { render: () => null }
const preference = (
  entityId: string,
  state: 'none' | 'favorite' | 'ban' = 'none',
  revision = 1
): MusicPreferencesDetail => ({
  entityId,
  kind: 'recording',
  scope: 'entity',
  value: { state, revision, updatedAt: 100 },
  token: { preferencesRevision: revision, linkRevision: 0, targetKey: `entity:${entityId}` }
})
function fixture() {
  const snapshot = shallowRef({
    epoch: 'one',
    preferencesRevision: 1,
    ratingsRevision: 1,
    entityMetadataRevision: 1,
    catalogRevision: 1,
    libraryRevision: 1,
    sequence: 0
  })
  const queries: Array<{ name: string; query: any }> = [],
    writes: Array<{ name: string; query: any }> = []
  const saved = new Map<string, MusicPreferencesDetail>()
  let fail = false
  const core = {
    state: snapshot,
    query: async (name: string, query: any): Promise<any> => {
      queries.push({ name, query })
      if (name === 'preferences.detail')
        return saved.get(query.entityId) ?? preference(query.entityId)
      if (name === 'ratings.detail')
        return {
          entityId: query.entityId,
          kind: 'recording',
          scope: 'entity',
          value: null,
          token: { ratingsRevision: 1, linkRevision: 0, targetKey: `entity:${query.entityId}` }
        }
      if (name === 'ratings.targets')
        return {
          entityId: query.entityId,
          offset: 0,
          total: 1,
          items: [{ id: query.entityId, kind: 'recording', title: 'Recording', artist: 'Artist' }]
        }
      throw new Error(`Unexpected ${name}`)
    },
    command: async (name: string, query: any) => {
      writes.push({ name, query })
      if (fail) throw new Error('disconnected')
      const next = preference(query.entityId, query.state, snapshot.value.preferencesRevision + 1)
      saved.set(query.entityId, next)
      snapshot.value = { ...snapshot.value, preferencesRevision: next.token.preferencesRevision }
      return next
    }
  }
  const Panel = component('../music-preferences/PersonalPreferencesPanel.vue', {
    './personalPreferencesView.ts': preferencesModel,
    '../../stores/coreConnection.ts': { useCoreConnection: () => core }
  })
  const Ratings = component('./PersonalRatingsPanel.vue', {
    './personalRatingsView.ts': ratingsModel,
    './ratingTargetsView.ts': targetsModel,
    '../music-preferences/PersonalPreferencesPanel.vue': { default: Panel },
    '../music-tags/MusicTagsPanel.vue': { default: blank },
    '../../stores/coreConnection.ts': { useCoreConnection: () => core }
  })
  return {
    snapshot,
    queries,
    writes,
    core,
    Panel,
    Ratings,
    fail: () => {
      fail = true
    }
  }
}

test('compiled preference controls save favorite, switch to ban, and unban without provider calls', async (t) => {
  const f = fixture(),
    ui = mount(t, () => h(f.Panel, { entityId: 'recording-one', label: '录音' }))
  await settle()
  assert.match(ui.text(), /禁播只影响自动选曲，手动播放仍可用/)
  ui.button('喜欢').props.onClick()
  await settle()
  assert.match(ui.text(), /已保存：喜欢/)
  assert.equal(ui.button('取消喜欢').props['aria-pressed'], true)
  ui.button('禁播').props.onClick()
  await settle()
  assert.match(ui.text(), /已保存：禁播/)
  assert.equal(ui.button('喜欢').props['aria-pressed'], false)
  ui.button('取消禁播').props.onClick()
  await settle()
  assert.match(ui.text(), /已保存：无偏好/)
  assert.deepEqual(
    f.writes.map((write) => [write.name, write.query.state]),
    [
      ['preferences.set', 'favorite'],
      ['preferences.set', 'ban'],
      ['preferences.set', 'none']
    ]
  )
  assert.equal(
    f.queries.every((query) => query.name === 'preferences.detail'),
    true
  )
})

test('compiled work and exact-person controls label organization exclusion without claiming participant playback bans', async t => {
  for (const kind of ['work', 'artist'] as const) {
    const f = fixture()
    f.core.query = async (name, query) => {
      assert.equal(name, 'preferences.detail')
      return { ...preference(query.entityId), kind }
    }
    f.core.command = async (name, query) => {
      f.writes.push({ name, query })
      throw new Error('lost reply')
    }
    const ui = mount(t, () => h(f.Panel, { entityId: kind, label: kind === 'work' ? '作品' : '人物' }))
    await settle()
    assert.match(ui.text(), /此整理状态不影响参与歌曲的自动选曲/)
    assert.doesNotMatch(ui.text(), /禁播只影响/)
    ui.button('不推荐').props.onClick()
    await settle()
    assert.match(ui.text(), /保留的操作：不推荐/)
    assert.equal(f.writes.length, 1)
    assert.equal(f.writes[0].query.entityId, kind)
    assert.equal(f.writes[0].query.state, 'ban')
  }
})

test('compiled controls withdraw stale receipts, preserve failed intent, and do not replay on reread', async (t) => {
  const f = fixture(),
    ui = mount(t, () => h(f.Panel, { entityId: 'one', label: '录音' }))
  await settle()
  const reads = f.queries.length
  f.snapshot.value = { ...f.snapshot.value, sequence: 2 }
  await settle()
  assert.equal(f.queries.length, reads)
  f.snapshot.value = { ...f.snapshot.value, preferencesRevision: 2 }
  await settle()
  assert.doesNotMatch(ui.text(), /已保存：/)
  ui.button('重新读取偏好').props.onClick()
  await settle()
  f.fail()
  ui.button('禁播').props.onClick()
  await settle()
  assert.match(ui.text(), /保存结果未确认/)
  assert.match(ui.text(), /保留的操作：禁播/)
  assert.equal(ui.button('保存保留的偏好').props.disabled, true)
  ui.button('重新读取偏好').props.onClick()
  await settle()
  assert.equal(f.writes.length, 1)
  assert.equal(ui.button('保存保留的偏好').props.disabled, false)
})

test('initial unknown preference revision becoming known does not abort the compiled first read', async (t) => {
  const f = fixture(),
    original = f.core.query
  f.snapshot.value = { ...f.snapshot.value, preferencesRevision: null as any }
  f.core.query = async (name, query) => {
    if (name !== 'preferences.detail') return original(name, query)
    f.queries.push({ name, query })
    await Promise.resolve()
    f.snapshot.value = { ...f.snapshot.value, preferencesRevision: 0 }
    return preference(query.entityId, 'favorite', 0)
  }
  const ui = mount(t, () => h(f.Panel, { entityId: 'one', label: '录音' }))
  await settle()
  assert.match(ui.text(), /已保存：喜欢/)
  assert.equal(f.queries.length, 1)
})

test('track preferences reuse the exact physical recording of the selected provider track', async (t) => {
  const f = fixture(),
    original = f.core.query
  f.core.query = async (name, query) => {
    if (name === 'catalog.query') {
      f.queries.push({ name, query })
      return {
        revision: 1,
        offset: 0,
        total: 1,
        items: [
          {
            id: 'manual-recording',
            kind: 'recording',
            title: 'Track',
            artist: 'Artist',
            sourceCount: 2,
            identity: 'source'
          }
        ]
      }
    }
    if (name === 'ratings.targets') {
      f.queries.push({ name, query })
      assert.deepEqual(query.trackContext, { provider: 'ncm', id: '42' })
      return {
        entityId: query.entityId,
        offset: 0,
        total: 1,
        items: [
          { id: 'physical-ncm-recording', kind: 'recording', title: 'Track', artist: 'Artist' }
        ]
      }
    }
    return original(name, query)
  }
  const Host = component('./TrackRatingsPanel.vue', {
    './trackRatingsView.ts': trackModel,
    '../../../../shared/trackSourceIdentity.ts': { getTrackSource },
    './PersonalRatingsPanel.vue': { default: f.Ratings },
    '../../stores/coreConnection.ts': { useCoreConnection: () => f.core }
  })
  const track: Track = {
    id: '42',
    source: 'ncm',
    title: 'Track',
    artist: 'Artist',
    album: '',
    duration: 60,
    size: 0
  }
  const ui = mount(t, () => h(Host, { track }))
  await settle()
  ui.button('喜欢').props.onClick()
  await settle()
  assert.equal(f.writes[0].query.entityId, 'physical-ncm-recording')
  assert.equal(
    f.queries
      .filter((query) => query.name === 'preferences.detail')
      .every((query) => query.query.entityId === 'physical-ncm-recording'),
    true
  )
  assert.equal(ui.nodes().filter((node) => node.props['aria-label'] === '录音偏好').length, 1)
})

test('one album release choice drives both rating and preference editors, never project or manual IDs', async (t) => {
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
      id: 'group-one',
      entityId: 'physical-first',
      title: 'First pressing',
      artist: 'Artist',
      current: true,
      identity: 'unidentified',
      metadataTargetId: null,
      sourceCount: 1,
      playbackVersionCount: 1
    },
    {
      id: 'group-two',
      entityId: 'physical-remaster',
      title: 'Remaster',
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
    return original(name, query)
  }
  const Albums = component('../music-versions/AlbumVersionsPanel.vue', {
    vue: { ...vue, defineAsyncComponent: () => blank },
    './albumVersionsView.ts': albumModel,
    '../../stores/coreConnection.ts': { useCoreConnection: () => f.core },
    '../music-ratings/PersonalRatingsPanel.vue': { default: f.Ratings }
  })
  const ui = mount(t, () => h(Albums, { entityId: 'manual-album' }))
  await settle()
  const remaster = ui
    .nodes()
    .find(
      (node) =>
        node.tag === 'button' &&
        node.children.some((child) => child.tag === 'strong' && child.text === 'Remaster')
    )!
  remaster.props.onClick()
  await settle()
  ui.button('禁播').props.onClick()
  await settle()
  assert.equal(f.writes[0].query.entityId, 'physical-remaster')
  assert.equal(ui.nodes().filter((node) => node.props['aria-label'] === '具体发行偏好').length, 1)
  assert.equal(
    f.queries
      .filter((query) => ['ratings.detail', 'preferences.detail'].includes(query.name))
      .every((query) => ['physical-first', 'physical-remaster'].includes(query.query.entityId)),
    true
  )
})

test('artist preferences appear only for the selected confirmed artist identity, not an unconfirmed name', async (t) => {
  const f = fixture(),
    original = f.core.query
  let confirmed = false
  f.core.query = async (name, query) => {
    if (name === 'catalog.query')
      return {
        revision: 1,
        offset: 0,
        total: 1,
        items: [
          {
            id: 'artist-one',
            kind: 'artist',
            title: 'Same name',
            artist: '',
            sourceCount: 1,
            identity: 'source'
          }
        ]
      }
    if (name === 'catalog.sources') return { revision: 1, offset: 0, total: 0, items: [] }
    if (name === 'metadata.entity.detail')
      return {
        entityId: query.entityId,
        targetId: confirmed ? 'confirmed-artist' : null,
        link: confirmed ? { state: 'confirmed', revision: 1, mbid: 'artist-native' } : null,
        revision: 1,
        name: 'Same name',
        introduction: null,
        override: null,
        facts: []
      }
    return original(name, query)
  }
  const Artist = component('../music-metadata/EntityMetadataPanel.vue', {
    vue: { ...vue, defineAsyncComponent: () => blank },
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
    '../music-preferences/PersonalPreferencesPanel.vue': { default: f.Panel }
  })
  const ui = mount(t, () =>
    h(Artist, {
      target: {
        kind: 'artist',
        sourceProvider: 'local',
        context: { type: 'collection', collection: 'artists', id: 'Same name' }
      }
    })
  )
  await settle()
  assert.equal(
    f.queries.some((query) => query.name === 'preferences.detail'),
    false
  )
  confirmed = true
  ui.button('重新读取').props.onClick()
  await settle()
  assert.equal(
    f.queries.find((query) => query.name === 'preferences.detail')!.query.entityId,
    'artist-one'
  )
  assert.match(ui.text(), /艺人偏好/)
  confirmed = false
  ui.button('重新读取').props.onClick()
  await settle()
  assert.doesNotMatch(ui.text(), /艺人偏好/)
})

const impact = (): MusicPreferenceImpact => ({
  revision: 9,
  current: { state: 'favorite', revision: 2, updatedAt: 100 },
  target: { state: 'ban', revision: 3, updatedAt: 200 },
  conflict: true,
  action: 'choose'
})
function identityFixture() {
  const f = fixture()
  const current = { entityId: 'recording-one', kind: 'recording', link: null, references: [] }
  const candidate = {
    id: 'candidate',
    entityId: current.entityId,
    kind: 'recording',
    revision: 2,
    linkRevision: 0,
    state: 'candidate',
    suppressed: false,
    name: 'Track',
    summary: '',
    provider: 'fixture',
    references: [],
    evidence: { matches: [], missing: [], conflicts: [], incomplete: false, provenance: 'fixture' }
  }
  const history = {
    seq: 4,
    state: 'confirmed',
    changedAt: 100,
    targetId: 'target',
    name: 'Track',
    references: [],
    hasSnapshot: true,
    restoredFrom: null
  }
  const ratingImpact = {
    revision: 8,
    current: { steps: 7, revision: 2, updatedAt: 100 },
    target: { steps: 9, revision: 3, updatedAt: 200 },
    conflict: true,
    action: 'choose'
  }
  f.core.query = async (name, query) => {
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
        preferenceImpact: impact(),
        ratingImpact
      }
    if (name === 'identification.history')
      return {
        entityId: current.entityId,
        inputVersion: 'input',
        current,
        offset: 0,
        total: 1,
        items: [history]
      }
    if (name === 'identification.restorePreview')
      return {
        request: query,
        current,
        history,
        references: [],
        action: 'link',
        stale: false,
        conflicts: [],
        canRestore: true,
        preferenceImpact: impact(),
        ratingImpact
      }
    throw new Error(`Unexpected ${name}`)
  }
  f.core.command = async (name, query) => {
    f.writes.push({ name, query })
    return current as any
  }
  const PreferenceImpact = component('../music-preferences/IdentityPreferenceImpact.vue', {
    './personalPreferencesView.ts': preferencesModel
  })
  const RatingImpact = component('./IdentityRatingImpact.vue', {
    './personalRatingsView.ts': ratingsModel
  })
  const imports = {
    '../../stores/coreConnection.ts': { useCoreConnection: () => f.core },
    './IdentityReferences.vue': { default: blank },
    '../music-preferences/IdentityPreferenceImpact.vue': { default: PreferenceImpact },
    '../music-ratings/IdentityRatingImpact.vue': { default: RatingImpact }
  }
  const History = component('../music-metadata/IdentityHistoryPanel.vue', {
    ...imports,
    './identityHistoryView.ts': historyModel,
    './identityReviewView.ts': reviewModel
  })
  const Review = component('../music-metadata/IdentityReviewPanel.vue', {
    ...imports,
    './identityReviewView.ts': reviewModel,
    './IdentityHistoryPanel.vue': { default: History }
  })
  return { ...f, Review }
}

test('identity confirmation requires independent rating and preference choices, each with its revision', async (t) => {
  const f = identityFixture(),
    ui = mount(t, () => h(f.Review, { entityId: 'recording-one', scope: 'one' }))
  await settle()
  ui.button('复核此候选').props.onClick()
  await settle()
  assert.match(ui.text(), /当前偏好：喜欢 · 目标偏好：禁播/)
  assert.equal(ui.button('确认关联').props.disabled, true)
  ui.button('采用当前评分（3.5 星）').props.onClick()
  await settle()
  assert.equal(ui.button('确认关联').props.disabled, true)
  ui.button('采用目标偏好（禁播）').props.onClick()
  await settle()
  assert.equal(ui.button('确认关联').props.disabled, false)
  ui.button('确认关联').props.onClick()
  await settle()
  assert.deepEqual(f.writes[0].query.ratingResolution, { revision: 8, choice: 'current' })
  assert.deepEqual(f.writes[0].query.preferenceResolution, { revision: 9, choice: 'target' })
})

test('compiled identity confirmation exposes every related-person preference as an explicit existing-authority choice', async t => {
  const f = identityFixture(), original = f.core.query
  f.core.query = async (name, query) => {
    const result = await original(name, query)
    return name === 'identification.preview' ? { ...result, preferenceImpact: { ...result.preferenceImpact,
      related: [{ entityId: 'exact-graph-person', title: 'Exact person', value: { state: 'ban', revision: 3, updatedAt: 100 } }] } } : result
  }
  const ui = mount(t, () => h(f.Review, { entityId: 'recording-one', scope: 'one' })); await settle()
  ui.button('复核此候选').props.onClick(); await settle()
  assert.match(ui.text(), /当前／关联条目偏好/)
  ui.button('采用当前评分（3.5 星）').props.onClick()
  ui.button('采用“Exact person”偏好（禁播）').props.onClick(); await settle()
  assert.equal(ui.button('确认关联').props.disabled, false)
  ui.button('确认关联').props.onClick(); await settle()
  assert.deepEqual(f.writes[0].query.preferenceResolution, { revision: 9, choice: 'related:exact-graph-person' })
})

test('preference revision invalidates an identity preview and clears both choices', async (t) => {
  const f = identityFixture(),
    ui = mount(t, () => h(f.Review, { entityId: 'recording-one', scope: 'one' }))
  await settle()
  ui.button('复核此候选').props.onClick()
  await settle()
  ui.button('采用当前评分（3.5 星）').props.onClick()
  ui.button('采用目标偏好（禁播）').props.onClick()
  f.snapshot.value = { ...f.snapshot.value, preferencesRevision: 2 }
  await settle()
  assert.doesNotMatch(ui.text(), /当前偏好：/)
  assert.match(ui.text(), /读取最新身份后再复核/)
  assert.equal(f.writes.length, 0)
  ui.button('读取最新身份').props.onClick()
  await settle()
  ui.button('复核此候选').props.onClick()
  await settle()
  assert.equal(ui.button('确认关联').props.disabled, true)
  assert.equal(ui.button('采用目标偏好（禁播）').props['aria-pressed'], false)
})

test('history restore keeps a separate preference choice and sends explicit clear without reusing cancelled choices', async (t) => {
  const f = identityFixture(),
    ui = mount(t, () => h(f.Review, { entityId: 'recording-one', scope: 'one' }))
  await settle()
  ui.button('复核此候选').props.onClick()
  await settle()
  ui.button('采用当前偏好（喜欢）').props.onClick()
  ui.button('取消复核').props.onClick()
  await settle()
  ui.button('查看关联历史').props.onClick()
  await settle()
  ui.button('比较并恢复').props.onClick()
  await settle()
  ui.button('采用目标评分（4.5 星）').props.onClick()
  await settle()
  assert.equal(ui.button('确认恢复此关联').props.disabled, true)
  ui.button('清除目标偏好').props.onClick()
  await settle()
  assert.equal(ui.button('确认恢复此关联').props.disabled, false)
  ui.button('确认恢复此关联').props.onClick()
  await settle()
  assert.equal(f.writes[0].name, 'identification.restore')
  assert.deepEqual(f.writes[0].query.preferenceResolution, { revision: 9, choice: 'clear' })
  assert.deepEqual(f.writes[0].query.ratingResolution, { revision: 8, choice: 'target' })
})
