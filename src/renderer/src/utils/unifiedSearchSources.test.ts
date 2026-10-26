import assert from 'node:assert/strict'
import test from 'node:test'
import { createLogicalTrackModel } from '../../../shared/logicalTrackModel.ts'
import { createUnifiedSearchSources } from '../../../shared/musicSearchSources.ts'
import type { TrackData as Track } from '../../../shared/track.ts'

const { searchUnifiedLocalPage, searchUnifiedNetworkPage } = createUnifiedSearchSources(
  createLogicalTrackModel(() => undefined),
  () => 0
)

const track = (id: string, title = '月亮', format = 'flac'): Track => ({
  id,
  title,
  artist: '歌手',
  album: '专辑',
  filePath: `${id}.flac`,
  fileName: `${id}.flac`,
  duration: 180,
  size: 1,
  cover: null,
  lyrics: null,
  source: 'local',
  format
})

test('local unified search caches ordered entries and materializes only the requested page', () => {
  const tracks = Array.from({ length: 20_000 }, (_, index) => track(String(index).padStart(5, '0')))
  const first = searchUnifiedLocalPage(tracks, '月亮', 20, 0)
  const second = searchUnifiedLocalPage(tracks, '月亮', 20, 20)
  assert.equal(first.total, 20_000)
  assert.equal(first.items.length, 20)
  assert.equal(second.items[0].track.id, '00020')
  assert.equal(searchUnifiedLocalPage(tracks, 'yl', 1, 0).items[0], first.items[0])
  assert.equal(searchUnifiedLocalPage(tracks, '19999', 1, 0).items[0].track.id, '19999')
  const updated = [track('new', '新歌曲'), ...tracks.slice(1)]
  assert.equal(searchUnifiedLocalPage(updated, '新歌曲', 20, 0).items[0].track.id, 'new')
  assert.equal(searchUnifiedLocalPage(updated, '月亮', 20, 0).total, 19_999)
})

test('pagination retains lossless priority across page boundaries and never mutates the library', () => {
  const tracks = [track('mp3', '歌曲', 'mp3'), track('lossless', '歌曲')]
  assert.equal(searchUnifiedLocalPage(tracks, '歌曲', 1, 0).items[0].track.id, 'lossless')
  assert.equal(searchUnifiedLocalPage(tracks, '歌曲', 1, 1).items[0].track.id, 'mp3')
  assert.equal(tracks[0].id, 'mp3')
})

test('network pagination retains stable profile identities and total counts', () => {
  const entries = Array.from({ length: 45 }, (_, id) => ({
    profileName: 'NAS',
    entry: {
      id: `net:${id}`,
      profileId: 'nas',
      kind: 'audio' as const,
      name: `月亮-${id}.flac`,
      path: `/music/${id}.flac`
    }
  }))
  const page = searchUnifiedNetworkPage(entries, '月亮', 20, 20)
  assert.equal(page.total, 45)
  assert.equal(page.items.length, 20)
  assert.equal(page.items[0].track.networkSource?.entry.id, 'net:20')
  assert.equal(page.items[0].track.filePath, '')
})

test('local and network search support multi-token cross-field queries and SymSpell typo recovery', () => {
  const tracks: Track[] = [
    {
      ...track('beethoven', 'Moonlight Sonata'),
      artist: 'Ludwig van Beethoven',
      album: 'Classical Masterpieces'
    },
    {
      ...track('audrey', 'Moon River'),
      artist: 'Audrey Hepburn',
      album: 'Breakfast at Tiffanys'
    }
  ]

  // Multi-token cross-field (Artist + Title)
  const multi = searchUnifiedLocalPage(tracks, 'audrey moon', 10, 0)
  assert.equal(multi.total, 1)
  assert.equal(multi.items[0].track.id, 'audrey')

  // SymSpell typo recovery (distance <= 2)
  const typo = searchUnifiedLocalPage(tracks, 'beethovn', 10, 0)
  assert.equal(typo.total, 1)
  assert.equal(typo.items[0].track.id, 'beethoven')

  // Network SymSpell typo recovery
  const netTypo = searchUnifiedNetworkPage(
    [
      {
        profileName: 'NAS',
        entry: {
          id: 'net:beethoven',
          profileId: 'nas',
          kind: 'audio',
          name: 'Sonata.flac',
          path: '/music/Sonata.flac',
          metadata: { title: 'Moonlight Sonata', artist: 'Beethoven' }
        }
      }
    ],
    'beethovn',
    10,
    0
  )
  assert.equal(netTypo.total, 1)
  assert.equal(netTypo.items[0].track.id, 'net:beethoven')
})
