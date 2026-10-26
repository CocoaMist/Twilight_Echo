export type AnalyticsRange = 7 | 30 | 90

export interface AnalyticsDay {
  key: string
  seconds: number
}

const DAY_MS = 86_400_000

function positiveFinite(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export function buildListeningDays(
  days: Record<string, number>,
  now: Date,
  count: number,
  offset = 0
): AnalyticsDay[] {
  const length = Math.floor(positiveFinite(count))
  const end = new Date(now)
  end.setUTCHours(0, 0, 0, 0)
  end.setUTCDate(end.getUTCDate() - Math.floor(positiveFinite(offset)))
  const start = end.getTime() - (length - 1) * DAY_MS
  const result: AnalyticsDay[] = []
  for (let index = 0; index < length; index += 1) {
    const key = utcDayKey(new Date(start + index * DAY_MS))
    result.push({ key, seconds: positiveFinite(days[key]) })
  }
  return result
}

export function summarizeDays(days: AnalyticsDay[]): {
  seconds: number
  activeDays: number
  averageSeconds: number
  longestStreak: number
  bestDay: AnalyticsDay | null
} {
  let seconds = 0
  let activeDays = 0
  let longestStreak = 0
  let streak = 0
  let previousDay = Number.NaN
  let bestDay: AnalyticsDay | null = null
  for (const day of days) {
    const value = positiveFinite(day.seconds)
    const timestamp = Date.parse(`${day.key}T00:00:00.000Z`)
    seconds += value
    if (value > 0) {
      activeDays += 1
      streak = timestamp - previousDay === DAY_MS ? streak + 1 : 1
      longestStreak = Math.max(longestStreak, streak)
      if (!bestDay || value > bestDay.seconds) bestDay = { key: day.key, seconds: value }
    } else {
      streak = 0
    }
    previousDay = timestamp
  }
  return {
    seconds,
    activeDays,
    averageSeconds: days.length ? seconds / days.length : 0,
    longestStreak,
    bestDay
  }
}

export function comparePeriods(
  currentSeconds: number,
  previousSeconds: number
): { percent: number | null; direction: 'up' | 'down' | 'same' | 'new' } {
  const current = positiveFinite(currentSeconds)
  const previous = positiveFinite(previousSeconds)
  if (previous === 0) {
    return current > 0 ? { percent: null, direction: 'new' } : { percent: 0, direction: 'same' }
  }
  return {
    percent: ((current - previous) / previous) * 100,
    direction: current === previous ? 'same' : current > previous ? 'up' : 'down'
  }
}

export function formatListeningDuration(seconds: number): string {
  const rounded = Math.round(positiveFinite(seconds))
  if (rounded < 60) return `${rounded}秒`
  const minutes = Math.floor(rounded / 60)
  if (minutes < 60) return `${minutes}分钟`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return remainder ? `${hours}小时${remainder}分钟` : `${hours}小时`
}

export function listeningDurationParts(seconds: number): { value: string; unit: string } {
  const rounded = Math.round(positiveFinite(seconds))
  if (rounded < 60) return { value: String(rounded), unit: '秒' }
  if (rounded < 3600) return { value: String(Math.floor(rounded / 60)), unit: '分钟' }
  return { value: String(Number((rounded / 3600).toFixed(1))), unit: '小时' }
}

export function formatDayLabel(key: string): string {
  const [, month, day] = key.split('-')
  return `${Number(month)}月${Number(day)}日`
}

export function buildListeningCalendar(
  days: Record<string, number>,
  now: Date
): {
  cells: Array<AnalyticsDay & { inRange: boolean; isToday: boolean; level: number }>
  months: Array<{ key: string; label: string; column: number }>
  weeks: number
  summary: ReturnType<typeof summarizeDays>
} {
  const range = buildListeningDays(days, now, 365)
  const summary = summarizeDays(range)
  const first = new Date(`${range[0].key}T00:00:00.000Z`)
  const leading = (first.getUTCDay() + 6) % 7
  const weeks = Math.ceil((leading + range.length) / 7)
  const start = first.getTime() - leading * DAY_MS
  const today = utcDayKey(now)
  const maximum = summary.bestDay?.seconds ?? 0
  const cells: Array<AnalyticsDay & { inRange: boolean; isToday: boolean; level: number }> = []
  const months: Array<{ key: string; label: string; column: number }> = []
  let previousMonth = ''
  for (let index = 0; index < weeks * 7; index += 1) {
    const inRange = index >= leading && index < leading + range.length
    const day = inRange
      ? range[index - leading]
      : { key: utcDayKey(new Date(start + index * DAY_MS)), seconds: 0 }
    cells.push({
      ...day,
      inRange,
      isToday: day.key === today,
      level: day.seconds > 0 ? Math.max(1, Math.ceil((day.seconds / maximum) * 4)) : 0
    })
    const month = day.key.slice(0, 7)
    if (inRange && month !== previousMonth) {
      months.push({
        key: month,
        label: `${Number(month.slice(5))}月`,
        column: Math.floor(index / 7) + 1
      })
      previousMonth = month
    }
  }
  return { cells, months, weeks, summary }
}

export { summarizeRecordedTracks } from '../../../../shared/listeningRecordedSummary.ts'
