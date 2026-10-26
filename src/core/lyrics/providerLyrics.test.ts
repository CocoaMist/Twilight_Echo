import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveLyricsAcrossProviders } from './providerLyrics.ts'
import type { LyricProvider } from '../../shared/providerLyrics.ts'
import type { TrackData } from '../../shared/track.ts'

class LyricsProviders {
  private readonly providers: LyricProvider[] = []
  register(provider: LyricProvider & { source?: string; capabilities?: string[] }) { this.providers.push(provider) }
  resolveLyricsAcrossProviders(track: TrackData, options?: { timeoutMs?: number; signal?: AbortSignal }) {
    return resolveLyricsAcrossProviders(this.providers, track, Date.now, options)
  }
}
test('resolveLyricsAcrossProviders fans out to NCM for local tracks', async () => {
  const registry = new LyricsProviders()
  let ncmSearchCalls = 0
  let ncmLyricCalls = 0
  registry.register({
    id: 'ncm',
    name: 'NetEase',
    source: 'plugin',
    capabilities: ['search', 'lyrics'],
    searchSongs: async (keywords) => {
      ncmSearchCalls += 1
      assert.match(keywords, /Moon River/i)
      return {
        total: 1,
        items: [
          {
            id: 'ncm:99',
            title: 'Moon River',
            artist: 'Audrey',
            album: 'Online',
            filePath: 'ncm:99',
            fileName: 'Moon River',
            duration: 180,
            size: 0,
            cover: null,
            lyrics: null,
            source: 'ncm'
          }
        ]
      }
    },
    getLyrics: async (track) => {
      ncmLyricCalls += 1
      assert.equal(track.id, 'ncm:99')
      return {
        lyrics: '[00:01.00]Provider lyric',
        translatedLyrics: '[00:01.00]翻译',
        wordLyrics: null
      }
    }
  })

  const result = await registry.resolveLyricsAcrossProviders({
    id: 'local:abc',
    title: 'Moon River',
    artist: 'Audrey',
    album: 'Local',
    filePath: 'D:\\Music\\Moon River.flac',
    fileName: 'Moon River.flac',
    duration: 181,
    size: 1,
    cover: null,
    lyrics: null,
    source: 'local'
  })

  assert.equal(ncmSearchCalls, 1)
  assert.equal(ncmLyricCalls, 1)
  assert.equal(result.lyrics, '[00:01.00]Provider lyric')
  assert.equal(result.translatedLyrics, '[00:01.00]翻译')
})

test('resolveLyricsAcrossProviders reaches a later enabled provider when earlier searches miss', async () => {
  const registry = new LyricsProviders()
  const searched: string[] = []
  for (const id of ['one', 'two', 'three']) {
    registry.register({
      id,
      name: id,
      source: 'plugin',
      capabilities: ['search', 'lyrics'],
      searchSongs: async () => {
        searched.push(id)
        return { items: [], total: 0 }
      },
      getLyrics: async () => ({ lyrics: null, translatedLyrics: null })
    })
  }
  registry.register({
    id: 'four',
    name: 'four',
    source: 'plugin',
    capabilities: ['search', 'lyrics'],
    searchSongs: async () => {
      searched.push('four')
      return {
        total: 1,
        items: [
          {
            id: 'four:track',
            title: 'Later Provider Song',
            artist: 'Artist',
            album: 'Album',
            filePath: 'four:track',
            fileName: 'Later Provider Song',
            duration: 180,
            size: 0,
            cover: null,
            lyrics: null,
            source: 'four'
          }
        ]
      }
    },
    getLyrics: async () => ({
      lyrics: '[00:01.00]Fourth provider lyric',
      translatedLyrics: null
    })
  })

  const result = await registry.resolveLyricsAcrossProviders({
    id: 'local:later-provider-song',
    title: 'Later Provider Song',
    artist: 'Artist',
    album: 'Album',
    filePath: 'D:\\Music\\Later Provider Song.flac',
    fileName: 'Later Provider Song.flac',
    duration: 180,
    size: 1,
    cover: null,
    lyrics: null,
    source: 'local'
  })

  assert.deepEqual(searched, ['one', 'two', 'three', 'four'])
  assert.equal(result.lyrics, '[00:01.00]Fourth provider lyric')
})

test('resolveLyricsAcrossProviders settles when a switching track aborts a pending provider search', async () => {
  const registry = new LyricsProviders()
  let markSearchStarted: (() => void) | undefined
  const searchStarted = new Promise<void>((resolve) => {
    markSearchStarted = resolve
  })
  registry.register({
    id: 'stalled',
    name: 'stalled',
    source: 'plugin',
    capabilities: ['search', 'lyrics'],
    searchSongs: async () => {
      markSearchStarted?.()
      return await new Promise(() => {})
    },
    getLyrics: async () => ({ lyrics: null, translatedLyrics: null })
  })
  const controller = new AbortController()
  const pending = registry.resolveLyricsAcrossProviders(
    {
      id: 'local:stalled-search',
      title: 'Stalled Search',
      artist: 'Artist',
      album: 'Album',
      filePath: 'D:\\Music\\Stalled Search.flac',
      fileName: 'Stalled Search.flac',
      duration: 180,
      size: 1,
      cover: null,
      lyrics: null,
      source: 'local'
    },
    { timeoutMs: 1_000, signal: controller.signal }
  )

  await searchStarted
  controller.abort()
  const result = await Promise.race([
    pending,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Lyrics lookup did not settle after abort')), 100)
    )
  ])

  assert.deepEqual(result, { lyrics: null, translatedLyrics: null, wordLyrics: null })
})

