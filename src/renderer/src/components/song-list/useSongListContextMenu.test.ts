import assert from 'node:assert/strict'
import test from 'node:test'
import { computed, effectScope } from 'vue'
import type { Track } from '../../types/music'
import { disposeCoreConnection, useCoreConnection } from '../../stores/coreConnection.ts'

const { useSongListContextMenu } = (await import(
  new URL('./useSongListContextMenu.ts', import.meta.url).href
)) as typeof import('./useSongListContextMenu')

const providerTrack = {
  id: 'ncm:expired',
  title: 'Online Song',
  artist: 'Remote Artist',
  album: 'Remote Album',
  filePath: 'ncm:expired',
  fileName: 'Online Song',
  duration: 180,
  size: 0,
  cover: null,
  lyrics: null,
  source: 'ncm'
}

const localTrack = {
  ...providerTrack,
  id: 'local:hash',
  filePath: 'D:\\Music\\Online Song.flac',
  source: 'local'
}

function createMenu(
  overrides: {
    rematchTrack?: (track: Track) => Promise<void> | void
    rematchMetadata?: (track: Track) => Promise<void> | void
    clearMetadataMatch?: (track: Track) => Promise<void> | void
    playNext?: (track: Track) => void
    viewArtist?: (track: Track) => void
    viewAlbum?: (track: Track) => void
  } = {}
): ReturnType<typeof useSongListContextMenu> {
  ;(globalThis as Record<string, unknown>).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    innerWidth: 1200,
    innerHeight: 800,
    api: {
      shell: {
        showItemInFolder: async (): Promise<void> => {}
      }
    }
  }
  ;(globalThis as Record<string, unknown>).document = {
    querySelector: () => null
  }
  const scope = effectScope()
  const menu = scope.run(() =>
    useSongListContextMenu({
      currentPlaylistName: computed(() => null),
      removeTrack: () => {},
      addToPlaylist: () => {},
      removeFromPlaylist: () => {},
      createPlaylist: () => 'playlist-id',
      deletePlaylist: () => {},
      rematchTrack: overrides.rematchTrack,
      rematchMetadata: overrides.rematchMetadata,
      clearMetadataMatch: overrides.clearMetadataMatch,
      playNext: overrides.playNext,
      viewArtist: overrides.viewArtist,
      viewAlbum: overrides.viewAlbum
    })
  )
  if (!menu) throw new Error('context menu setup failed')
  return menu
}

test('context menu exposes rematch action for provider tracks', async () => {
  let rematchedTrackId = ''
  const menu = createMenu({
    rematchTrack: (track) => {
      rematchedTrackId = track.id
    }
  })
  menu.selectedTrack.value = providerTrack

  assert.equal(menu.canRematchSelectedTrack.value, true)

  await menu.handleRematchTrack()

  assert.equal(rematchedTrackId, 'ncm:expired')
  assert.equal(menu.showContextMenu.value, false)
})

test('context menu exposes play next action for any track', () => {
  let playedTrackId = ''
  const menu = createMenu({
    playNext: (track) => {
      playedTrackId = track.id
    }
  })

  menu.selectedTrack.value = providerTrack
  assert.equal(menu.canPlayNextSelectedTrack.value, true)

  menu.handlePlayNext()

  assert.equal(playedTrackId, 'ncm:expired')
  assert.equal(menu.showContextMenu.value, false)
  assert.equal(menu.selectedTrack.value, null)
})

test('context menu exposes view artist action when artist is present', () => {
  let viewedArtistTrackId = ''
  const menu = createMenu({
    viewArtist: (track) => {
      viewedArtistTrackId = track.id
    }
  })

  menu.selectedTrack.value = localTrack
  assert.equal(menu.canViewSelectedContext.value, true)

  menu.handleViewArtist()

  assert.equal(viewedArtistTrackId, 'local:hash')
  assert.equal(menu.showContextMenu.value, false)
  assert.equal(menu.selectedTrack.value, null)
})

test('context menu exposes view album action when album is present', () => {
  let viewedAlbumTrackId = ''
  const menu = createMenu({
    viewAlbum: (track) => {
      viewedAlbumTrackId = track.id
    }
  })

  menu.selectedTrack.value = localTrack
  assert.equal(menu.canViewSelectedContext.value, true)

  menu.handleViewAlbum()

  assert.equal(viewedAlbumTrackId, 'local:hash')
  assert.equal(menu.showContextMenu.value, false)
  assert.equal(menu.selectedTrack.value, null)
})

test('context menu does not expose rematch action for local tracks', () => {
  const menu = createMenu()
  menu.selectedTrack.value = localTrack

  assert.equal(menu.canRematchSelectedTrack.value, false)
})

test('context menu exposes metadata rematch action for local tracks', async () => {
  let rematchedTrackId = ''
  const menu = createMenu({
    rematchMetadata: (track) => {
      rematchedTrackId = track.id
    }
  })
  menu.selectedTrack.value = localTrack

  assert.equal(menu.canRematchMetadataSelectedTrack.value, true)

  await menu.handleRematchMetadata()

  assert.equal(rematchedTrackId, 'local:hash')
  assert.equal(menu.showContextMenu.value, false)

  menu.selectedTrack.value = providerTrack
  assert.equal(menu.canRematchMetadataSelectedTrack.value, false)
})

test('context menu exposes clear metadata match action only for matched local tracks', async () => {
  let clearedTrackId = ''
  const matchedLocalTrack = {
    ...localTrack,
    metadataMatch: {
      providerId: 'ncm',
      trackId: 'ncm:expired',
      confidence: 'high' as const,
      score: 94
    }
  }
  const menu = createMenu({
    clearMetadataMatch: (track) => {
      clearedTrackId = track.id
    }
  })

  menu.selectedTrack.value = matchedLocalTrack
  assert.equal(menu.canClearMetadataMatchSelectedTrack.value, true)

  await menu.handleClearMetadataMatch()

  assert.equal(clearedTrackId, 'local:hash')
  assert.equal(menu.showContextMenu.value, false)

  menu.selectedTrack.value = localTrack
  assert.equal(menu.canClearMetadataMatchSelectedTrack.value, false)

  menu.selectedTrack.value = {
    ...providerTrack,
    metadataMatch: matchedLocalTrack.metadataMatch
  }
  assert.equal(menu.canClearMetadataMatchSelectedTrack.value, false)
})

test('folder reveal submits the local identity to Core without needing a renderer media path', async () => {
  const menu = createMenu()
  const requests: Array<{ name: string; payload: unknown }> = []
  const windowFixture = globalThis.window
  Object.assign(windowFixture.api, {
    core: {
      onMessage: () => () => {},
      onStatus: () => () => {},
      connect: async () => ({ ok: true, value: { connectionId: 'menu', snapshot: {
        protocolVersion: 1, epoch: 'menu-epoch', sequence: 0, phase: 'ready'
      } } }),
      disconnect: async () => ({ ok: true, value: undefined }),
      cancel: async () => ({ ok: true, value: undefined }),
      request: async (_id: string, request: { name: string; payload: unknown }) => {
        requests.push(request)
        return { ok: true, value: undefined }
      }
    }
  })
  await useCoreConnection().attach()
  try {
    const { filePath: _path, ...display } = localTrack
    menu.selectedTrack.value = display
    await menu.handleOpenFolder()
    assert.equal(requests.length, 1)
    assert.equal(requests[0].name, 'library.reveal')
    assert.deepEqual(requests[0].payload, { id: 'local:hash' })
    assert.equal(menu.selectedTrack.value, null)
  } finally { disposeCoreConnection() }
})
