import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clearListeningStatsHistory,
  compactListeningTrackDays,
  isListeningStatsClearRange,
  normalizeListeningTrackDays,
  previewListeningStatsClear,
  recordListeningTrackDay
} from './listeningStatsHistory.ts'
import type { ListeningStats, ListeningTrackStat } from './useListeningStatsStore.ts'

function legacyStat(): ListeningTrackStat {
  return {
    seconds: 100,
    plays: 2,
    skips: 1,
    completions: 1,
    lastPlayed: Date.parse('2026-09-01T12:00:00Z'),
    title: 'Moon River',
    artist: 'Audrey',
    cover: null
  }
}

test('clear range requires real UTC dates in chronological order', () => {
  assert.equal(isListeningStatsClearRange(null), true)
  assert.equal(isListeningStatsClearRange({ startDay: '2024-02-29', endDay: '2026-09-30' }), true)
  for (const range of [
    { startDay: '', endDay: '2026-09-30' },
    { startDay: '2026-02-29', endDay: '2026-03-01' },
    { startDay: '2026-09-30', endDay: '2026-09-01' },
    { startDay: '2026-9-01', endDay: '2026-09-30' }
  ]) {
    assert.equal(isListeningStatsClearRange(range), false)
  }
})

test('persisted daily detail is normalized without assigning dates to legacy totals', () => {
  assert.equal(normalizeListeningTrackDays(undefined), undefined)
  assert.equal(normalizeListeningTrackDays([]), undefined)
  assert.deepEqual(
    normalizeListeningTrackDays({
      '2026-09-30': { seconds: '5', plays: 1, skips: -1, completions: 'bad', lastPlayed: 100 },
      '2026-02-29': { seconds: 20 },
      '2026-09-29': null
    }),
    { '2026-09-30': { seconds: 5, plays: 1, skips: 0, completions: 0, lastPlayed: 100 } }
  )
})

test('range clearing preserves undated legacy contributions and updates last played', () => {
  const stat = legacyStat()
  recordListeningTrackDay(stat, Date.parse('2026-09-30T14:00:00Z'), { seconds: 20, plays: 1 })
  stat.seconds += 20
  stat.plays++
  stat.lastPlayed = Date.parse('2026-09-30T14:00:00Z')
  const stats: ListeningStats = { days: { '2026-09-30': 20 }, tracks: { song: stat } }
  const range = { startDay: '2026-09-30', endDay: '2026-09-30' }
  assert.deepEqual(previewListeningStatsClear(stats, range), {
    dayCount: 1,
    seconds: 20,
    trackCount: 1,
    hasUndatedTracks: true
  })
  clearListeningStatsHistory(stats, range)
  assert.deepEqual(stats.days, {})
  assert.equal(stat.seconds, 100)
  assert.equal(stat.plays, 2)
  assert.equal(stat.skips, 1)
  assert.equal(stat.completions, 1)
  assert.equal(stat.lastPlayed, legacyStat().lastPlayed)
  assert.deepEqual(stat.daily, {})
  clearListeningStatsHistory(stats, null)
  assert.deepEqual(stats, { days: {}, tracks: {} })
})

test('daily retention compacts detail into the retained cumulative history', () => {
  const stat = legacyStat()
  recordListeningTrackDay(stat, Date.parse('2026-09-01T15:00:00Z'), { seconds: 10 })
  stat.seconds += 10
  recordListeningTrackDay(stat, Date.parse('2026-09-30T15:00:00Z'), { seconds: 5 })
  stat.seconds += 5
  stat.lastPlayed = Date.parse('2026-09-30T15:00:00Z')
  assert.equal(compactListeningTrackDays(stat, '2026-09-10'), true)
  assert.equal(compactListeningTrackDays(stat, '2026-09-10'), false)
  assert.equal(stat.seconds, 115)
  const stats = { days: {}, tracks: { song: stat } }
  clearListeningStatsHistory(stats, { startDay: '2026-09-30', endDay: '2026-09-30' })
  assert.equal(stat.seconds, 110)
  assert.equal(stat.lastPlayed, Date.parse('2026-09-01T15:00:00Z'))
})
