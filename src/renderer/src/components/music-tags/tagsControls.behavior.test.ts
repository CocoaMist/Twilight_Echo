/* eslint-disable vue/one-component-per-file */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { compile, parse as parseTemplate } from '@vue/compiler-dom'
import { parse as parseSfc } from '@vue/compiler-sfc'
import { h, shallowRef } from 'vue'
import * as vue from 'vue'
import { component, mount, settle } from '../music-ratings/ratingsTestRenderer.ts'
import * as tagsModel from './musicTagsView.ts'
import { tagsFixture } from './musicTagsTest.fixture.ts'
import * as ratingsModel from '../music-ratings/personalRatingsView.ts'
import * as targetsModel from '../music-ratings/ratingTargetsView.ts'
import * as trackModel from '../music-ratings/trackRatingsView.ts'
import * as albumModel from '../music-versions/albumVersionsView.ts'
import { getTrackSource } from '../../../../shared/trackSourceIdentity.ts'
import type { Track } from '../../types/music.ts'

const blank = { render: () => null }
function fixture(count = 2) {
  const f = tagsFixture(count),
    snapshot = shallowRef({
      epoch: 'one',
      tagsRevision: 1,
      tagsLinkRevision: 0,
      ratingsRevision: 1,
      catalogRevision: 1,
      libraryRevision: 1,
      entityMetadataRevision: 0,
      sequence: 0
    })
  f.onChanged((token) => {
    snapshot.value = { ...snapshot.value, tagsRevision: token.tagsRevision }
  })
  const extraQueries: Array<{ name: string; query: any }> = []
  const core = {
    state: snapshot,
    query: async (
      name: string,
      query: any,
      signal = new AbortController().signal
    ): Promise<any> => {
      if (name === 'tags.entity') return f.api.entity(query, signal)
      if (name === 'tags.list') return f.api.list(query, signal)
      if (name === 'tags.members') return f.api.members(query, signal)
      if (name === 'tags.recordings') return f.api.recordings(query, signal)
      extraQueries.push({ name, query })
      if (name === 'ratings.targets')
        return {
          entityId: query.entityId,
          offset: 0,
          total: 1,
          items: [{ id: query.entityId, kind: 'recording', title: 'Physical', artist: 'Artist' }]
        }
      if (name === 'ratings.detail')
        return {
          entityId: query.entityId,
          kind: 'recording',
          scope: 'entity',
          value: null,
          token: { ratingsRevision: 1, linkRevision: 0, targetKey: `entity:${query.entityId}` }
        }
      throw new Error(`Unexpected ${name}`)
    },
    command: async (
      name: string,
      query: any,
      signal = new AbortController().signal
    ): Promise<any> => {
      if (name === 'tags.create') return f.api.create(query)
      if (name === 'tags.rename') return f.api.rename(query)
      if (name === 'tags.delete') return f.api.delete(query)
      if (name === 'tags.member.set') return f.api.memberSet(query)
      if (name === 'tags.play') return f.api.play(query, signal)
      throw new Error(`Unexpected ${name}`)
    }
  }
  const Panel = component('../music-tags/MusicTagsPanel.vue', {
    './musicTagsView.ts': tagsModel,
    '../../../../shared/musicTags.ts': {
      validMusicTagName: (name: string) => !!name.trim() && name.length <= 80
    },
    '../../stores/coreConnection.ts': { useCoreConnection: () => core }
  })
  const Ratings = component('./PersonalRatingsPanel.vue', {
    './personalRatingsView.ts': ratingsModel,
    './ratingTargetsView.ts': targetsModel,
    '../music-preferences/PersonalPreferencesPanel.vue': { default: blank },
    '../music-tags/MusicTagsPanel.vue': { default: Panel },
    '../../stores/coreConnection.ts': { useCoreConnection: () => core }
  })
  return { ...f, core, snapshot, extraQueries, Panel, Ratings }
}
const event = { preventDefault() {} }
function nodeText(node: { text: string; children: any[] }): string {
  return node.text + node.children.map(nodeText).join('')
}
function byAria(ui: ReturnType<typeof mount>, label: string) {
  const node = ui.nodes().find((item) => item.props['aria-label'] === label)
  assert.ok(node, `Missing aria-label ${label}`)
  return node
}
function input(ui: ReturnType<typeof mount>, label: string, value: string) {
  const container = ui
    .nodes()
    .find((item) => item.tag === 'label' && nodeText(item).startsWith(label))
  assert.ok(container)
  const node = container.children.find((item) => item.tag === 'input')!
  node.props.onInput({ target: { value } })
}
function submit(ui: ReturnType<typeof mount>, text: string) {
  const form = ui.nodes().find((item) => item.tag === 'form' && nodeText(item).includes(text))
  assert.ok(form)
  form.props.onSubmit(event)
}

