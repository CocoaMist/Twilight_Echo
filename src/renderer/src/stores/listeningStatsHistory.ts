import type { ListeningStats, ListeningTrackStat } from '@renderer/stores/useListeningStatsStore'

export interface ListeningTrackDayStat {
  seconds: number
  plays: number
  skips: number
  completions: number
  lastPlayed: number
}

export type ListeningStatsClearRange = { startDay: string; endDay: string } | null

export interface ListeningStatsClearPreview {
  dayCount: number
  seconds: number
  trackCount: number
  hasUndatedTracks: boolean
}

const counters = ['seconds', 'plays', 'skips', 'completions'] as const

export function isListeningStatsDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const timestamp = Date.parse(`${value}T00:00:00.000Z`)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
}

export function isListeningStatsClearRange(range: ListeningStatsClearRange): boolean {
  return (
    range === null ||
    (isListeningStatsDay(range.startDay) &&
      isListeningStatsDay(range.endDay) &&
      range.startDay <= range.endDay)
  )
}

function includesDay(range: ListeningStatsClearRange, day: string): boolean {
  return range === null || (day >= range.startDay && day <= range.endDay)
}

export function normalizeListeningTrackDays(
  value: unknown
): Record<string, ListeningTrackDayStat> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const result: Record<string, ListeningTrackDayStat> = {}
  for (const [day, raw] of Object.entries(value)) {
    if (!isListeningStatsDay(day) || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const record = raw as Record<string, unknown>
    const stat: ListeningTrackDayStat = {
      seconds: 0,
      plays: 0,
      skips: 0,
      completions: 0,
      lastPlayed: 0
    }
    for (const key of [...counters, 'lastPlayed'] as const) {
      const number = Number(record[key])
      if (Number.isFinite(number) && number > 0) stat[key] = number
    }
    result[day] = stat
  }
  return result
}

export function recordListeningTrackDay(
  stat: ListeningTrackStat,
  timestamp: number,
  delta: Partial<Omit<ListeningTrackDayStat, 'lastPlayed'>>
): void {
  if (!stat.daily) {
    stat.undatedLastPlayed = stat.lastPlayed
    stat.daily = {}
  }
  const day = new Date(timestamp).toISOString().slice(0, 10)
  const daily = (stat.daily[day] ??= {
    seconds: 0,
    plays: 0,
    skips: 0,
    completions: 0,
    lastPlayed: 0
  })
  for (const key of counters) daily[key] += delta[key] ?? 0
  daily.lastPlayed = Math.max(daily.lastPlayed, timestamp)
}

export function compactListeningTrackDays(stat: ListeningTrackStat, oldestDay: string): boolean {
  let changed = false
  for (const day in stat.daily) {
    if (day >= oldestDay) continue
    stat.undatedLastPlayed = Math.max(stat.undatedLastPlayed ?? 0, stat.daily[day].lastPlayed)
    delete stat.daily[day]
    changed = true
  }
  return changed
}

export function previewListeningStatsClear(
  stats: ListeningStats,
  range: ListeningStatsClearRange
): ListeningStatsClearPreview {
  const result: ListeningStatsClearPreview = {
    dayCount: 0,
    seconds: 0,
    trackCount: 0,
    hasUndatedTracks: false
  }
  for (const day in stats.days) {
    if (!includesDay(range, day)) continue
    result.dayCount++
    result.seconds += stats.days[day]
  }
  for (const id in stats.tracks) {
    const stat = stats.tracks[id]
    if (range === null) {
      result.trackCount++
      continue
    }
    let affected = false
    const dated = { seconds: 0, plays: 0, skips: 0, completions: 0 }
    for (const day in stat.daily) {
      const daily = stat.daily[day]
      for (const key of counters) dated[key] += daily[key]
      if (includesDay(range, day)) affected = true
    }
    if (affected) result.trackCount++
    if (counters.some((key) => stat[key] > dated[key])) result.hasUndatedTracks = true
  }
  return result
}

export function clearListeningStatsHistory(
  stats: ListeningStats,
  range: ListeningStatsClearRange
): void {
  if (range === null) {
    stats.days = {}
    stats.tracks = {}
    return
  }
  for (const day in stats.days) {
    if (includesDay(range, day)) delete stats.days[day]
  }
  for (const id in stats.tracks) {
    const stat = stats.tracks[id]
    let affected = false
    for (const day in stat.daily) {
      if (!includesDay(range, day)) continue
      for (const key of counters) stat[key] = Math.max(0, stat[key] - stat.daily[day][key])
      delete stat.daily[day]
      affected = true
    }
    if (!affected) continue
    if (counters.every((key) => stat[key] === 0)) {
      delete stats.tracks[id]
      continue
    }
    stat.lastPlayed = stat.undatedLastPlayed ?? 0
    for (const day in stat.daily)
      stat.lastPlayed = Math.max(stat.lastPlayed, stat.daily[day].lastPlayed)
  }
}
