import assert from 'node:assert/strict'
import test from 'node:test'
import { computed, ref } from 'vue'
import { createLyricContentCache } from './lyricContentCache.ts'

test('metadata refresh preserves parsed rows, changed lyric layers invalidate them', () => {
  const parse = createLyricContentCache()
  const track = ref({
    id: 'one',
    lyrics: '[00:01.00]One',
    translation: null as string | null,
    bpm: 120
  })
  const lines = computed(() => parse(track.value.lyrics, track.value.translation))
  const original = lines.value
  for (let i = 0; i < 20; i++) {
    track.value = { ...track.value, bpm: i }
    assert.equal(lines.value, original)
  }
  track.value.translation = '[00:01.00]一'
  assert.notEqual(lines.value, original)
  assert.equal(lines.value[0].translation, '一')
  const translated = lines.value
  assert.equal(parse(track.value.lyrics, track.value.translation), translated)
  assert.notEqual(
    parse(track.value.lyrics, track.value.translation, null, { replaceTtmlRomanization: true }),
    translated
  )
})

test('cache retains only its latest content and isolates consumers', () => {
  const parse = createLyricContentCache(),
    other = createLyricContentCache()
  const first = parse('[00:01]One', null)
  assert.notEqual(other('[00:01]One', null), first)
  parse('[00:02]Two', null)
  assert.notEqual(parse('[00:01]One', null), first)
})
