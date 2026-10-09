import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { ref, shallowRef } from 'vue'
import { usePlaylistTrackPaging } from './usePlaylistTrackPaging.ts'
import type { Track } from '../../types/music'

const source = readFileSync(new URL('../StreamingPage.vue', import.meta.url), 'utf8')
const openSource = source.slice(
  source.indexOf('async function openPlaylist('),
  source.indexOf('async function openTrackAlbum(')
)
const scrollSource = source.slice(
  source.indexOf('function onStreamingContentScroll('),
  source.indexOf('\nwatch(', source.indexOf('function onStreamingContentScroll('))
)

function setup(paged = true) {
  const detailTracks = shallowRef<Track[]>([])
  const playlistTrackPaging = usePlaylistTrackPaging(detailTracks, (error) => String(error))
  const detailLoading = ref(false)
  const detailError = ref('')
  const currentDetail = ref<{ type: string } | null>(null)
  const offsets: number[] = []
  let fullCalls = 0
  let token = 0
  const methods = runInNewContext(
    `${stripTypeScriptTypes(openSource + scrollSource)}\n({ openPlaylist, loadMoreDetailTracks, onStreamingContentScroll })`,
    {
      detailTracks,
      playlistTrackPaging,
      detailLoading,
      detailError,
      currentDetail,
      activeProvider: ref('bili'),
      isExternalActive: ref(true),
      beginDetailTransition() {},
      pushDetail: (detail: { type: string }) => {
        currentDetail.value = detail
      },
      beginDetailLoad: () => {
        playlistTrackPaging.reset()
        detailLoading.value = true
        return ++token
      },
      isActiveDetailLoad: (value: number) => value === token,
      providerStore: {
        getProvider: () => ({
          supportedMethods: paged ? ['fetchPlaylistTracksPage'] : ['fetchPlaylistTracks']
        }),
        fetchPlaylistTracksPage: async (
          id: string,
          folder: string,
          offset: number,
          limit: number
        ) => {
          assert.equal(id, 'bili')
          assert.equal(folder, 'large')
          assert.equal(limit, 20)
          offsets.push(offset)
          return {
            tracks: [{ id: `track-${offset}` }],
            total: null,
            nextOffset: offset + 20,
            hasMore: true
          }
        },
        fetchPlaylistTracks: async () => {
          fullCalls++
          return [{ id: 'legacy' }]
        }
      },
      friendlyStreamingError: (error: unknown) => String(error),
      loadMoreLikedTracks: async () => {
        throw new Error('unexpected liked request')
      }
    }
  ) as {
    openPlaylist: (playlist: { id: string }) => Promise<void>
    loadMoreDetailTracks: () => Promise<void>
    onStreamingContentScroll: (event: { currentTarget: unknown }) => void
  }
  return {
    methods,
    offsets,
    detailTracks,
    playlistTrackPaging,
    detailLoading,
    fullCalls: () => fullCalls
  }
}

test('the actual playlist handler selects paging only when advertised and does not call full loading', async () => {
  const { methods, offsets, fullCalls, detailLoading } = setup()
  await methods.openPlaylist({ id: 'large' })
  assert.deepEqual(offsets, [0])
  assert.equal(fullCalls(), 0)
  assert.equal(detailLoading.value, false)
  await methods.loadMoreDetailTracks()
  assert.deepEqual(offsets, [0, 20])
})

test('the actual scroll handler loads near the bottom, stops automatic retries after an error', async () => {
  const { methods, offsets, playlistTrackPaging } = setup()
  await methods.openPlaylist({ id: 'large' })
  methods.onStreamingContentScroll({
    currentTarget: { scrollHeight: 2000, clientHeight: 500, scrollTop: 100 }
  })
  assert.deepEqual(offsets, [0])
  methods.onStreamingContentScroll({
    currentTarget: { scrollHeight: 2000, clientHeight: 500, scrollTop: 1400 }
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(offsets, [0, 20])
  playlistTrackPaging.error.value = 'rate limited'
  methods.onStreamingContentScroll({
    currentTarget: { scrollHeight: 2000, clientHeight: 500, scrollTop: 1400 }
  })
  assert.deepEqual(offsets, [0, 20])
})

test('providers with the original API keep their full-loading behavior', async () => {
  const { methods, offsets, fullCalls, detailTracks } = setup(false)
  await methods.openPlaylist({ id: 'large' })
  assert.deepEqual(offsets, [])
  assert.equal(fullCalls(), 1)
  assert.equal(detailTracks.value[0].id, 'legacy')
})