test('compiled local controls create, assign, rename and explicitly delete without provider calls', async (t) => {
  const f = fixture(),
    ui = mount(t, () => h(f.Panel, { entityId: 'physical-local', label: '录音' }))
  await settle()
  ui.button('管理标签').props.onClick()
  await settle()
  input(ui, '新标签名称', '夜间')
  await settle()
  submit(ui, '创建标签')
  await settle()
  assert.equal(f.writes[0].name, 'tags.create')
  byAria(ui, '将当前条目加入 夜间').props.onClick()
  await settle()
  assert.equal(f.writes[1].query.entityId, 'physical-local')
  assert.match(ui.text(), /标签已保存/)
  byAria(ui, '重命名 夜间').props.onClick()
  await settle()
  input(ui, '标签新名称', '深夜')
  await settle()
  submit(ui, '保存名称')
  await settle()
  assert.equal(f.writes[2].name, 'tags.rename')
  byAria(ui, '删除标签 深夜').props.onClick()
  await settle()
  assert.equal(f.writes.length, 3)
  assert.match(ui.text(), /只删除标签及其引用，不删除歌曲、专辑、人物、作品或来源/)
  ui.button('保留标签').props.onClick()
  await settle()
  assert.equal(f.writes.length, 3)
  byAria(ui, '删除标签 深夜').props.onClick()
  await settle()
  ui.button('确认删除标签').props.onClick()
  await settle()
  assert.equal(f.writes[3].name, 'tags.delete')
  assert.equal(
    f.queries.every((item) => item.name.startsWith('tags.')),
    true
  )
})

test('compiled tags show exact person/work member kinds while keeping song expansion explicit', async t => {
  const f = fixture(1)
  f.references.set(f.tags[0].id, [
    { id: 'person', kind: 'artist', title: 'Same name', artist: '', inLibrary: true, sourceCount: 2 },
    { id: 'work', kind: 'work', title: 'Work', artist: '', inLibrary: false, sourceCount: 0 }
  ])
  const ui = mount(t, () => h(f.Panel, { entityId: 'work', label: '作品' }))
  await settle()
  ui.button(f.tags[0].name).props.onClick()
  await settle()
  assert.match(ui.text(), /人物 ·/)
  assert.match(ui.text(), /作品 ·/)
  assert.match(ui.text(), /人物与作品标签不自动展开歌曲/)
  assert.match(ui.text(), /此标签当前没有可展开的库内歌曲/)
  assert.equal(f.writes.length, 0)
})

test('compiled membership and all-tags lists expose independent complete pagination, not false toggles', async (t) => {
  const f = fixture(14)
  for (const tag of f.tags)
    f.references.set(tag.id, [
      { id: 'one', kind: 'recording', title: 'One', artist: '', inLibrary: false, sourceCount: 0 }
    ])
  const ui = mount(t, () => h(f.Panel, { entityId: 'one', label: '录音' }))
  await settle()
  ui.button('下一页已加入标签').props.onClick()
  await settle()
  assert.match(ui.text(), /13–14 \/ 14/)
  ui.button('管理标签').props.onClick()
  await settle()
  assert.match(ui.text(), /全部标签 · 14/)
  assert.equal(
    ui.nodes().filter((item) => item.props['aria-label']?.startsWith('将当前条目加入 ')).length,
    12
  )
  ui.button('下一页标签').props.onClick()
  await settle()
  assert.equal(
    ui.nodes().filter((item) => item.props['aria-label']?.startsWith('将当前条目加入 ')).length,
    2
  )
  byAria(ui, '将当前条目移出 标签 14').props.onClick()
  await settle()
  assert.equal(f.writes[0].query.present, false)
  assert.equal(f.writes[0].query.entityId, 'one')
})

