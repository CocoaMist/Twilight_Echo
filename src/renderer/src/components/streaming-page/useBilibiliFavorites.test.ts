import assert from 'node:assert/strict'
import test from 'node:test'
import { effectScope, nextTick, ref } from 'vue'
import type { Track } from '../../types/music.ts'
import { useFavoriteButton } from '../player-bar/useFavoriteButton.ts'
import { useBilibiliFavorites } from './useBilibiliFavorites.ts'
import {
  notifyProviderFavoriteChange,
  providerFavoriteChange
} from '../../providers/providerFavoriteChanges.ts'

const track = (bvid = 'BV1', cid = 1): Track => ({
  id: `bili:${bvid}:${cid}`,
  source: 'bili',
  title: `Video ${bvid} P${cid}`,
  artist: 'Creator',
  album: 'Favorites',
  duration: 60,
  filePath: `bili:${bvid}:${cid}`,
  fileName: '',
  size: 0,
  cover: null,
  lyrics: null
})

function fixture(
  t: test.TestContext,
  write: (id: string | number, liked: boolean) => Promise<void>
) {
  const scope = effectScope()
  t.after(() => scope.stop())
  const account = ref('account-1')
  const currentTrack = ref<Track | null>(track('BV1', 2))
  const providers = {
    get: () => ({ id: 'bili', name: 'Bilibili', likeTrack: write, isTrackLiked: async () => true })
  } as never
  return scope.run(() => ({
    account,
    currentTrack,
    rows: useBilibiliFavorites(providers, () => account.value),
    player: useFavoriteButton({
      currentTrack,
      playlists: ref([]),
      mediaProviders: providers,
      addToPlaylist() {},
      removeFromPlaylist() {},
      createPlaylist() {}
    })
  }))!
}

test('Bilibili favorites default to red hearts and row clicks synchronize every part with the player', async (t) => {
  const calls: Array<[string | number, boolean]> = []
  let finish!: () => void
  const f = fixture(t, async (id, liked) => {
    calls.push([id, liked])
    await new Promise<void>((resolve) => {
      finish = resolve
    })
  })
  await nextTick()
  assert.equal(f.rows.isLiked(track()), true)
  assert.equal(f.player.favoriteButtonLiked.value, true)
  assert.equal(f.player.favoriteButtonTitle.value, '在Bilibili取消收藏')
  const write = f.rows.toggle(track())
  assert.equal(f.rows.isLoading(track('BV1', 2)), true)
  assert.equal(f.rows.isLiked(track()), true)
  await f.rows.toggle(track('BV1', 2))
  finish()
  await write
  assert.deepEqual(calls, [['BV1:1', false]])
  assert.equal(f.rows.isLoading(track()), false)
  assert.equal(f.rows.isLiked(track('BV1', 2)), false)
  assert.equal(f.player.favoriteButtonLiked.value, false)
  assert.equal(f.player.favoriteButtonTitle.value, '在Bilibili收藏')
  assert.equal(f.rows.isLiked(track('BV2')), true)
})

test('player clicks synchronize the list and permit collecting the video again', async (t) => {
  const calls: boolean[] = []
  const f = fixture(t, async (_id, liked) => {
    calls.push(liked)
  })
  await nextTick()
  await f.player.toggleFavorite()
  assert.equal(f.rows.isLiked(track()), false)
  await f.rows.toggle(track())
  assert.equal(f.rows.isLiked(track('BV1', 2)), true)
  assert.equal(f.player.favoriteButtonLiked.value, true)
  assert.deepEqual(calls, [false, true])
})

test('failed row writes preserve red hearts and account changes discard earlier states and completions', async (t) => {
  let reject = true
  let finish!: () => void
  const f = fixture(t, async () => {
    if (reject) throw new Error('收藏失败')
    await new Promise<void>((resolve) => {
      finish = resolve
    })
  })
  const previousChange = providerFavoriteChange.value
  await assert.rejects(f.rows.toggle(track()), /收藏失败/)
  assert.equal(f.rows.isLiked(track()), true)
  assert.equal(f.rows.isLoading(track()), false)
  assert.equal(providerFavoriteChange.value, previousChange)
  notifyProviderFavoriteChange('bili', 'BV1:1', false)
  assert.equal(f.rows.isLiked(track()), false)
  f.account.value = 'account-2'
  await nextTick()
  assert.equal(f.rows.isLiked(track()), true)
  reject = false
  const pending = f.rows.toggle(track())
  f.account.value = 'account-3'
  await nextTick()
  finish()
  await pending
  assert.equal(f.rows.isLiked(track()), true)
  assert.equal(f.rows.isLoading(track()), false)
})

test('a favorite completion cannot change the heart after switching to another video', async (t) => {
  let finish!: () => void
  const f = fixture(
    t,
    async () =>
      new Promise<void>((resolve) => {
        finish = resolve
      })
  )
  await nextTick()
  const pending = f.rows.toggle(track())
  f.currentTrack.value = track('BV2')
  await nextTick()
  finish()
  await pending
  assert.equal(f.player.favoriteButtonLiked.value, true)
  assert.equal(f.rows.isLiked(track()), false)
})

test('the Bilibili player waits for favorite state before accepting a toggle', async (t) => {
  const scope = effectScope()
  t.after(() => scope.stop())
  let finish!: (liked: boolean) => void
  const writes: boolean[] = []
  const button = scope.run(() =>
    useFavoriteButton({
      currentTrack: ref<Track | null>(track()),
      playlists: ref([]),
      mediaProviders: {
        get: () => ({
          id: 'bili',
          name: 'Bilibili',
          isTrackLiked: () =>
            new Promise<boolean>((resolve) => {
              finish = resolve
            }),
          likeTrack: async (_id: string, liked: boolean) => {
            writes.push(liked)
          }
        })
      } as never,
      addToPlaylist() {},
      removeFromPlaylist() {},
      createPlaylist() {}
    })
  )!
  assert.equal(button.favoriteButtonLoading.value, true)
  await button.toggleFavorite()
  assert.deepEqual(writes, [])
  finish(true)
  await nextTick()
  assert.equal(button.favoriteButtonLoading.value, false)
  assert.equal(button.favoriteButtonLiked.value, true)
  await button.toggleFavorite()
  assert.deepEqual(writes, [false])
})
