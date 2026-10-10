/** A local calendar date, retaining the precision actually present in the tag. */
export function normalizeReleaseDate(value: unknown): string | undefined {
  const text =
    typeof value === 'number' && Number.isInteger(value)
      ? String(value)
      : typeof value === 'string'
        ? value.trim()
        : ''
  const match =
    /^(\d{4})(?:([-/])(\d{2})(?:\2(\d{2}))?)?(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):?(\d{2}))?)?$/.exec(
      text
    )
  if (!match) return undefined
  const year = Number(match[1])
  if (year < 1) return undefined
  const month = match[3] ? Number(match[3]) : undefined
  const day = match[4] ? Number(match[4]) : undefined
  if (
    match[5] !== undefined &&
    (day === undefined ||
      Number(match[5]) > 23 ||
      Number(match[6]) > 59 ||
      Number(match[7] ?? 0) > 59 ||
      Number(match[8] ?? 0) > 23 ||
      Number(match[9] ?? 0) > 59)
  )
    return undefined
  if (month !== undefined && (month < 1 || month > 12)) return undefined
  if (day !== undefined) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    if (day < 1 || day > days[month! - 1]!) return undefined
  }
  return [match[1], match[3], match[4]].filter(Boolean).join('-')
}

export function readLocalReleaseDate(tags: {
  releasedate?: unknown
  date?: unknown
  year?: unknown
}): string | undefined {
  return (
    normalizeReleaseDate(tags.releasedate) ??
    normalizeReleaseDate(tags.date) ??
    normalizeReleaseDate(tags.year)
  )
}

export function formatReleaseDate(value: unknown): string {
  const date = normalizeReleaseDate(value)
  if (!date) return '发行时间未知'
  const [year, month, day] = date.split('-')
  return `${year}年${month ? `${Number(month)}月` : ''}${day ? `${Number(day)}日` : ''}`
}

/** Majority year, then precision and frequency; source order breaks ties. */
export function resolveAlbumReleaseDate(
  tracks: readonly { releaseDate?: string }[]
): string | undefined {
  const dates = tracks.flatMap((track) => {
    const date = normalizeReleaseDate(track.releaseDate)
    return date ? [date] : []
  })
  const years = new Map<string, number>()
  for (const date of dates) years.set(date.slice(0, 4), (years.get(date.slice(0, 4)) ?? 0) + 1)
  let selectedYear: string | undefined
  let yearCount = 0
  for (const [year, count] of years) {
    if (count > yearCount) {
      selectedYear = year
      yearCount = count
    }
  }
  if (!selectedYear) return undefined
  const counts = new Map<string, number>()
  for (const date of dates) {
    if (date.startsWith(selectedYear)) counts.set(date, (counts.get(date) ?? 0) + 1)
  }
  let selected: string | undefined
  let selectedCount = 0
  for (const [date, count] of counts) {
    if (
      !selected ||
      date.length > selected.length ||
      (date.length === selected.length && count > selectedCount)
    ) {
      selected = date
      selectedCount = count
    }
  }
  return selected
}