test('compiled stale writes retain the visible intent and explicit reread does not replay it', async (t) => {
  const f = fixture(),
    ui = mount(t, () => h(f.Panel, { entityId: 'one', label: '录音' }))
  await settle()
  ui.button('管理标签').props.onClick()
  await settle()
  f.tags[0].membersRevision = 7
  byAria(ui, '将当前条目加入 标签 1').props.onClick()
  await settle()
  assert.match(ui.text(), /操作已保留，请重新读取核对/)
  assert.match(ui.text(), /保留的操作：加入“标签 1”/)
  assert.equal(ui.button('保存保留的标签操作').props.disabled, true)
  ui.button('重新读取标签').props.onClick()
  await settle()
  assert.equal(f.writes.length, 1)
  assert.equal(ui.button('保存保留的标签操作').props.disabled, false)
  ui.button('保存保留的标签操作').props.onClick()
  await settle()
  assert.equal(f.writes[1].query.membersRevision, 7)
})

test('compiled tag contents manage offline album references and separately page live deduplicated songs', async (t) => {
  const f = fixture()
  f.references.set('tag-1', [
    {
      id: 'release-old',
      kind: 'release',
      title: '离线专辑',
      artist: '',
      inLibrary: false,
      sourceCount: 0
    }
  ])
  f.recordings.set(
    'tag-1',
    Array.from({ length: 14 }, (_, index) => ({
      recordingId: `recording-${index}`,
      sourceId: `source-${index}`,
      title: `歌曲 ${index}`,
      artist: 'Artist',
      provider: 'local',
      sourceCount: 2
    }))
  )
  const ui = mount(t, () => h(f.Panel, { entityId: 'one', label: '录音' }))
  await settle()
  ui.button('管理标签').props.onClick()
  await settle()
  const tag = ui
    .nodes()
    .find(
      (item) =>
        item.tag === 'button' &&
        item.children.some((child) => child.tag === 'strong' && child.text === '标签 1')
    )!
  tag.props.onClick()
  await settle()
  assert.match(ui.text(), /具体发行 · 未知艺人 · 已不在库中/)
  assert.match(ui.text(), /14 首，按录音去重/)
  ui.button('下一页库内歌曲').props.onClick()
  await settle()
  assert.match(ui.text(), /歌曲 13/)
  byAria(ui, '从此标签移出 离线专辑').props.onClick()
  await settle()
  assert.equal(f.writes[0].query.entityId, 'release-old')
  assert.equal(f.writes[0].query.present, false)
})

test('compiled playback sends the tag token, allows cancel, and never reports a late success', async (t) => {
  const f = fixture()
  f.recordings.set('tag-1', [
    {
      recordingId: 'one',
      sourceId: 'source-one',
      title: 'One',
      artist: '',
      provider: 'local',
      sourceCount: 1
    }
  ])
  let complete!: () => void,
    signal!: AbortSignal,
    calls = 0
  f.api.play = async (_query, value) => {
    calls++
    signal = value
    await new Promise<void>((resolve) => {
      complete = resolve
    })
    return { total: 1, selectedIndex: 0 }
  }
  const ui = mount(t, () => h(f.Panel, { entityId: 'one', label: '录音' }))
  await settle()
  ui.button('管理标签').props.onClick()
  await settle()
  ui.nodes()
    .find(
      (item) =>
        item.tag === 'button' &&
        item.children.some((child) => child.tag === 'strong' && child.text === '标签 1')
    )!
    .props.onClick()
  await settle()
  ui.button('播放标签集合').props.onClick()
  await settle()
  assert.equal(ui.button('播放标签集合').props.disabled, true)
  ui.button('取消准备').props.onClick()
  await settle()
  assert.equal(signal.aborted, true)
  complete()
  await settle()
  assert.match(ui.text(), /核对当前队列，不要重复点击/)
  assert.doesNotMatch(ui.text(), /已播放标签集合/)
  ui.button('重新读取标签').props.onClick()
  await settle()
  assert.equal(calls, 1)
})

