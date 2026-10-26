import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { transformSync } from 'esbuild'
import { computed, effectScope, nextTick, ref, watch } from 'vue'
import { createLyricContentCache } from './lyricContentCache.ts'
import {
  projectManagedLyrics,
  projectLyricDisplay,
  DEFAULT_LYRICS_MANAGEMENT
} from '../../../shared/lyricsManagement.ts'

function extract(source: string, start: string, end: string): string {
  const from = source.indexOf(start),
    to = source.indexOf(end, from)
  assert.ok(from >= 0 && to > from, `Missing component excerpt: ${start}`)
  return source.slice(from, to)
}
const transpile = (source: string): string =>
  transformSync(source, { loader: 'ts', format: 'cjs' }).code

test('actual lyric computed/watch ignores metadata and unrelated document updates', async () => {
  const scope = effectScope()
  const track = ref({
    id: 'one',
    title: 'One',
    artist: 'Artist',
    lyrics: '[00:01]One',
    translatedLyrics: null,
    bpm: 120
  })
  const document = ref({ ...DEFAULT_LYRICS_MANAGEMENT, tracks: {} })
  const management = { document, entryFor: () => undefined, effectiveOffsetSeconds: () => 0 }
  let parses = 0,
    recenters = 0
  const cachedFactory = () => {
    const parse = createLyricContentCache()
    let previous: unknown
    return (...args: Parameters<typeof parse>) => {
      const next = parse(...args)
      if (next !== previous) {
        parses++
        previous = next
      }
      return next
    }
  }
  const playing = readFileSync(
    new URL('../components/PlayingMusic.vue', import.meta.url),
    'utf8'
  ).replaceAll('\r\n', '\n')
  const fragment =
    extract(playing, 'const lyricVisibility =', 'const isTtmlLyrics =') +
    extract(playing, 'function usesManualManagedLayer(', 'const currentLyricOffsetSeconds =') +
    extract(
      playing,
      'watch(\n  () => [currentTrack.value?.id, displayLyricLines.value]',
      'function lyricTime('
    ) +
    '\nreturn displayLyricLines;'
  try {
    scope.run(() => {
      void new Function(
        'computed',
        'watch',
        'currentTrack',
        'lyricsManagement',
        'projectManagedLyrics',
        'createLyricContentCache',
        'projectLyricDisplay',
        'lyricViewport',
        'lyricsViewActive',
        transpile(fragment)
      )(
        computed,
        watch,
        track,
        management,
        projectManagedLyrics,
        cachedFactory,
        projectLyricDisplay,
        {
          activate() {},
          async recenter() {
            recenters++
          }
        },
        ref(true)
      ).value
    })
    assert.equal(parses, 1)
    for (let i = 0; i < 20; i++) {
      track.value = { ...track.value, bpm: i }
      await nextTick()
    }
    document.value = { ...document.value, tracks: {} }
    await nextTick()
    assert.equal(parses, 1)
    assert.equal(recenters, 0)
    track.value = { ...track.value, lyrics: '[00:01]Changed' }
    await nextTick()
    assert.equal(parses, 2)
    assert.equal(recenters, 1)
    track.value = { ...track.value, title: 'Renamed' }
    await nextTick()
    assert.equal(parses, 2)
  } finally {
    scope.stop()
  }
})
