/** Exact all-history totals; UI ranking windows must not be used as the denominator. */
function positiveFinite(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}
export function summarizeRecordedTracks(tracks: Record<string, { seconds: number; plays: number; track?: { format?: string } }>): {
  seconds: number
  plays: number
  trackCount: number
  formats: Array<{ key: string; label: string; count: number; percent: number }>
} {
  let seconds = 0
  let plays = 0
  let trackCount = 0
  const counts = new Map<string, number>()
  for (const id in tracks) {
    if (!Object.prototype.hasOwnProperty.call(tracks, id)) continue
    const stat = tracks[id]
    const trackSeconds = positiveFinite(stat.seconds)
    const trackPlays = positiveFinite(stat.plays)
    if (trackSeconds === 0 && trackPlays === 0) continue
    seconds += trackSeconds
    plays += trackPlays
    trackCount += 1
    const key = stat.track?.format?.trim().toUpperCase() || 'unknown'
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const ranked = Array.from(counts, ([key, count]) => ({
    key,
    label: key === 'unknown' ? '未知' : key,
    count
  })).sort((left, right) => {
    return right.count - left.count || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
  })
  const unknown = ranked.find((format) => format.key === 'unknown')
  const visible = ranked.length <= 6 ? ranked : []
  if (ranked.length > 6) {
    const limit = unknown ? 4 : 5
    let count = 0
    for (const format of ranked) {
      if (format.key === 'unknown') continue
      if (visible.length < limit) visible.push(format)
      else count += format.count
    }
    if (unknown) visible.push(unknown)
    visible.push({ key: 'other', label: '其他', count })
  }
  return {
    seconds,
    plays,
    trackCount,
    formats: visible.map((format) => ({ ...format, percent: (format.count / trackCount) * 100 }))
  }
}