test('actual track entry supplies only the exact physical provider recording to tags', async (t) => {
  const f = fixture(),
    original = f.core.query
  f.core.query = async (name, query, signal) => {
    if (name === 'catalog.query')
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
    if (name === 'ratings.targets') {
      assert.deepEqual(query.trackContext, { provider: 'ncm', id: '42' })
      return {
        entityId: query.entityId,
        offset: 0,
        total: 1,
        items: [{ id: 'physical-ncm', kind: 'recording', title: 'Track', artist: 'Artist' }]
      }
    }
    return original(name, query, signal)
  }
  const TrackPanel = component('./TrackRatingsPanel.vue', {
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
  const ui = mount(t, () => h(TrackPanel, { track }))
  await settle()
  ui.button('管理标签').props.onClick()
  await settle()
  byAria(ui, '将当前条目加入 标签 1').props.onClick()
  await settle()
  assert.equal(f.writes[0].query.entityId, 'physical-ncm')
  assert.equal(
    f.queries
      .filter((item) => item.name === 'tags.entity')
      .every((item) => item.query.entityId === 'physical-ncm'),
    true
  )
  assert.equal(ui.nodes().filter((item) => item.props['aria-label'] === '录音标签').length, 1)
})

test('actual album release choice supplies the physical release, never project or manual version', async (t) => {
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
  const releases = ['first', 'remaster'].map((id, index) => ({
    id: `group-${id}`,
    entityId: `physical-${id}`,
    title: id,
    artist: 'Artist',
    current: index === 0,
    identity: 'unidentified',
    metadataTargetId: null,
    sourceCount: 1,
    playbackVersionCount: 1
  }))
  f.core.query = async (name, query, signal) => {
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
        release: releases.find((item) => item.id === query.releaseId),
        offset: 0,
        total: 0,
        items: [],
        providers: [],
        providerCount: 0
      }
    return original(name, query, signal)
  }
  const Albums = component('../music-versions/AlbumVersionsPanel.vue', {
    vue: { ...vue, defineAsyncComponent: () => blank },
    './albumVersionsView.ts': albumModel,
    '../../stores/coreConnection.ts': { useCoreConnection: () => f.core },
    '../music-ratings/PersonalRatingsPanel.vue': { default: f.Ratings }
  })
  const ui = mount(t, () => h(Albums, { entityId: 'manual-album' }))
  await settle()
  ui.nodes()
    .find(
      (item) =>
        item.tag === 'button' &&
        item.children.some((child) => child.tag === 'strong' && child.text === 'remaster')
    )!
    .props.onClick()
  await settle()
  ui.button('管理标签').props.onClick()
  await settle()
  byAria(ui, '将当前条目加入 标签 1').props.onClick()
  await settle()
  assert.equal(f.writes[0].query.entityId, 'physical-remaster')
  assert.equal(
    f.queries
      .filter((item) => item.name === 'tags.entity')
      .every((item) => ['physical-first', 'physical-remaster'].includes(item.query.entityId)),
    true
  )
})

test('compiled revision changes withdraw saved pages while unrelated snapshots keep the view', async (t) => {
  const f = fixture(),
    ui = mount(t, () => h(f.Panel, { entityId: 'one', label: '录音' }))
  await settle()
  const count = f.queries.length
  f.snapshot.value = { ...f.snapshot.value, sequence: 3 }
  await settle()
  assert.equal(f.queries.length, count)
  f.snapshot.value = { ...f.snapshot.value, tagsLinkRevision: 1 }
  await settle()
  assert.match(ui.text(), /标签或曲库已变化，请重新读取核对/)
  assert.doesNotMatch(ui.text(), /此条目还没有标签/)
  ui.button('重新读取标签').props.onClick()
  await settle()
  assert.match(ui.text(), /此条目还没有标签/)
})

test('actual empty all-songs template exposes global tags without rows or providers and excludes previews', async (t) => {
  const f = fixture(),
    category = shallowRef('allSongs'),
    previewTracks = shallowRef<Track[] | undefined>(undefined)
  f.references.set('tag-1', [
    {
      id: 'missing-release',
      kind: 'release',
      title: '移出库的专辑',
      artist: '',
      inLibrary: false,
      sourceCount: 0
    }
  ])
  const source = readFileSync(new URL('../SongList.vue', import.meta.url), 'utf8')
  const template = parseSfc(source).descriptor.template!.content
  const visit = (node: any, parents: any[]): { node: any; parents: any[] } | null => {
    if (node.tag === 'MusicTagsPanel') return { node, parents }
    for (const child of node.children ?? []) {
      const result = visit(child, [...parents, node])
      if (result) return result
    }
    return null
  }
  const located = visit(parseTemplate(template), [])!
  assert.ok(located)
  assert.match(located.node.loc.source, /!previewTracks && category === 'allSongs'/)
  assert.doesNotMatch(located.node.loc.source, /entity-id|tableTrackCount|provider|database/)
  assert.equal(
    located.parents.some((parent) =>
      parent.props?.some(
        (prop: any) =>
          prop.type === 7 && /tableTrackCount|provider|database/.test(prop.exp?.content ?? '')
      )
    ),
    false
  )
  assert.match(
    source,
    /const MusicTagsPanel = defineAsyncComponent\(\(\) => import\('\.\/music-tags\/MusicTagsPanel\.vue'\)\)/
  )
  const render = new Function(
    'Vue',
    compile(located.node.loc.source, { mode: 'function', prefixIdentifiers: true }).code
  )(vue)
  const Host = {
    components: { MusicTagsPanel: f.Panel },
    setup: () => ({ category, previewTracks }),
    render
  }
  const ui = mount(t, () => h(Host))
  await settle()
  assert.match(ui.text(), /音乐库标签/)
  ui.button('管理标签').props.onClick()
  await settle()
  assert.equal(
    ui.nodes().some((item) => item.props['aria-label']?.startsWith('将当前条目加入 ')),
    false
  )
  assert.equal(
    f.queries.some((item) => item.name === 'tags.entity'),
    false
  )
  ui.nodes()
    .find(
      (item) =>
        item.tag === 'button' &&
        item.children.some((child) => child.tag === 'strong' && child.text === '标签 1')
    )!
    .props.onClick()
  await settle()
  assert.match(ui.text(), /移出库的专辑/)
  assert.match(ui.text(), /已不在库中/)
  assert.equal(ui.button('播放标签集合').props.disabled, true)
  byAria(ui, '从此标签移出 移出库的专辑').props.onClick()
  await settle()
  assert.equal(f.writes[0].query.entityId, 'missing-release')
  previewTracks.value = []
  await settle()
  assert.doesNotMatch(ui.text(), /音乐库标签/)
  previewTracks.value = undefined
  category.value = 'recent'
  await settle()
  assert.doesNotMatch(ui.text(), /音乐库标签/)
})

test('compiled global mode can create, rename, confirm delete and play without an entity query', async (t) => {
  const f = fixture()
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
  const ui = mount(t, () => h(f.Panel, { label: '音乐库', scope: 'library-tags' }))
  await settle()
  ui.button('管理标签').props.onClick()
  await settle()
  input(ui, '新标签名称', '离线标签')
  await settle()
  submit(ui, '创建标签')
  await settle()
  byAria(ui, '重命名 标签 1').props.onClick()
  await settle()
  input(ui, '标签新名称', '重命名标签')
  await settle()
  submit(ui, '保存名称')
  await settle()
  ui.nodes()
    .find(
      (item) =>
        item.tag === 'button' &&
        item.children.some((child) => child.tag === 'strong' && child.text === '重命名标签')
    )!
    .props.onClick()
  await settle()
  ui.button('播放标签集合').props.onClick()
  await settle()
  assert.match(ui.text(), /已播放标签集合：1 首/)
  byAria(ui, '删除标签 重命名标签').props.onClick()
  await settle()
  assert.equal(f.writes.length, 3)
  ui.button('确认删除标签').props.onClick()
  await settle()
  assert.deepEqual(
    f.writes.map((item) => item.name),
    ['tags.create', 'tags.rename', 'tags.play', 'tags.delete']
  )
  assert.equal(
    f.queries.some((item) => item.name === 'tags.entity'),
    false
  )
})
