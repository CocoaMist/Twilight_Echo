import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { transformSync } from 'esbuild'
import { computed, effectScope, nextTick, ref, watch } from 'vue'
import { createLyricContentCache } from './lyricContentCache.ts'
import { projectDesktopLyricsLines } from './desktopLyricsProjection.ts'
import {
  projectManagedLyrics,
  projectLyricDisplay,
  DEFAULT_LYRICS_MANAGEMENT
} from '../../../shared/lyricsManagement.ts'
import { DESKTOP_LYRICS_CLOCK_INTERVAL_MS } from '../../../shared/desktopLyrics.ts'

function extract(source: string, start: string, end: string): string {
  const from = source.indexOf(start),
    to = source.indexOf(end, from)
  assert.ok(from >= 0 && to > from, `Missing component excerpt: ${start}`)
  return source.slice(from, to)
}
const transpile = (source: string): string =>
  transformSync(source, { loader: 'ts', format: 'cjs' }).code

test('actual lyric computed/watch and publisher ignore metadata and unrelated document updates', async () => {
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
  const publisher = readFileSync(
    new URL('../app/useDesktopLyricsPublisher.ts', import.meta.url),
    'utf8'
  )
  const publisherBody =
    publisher
      .slice(publisher.indexOf('function transportState'))
      .replace('export function', 'function') + '\nuseDesktopLyricsPublisher();'
  const sessions: Array<{ contentRevision: number; lines: unknown[] }> = []
  const settings = ref({ desktopLyrics: { enabled: true } })
  const player = {
    currentTrack: track,
    lyricsLoadState: ref({ trackId: 'one', status: 'ready' }),
    playbackClockSnapshot: ref({ epoch: 1, state: 'playing', position: 1, duration: 240, rate: 1 })
  }
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
      new Function(
        'computed',
        'ref',
        'watch',
        'onBeforeUnmount',
        'window',
        'usePlayerStore',
        'useLyricsManagement',
        'useSettingsStore',
        'projectManagedLyrics',
        'createLyricContentCache',
        'projectDesktopLyricsLines',
        'DESKTOP_LYRICS_CLOCK_INTERVAL_MS',
        transpile(publisherBody)
      )(
        computed,
        ref,
        watch,
        () => {},
        {
          api: {
            desktopLyrics: {
              publishSession: (session: (typeof sessions)[number]) => sessions.push(session),
              publishClock() {},
              onEnabledChanged: () => () => {},
              onResyncRequested: () => () => {}
            }
          }
        },
        () => player,
        () => management,
        () => ({ settings }),
        projectManagedLyrics,
        cachedFactory,
        projectDesktopLyricsLines,
        DESKTOP_LYRICS_CLOCK_INTERVAL_MS
      )
    })
    assert.equal(parses, 2)
    assert.equal(sessions.length, 1)
    for (let i = 0; i < 20; i++) {
      track.value = { ...track.value, bpm: i }
      await nextTick()
    }
    document.value = { ...document.value, tracks: {} }
    await nextTick()
    assert.equal(parses, 2)
    assert.equal(sessions.length, 1)
    assert.equal(recenters, 0)
    track.value = { ...track.value, lyrics: '[00:01]Changed' }
    await nextTick()
    assert.equal(parses, 4)
    assert.equal(sessions.length, 2)
    assert.equal(recenters, 1)
    assert.equal(sessions[1].contentRevision, sessions[0].contentRevision + 1)
    const parsedLines = sessions[1].lines
    track.value = { ...track.value, title: 'Renamed' }
    await nextTick()
    assert.equal(parses, 4)
    assert.equal(sessions.length, 3)
    assert.equal(sessions[2].lines, parsedLines)
    settings.value.desktopLyrics.enabled = false
    await nextTick()
    track.value = { ...track.value, lyrics: '[00:01]While disabled' }
    await nextTick()
    assert.equal(parses, 5, 'only the page parses while desktop publishing is disabled')
    assert.equal(sessions.length, 3)
    settings.value.desktopLyrics.enabled = true
    await nextTick()
    assert.equal(parses, 6)
    assert.equal(sessions.length, 4)
  } finally {
    scope.stop()
  }
})