test('resolveLyricsAcrossProviders preserves a direct provider failure when no fallback succeeds', async () => {
  const registry = new LyricsProviders()
  registry.register({
    id: 'ncm',
    name: 'NetEase',
    source: 'plugin',
    capabilities: ['lyrics'],
    getLyrics: async () => {
      throw new Error('lyrics gateway unavailable')
    }
  })

  await assert.rejects(
    registry.resolveLyricsAcrossProviders({
      id: 'ncm:unavailable',
      title: 'Unavailable lyric fixture',
      artist: 'Artist',
      album: 'Album',
      filePath: 'ncm:unavailable',
      fileName: 'Unavailable lyric fixture',
      duration: 180,
      size: 0,
      cover: null,
      lyrics: null,
      source: 'ncm'
    }),
    /lyrics gateway unavailable/
  )
})

test('resolveLyricsAcrossProviders preserves a matched fallback provider failure', async () => {
  const registry = new LyricsProviders()
  registry.register({
    id: 'ncm',
    name: 'NetEase',
    source: 'plugin',
    capabilities: ['search', 'lyrics'],
    searchSongs: async () => ({
      total: 1,
      items: [
        {
          id: 'ncm:unavailable',
          title: 'Unavailable lyric fixture',
          artist: 'Artist',
          album: 'Album',
          filePath: 'ncm:unavailable',
          fileName: 'Unavailable lyric fixture',
          duration: 180,
          size: 0,
          cover: null,
          lyrics: null,
          source: 'ncm'
        }
      ]
    }),
    getLyrics: async () => {
      throw new Error('matched lyrics gateway unavailable')
    }
  })

  await assert.rejects(
    registry.resolveLyricsAcrossProviders({
      id: 'local:unavailable',
      title: 'Unavailable lyric fixture',
      artist: 'Artist',
      album: 'Album',
      filePath: 'D:\\Music\\Unavailable lyric fixture.flac',
      fileName: 'Unavailable lyric fixture.flac',
      duration: 180,
      size: 1,
      cover: null,
      lyrics: null,
      source: 'local'
    }),
    /matched lyrics gateway unavailable/
  )
})

test('resolveLyricsAcrossProviders keeps a successful no-match lookup empty', async () => {
  const registry = new LyricsProviders()
  registry.register({
    id: 'ncm',
    name: 'NetEase',
    source: 'plugin',
    capabilities: ['search', 'lyrics'],
    searchSongs: async () => ({ items: [], total: 0 }),
    getLyrics: async () => ({ lyrics: null, translatedLyrics: null })
  })

  const result = await registry.resolveLyricsAcrossProviders({
    id: 'local:no-lyrics',
    title: 'No lyric match',
    artist: 'Artist',
    album: 'Album',
    filePath: 'D:\\Music\\No lyric match.flac',
    fileName: 'No lyric match.flac',
    duration: 180,
    size: 1,
    cover: null,
    lyrics: null,
    source: 'local'
  })

  assert.deepEqual(result, { lyrics: null, translatedLyrics: null, wordLyrics: null })
})

test('local lyric matching tolerates featured-artist title and artist formatting', async () => {
  const registry = new LyricsProviders()
  let matchedId = ''
  registry.register({
    id: 'ncm',
    name: 'NetEase',
    source: 'plugin',
    capabilities: ['search', 'lyrics'],
    searchSongs: async () => ({
      total: 1,
      items: [
        {
          id: 'ncm:hyperglyph',
          title: 'HyperGlyph-生命流',
          artist: 'TSAR',
          album: '明日方舟',
          filePath: 'ncm:hyperglyph',
          fileName: 'HyperGlyph-生命流',
          duration: 166,
          size: 0,
          cover: null,
          lyrics: null,
          source: 'ncm'
        }
      ]
    }),
    getLyrics: async (track) => {
      matchedId = track.id
      return { lyrics: '[00:01.00]Provider lyric', translatedLyrics: '[00:01.00]翻译' }
    }
  })

  const result = await registry.resolveLyricsAcrossProviders({
    id: 'local:hyperglyph',
    title: 'HyperGlyph-生命流 (feat. 兔子ST)',
    artist: 'TSAR/兔子ST',
    album: '明日方舟',
    filePath: 'D:\\Music\\HyperGlyph.flac',
    fileName: 'HyperGlyph.flac',
    duration: 166,
    size: 1,
    cover: null,
    lyrics: '[00:01.00]Local lyric',
    source: 'local'
  })

  assert.equal(matchedId, 'ncm:hyperglyph')
  assert.equal(result.translatedLyrics, '[00:01.00]翻译')
})
