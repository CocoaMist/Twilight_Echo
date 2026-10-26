import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appearancePartPanel,
  appearanceSettingsTarget,
  APPEARANCE_STUDIO_PARTS
} from './appearanceSettingsTargets.ts'
import { APPEARANCE_PARTS } from './appearanceParts.ts'
import { SETTINGS_SEARCH_INDEX } from './settings-page/types.ts'

test('existing settings resolve to visible part properties rather than hidden legacy sections', () => {
  for (const [id, part, panel] of [
    ['font-rendering', 'global-font', 'global-font'],
    ['player-page-mode', 'player-bar', 'player-bar'],
    ['player-bar-layout', 'player-bar', 'player-bar'],
    ['mini-player', 'player-bar', 'player-bar'],
    ['window-card-blur', 'outer-panel', 'outer-panel'],
    ['ui-density', 'overview', 'general'],
    ['motion', 'overview', 'general'],
    ['accent-dark', 'appearance-theme', 'appearance-theme'],
    ['appearance-editor-105', 'controls', 'appearance-surfaces'],
    ['appearance-editor-87', 'card', 'card'],
    ['appearance-editor-85', 'card', 'card']
  ]) {
    const entry = SETTINGS_SEARCH_INDEX.find((entry) => entry.id === id)
    assert.ok(entry, id)
    const destination = appearanceSettingsTarget(entry)
    assert.deepEqual({ part: destination.part, panel: destination.panel }, { part, panel }, id)
  }
  assert.equal(appearancePartPanel('background'), undefined)
  assert.equal(appearancePartPanel('outer-panel'), 'outer-panel')
  assert.equal(appearancePartPanel('player-page'), 'player-page')
  const playerPart = APPEARANCE_PARTS.find((part) => part.id === 'player-page')
  assert.equal(playerPart?.label, '播放页')
  assert.deepEqual(playerPart?.preview, {
    selector: '.appearance-preview-player-stage',
    label: '调整播放页背景',
    focus: 'scene'
  })
  assert.equal(APPEARANCE_STUDIO_PARTS.library, 'card')
  assert.equal(APPEARANCE_STUDIO_PARTS.typography, 'global-font')
})

test('nested and conditional properties resolve to their disclosure chain and enabled fallback', () => {
  const target = (id: string) =>
    appearanceSettingsTarget(SETTINGS_SEARCH_INDEX.find((entry) => entry.id === id)!)
  assert.deepEqual(target('mini-taskbar').disclosures, ['workspace-mini-player', 'mini-player'])
  assert.deepEqual(target('player-page-mode').disclosures, [
    'player-bar',
    'player-bar-behavior-details'
  ])
  assert.deepEqual(target('appearance-editor-107').disclosures, [
    'workspace-liquid-glass',
    'liquid-glass'
  ])
  assert.equal(target('appearance-editor-107').settingId, 'glass-pointer')
  assert.equal(target('appearance-editor-107').fallbackId, 'glass-enabled')
  assert.equal(target('appearance-editor-87').settingId, 'card-saturation')
})

test('player page preview resolves playing track first, then liked songs, then static fallback', async () => {
  const { readFile } = await import('node:fs/promises')
  const { stripTypeScriptTypes } = await import('node:module')
  const { runInNewContext } = await import('node:vm')
  const { computed, ref, watch, nextTick } = await import('vue')
  const source = await readFile(new URL('./AppearancePreviewScene.vue', import.meta.url), 'utf8')
  const start = source.indexOf('const defaultPreviewCover =')
  const end = source.indexOf('const homePreview =')
  assert.ok(start > 0 && end > start)
  const snippet = stripTypeScriptTypes(source.slice(start, end))

  const currentTrack = ref<Record<string, unknown> | null>(null)
  const themeCoverUrl = ref<string | null>(null)
  const localPlaylists = ref<Record<string, unknown>[]>([])
  const isLoggedIn = ref(false)
  const likedPlaylist = ref<Record<string, unknown> | null>(null)
  let playlistMembers: Record<string, unknown>[] = []
  let ncmLikedTracks: Record<string, unknown>[] = []

  const ctx = runInNewContext(
    `${snippet}\n;({ previewCover, playerPreviewTrack, defaultPreviewCover, syncPreviewCoverAndTrack })`,
    {
      window: {},
      encodeURIComponent,
      workshopPreviewTracks: [
        {
          id: 'sample-1',
          title: '夜空中的旋律',
          artist: '示例歌手',
          album: '星海回响',
          cover: ''
        }
      ],
      ref,
      computed,
      watch,
      resolveCover: async (cover: string | null) => (cover ? `resolved:${cover}` : null),
      usePlayerStore: () => ({ currentTrack, themeCoverUrl }),
      useMusicStore: () => ({
        localPlaylists,
        tracks: ref([]),
        getPlaylistMembers: async () => ({ items: playlistMembers }),
        queryTracks: async () => ({ items: [] })
      }),
      useNcmStore: () => ({
        isLoggedIn,
        likedPlaylist,
        profile: ref({ nickname: '测试用户' }),
        fetchUserLibrary: async () => {},
        fetchLikedTracksPage: async () => ({ tracks: ncmLikedTracks })
      })
    }
  )

  await ctx.syncPreviewCoverAndTrack()
  assert.equal(ctx.previewCover.value, ctx.defaultPreviewCover)
  assert.equal(ctx.playerPreviewTrack.value.title, '夜空中的旋律')

  // Tier 2b: Streaming user's liked songs when nothing is playing
  isLoggedIn.value = true
  ncmLikedTracks = [
    { id: 'ncm-liked-1', title: '心动流媒体', artist: '流媒体歌手', album: '喜欢精选', cover: 'ncm-cover.jpg' }
  ]
  await nextTick()
  await ctx.syncPreviewCoverAndTrack()
  assert.equal(ctx.previewCover.value, 'resolved:ncm-cover.jpg')
  assert.equal(ctx.playerPreviewTrack.value.title, '心动流媒体')

  // Tier 2a: Local library "我喜欢" playlist takes priority over streaming fallback when no song is playing
  playlistMembers = [
    { id: 'local-fav-1', title: '本地最爱', artist: '本地歌手', album: '本地收藏', cover: 'local-fav.jpg' }
  ]
  localPlaylists.value = [{ id: 'fav-id', name: '我喜欢', isDefault: true }]
  await nextTick()
  await ctx.syncPreviewCoverAndTrack()
  assert.equal(ctx.previewCover.value, 'resolved:local-fav.jpg')
  assert.equal(ctx.playerPreviewTrack.value.title, '本地最爱')

  // Tier 1: Currently playing song takes highest priority
  currentTrack.value = {
    id: 'playing-1',
    title: '正在播放的歌',
    artist: '当前歌手',
    album: '当前专辑',
    cover: 'playing.jpg'
  }
  themeCoverUrl.value = 'blob:playing-cover'
  await nextTick()
  await ctx.syncPreviewCoverAndTrack()
  assert.equal(ctx.previewCover.value, 'blob:playing-cover')
  assert.equal(ctx.playerPreviewTrack.value.title, '正在播放的歌')
})
