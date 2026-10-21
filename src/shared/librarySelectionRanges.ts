import type { LibrarySelectionRange } from './librarySelection.ts'

/** Normalized half-open intervals; space follows selection boundaries, not rows. */
export function selectionContains(
  ranges: readonly LibrarySelectionRange[],
  position: number
): boolean {
  let low = 0,
    high = ranges.length
  while (low < high) {
    const middle = (low + high) >>> 1
    const [start, end] = ranges[middle]
    if (position < start) high = middle
    else if (position >= end) low = middle + 1
    else return true
  }
  return false
}
export function addSelectionRange(
  ranges: readonly LibrarySelectionRange[],
  start: number,
  end: number
): LibrarySelectionRange[] {
  if (end <= start) return ranges.map(([a, b]) => [a, b])
  const result: LibrarySelectionRange[] = []
  let from = start,
    to = end,
    inserted = false
  for (const [a, b] of ranges) {
    if (b < from) result.push([a, b])
    else if (a > to) {
      if (!inserted) {
        result.push([from, to])
        inserted = true
      }
      result.push([a, b])
    } else {
      from = Math.min(from, a)
      to = Math.max(to, b)
    }
  }
  if (!inserted) result.push([from, to])
  return result
}
export function toggleSelectionPosition(
  ranges: readonly LibrarySelectionRange[],
  position: number
): LibrarySelectionRange[] {
  if (!selectionContains(ranges, position)) return addSelectionRange(ranges, position, position + 1)
  const result: LibrarySelectionRange[] = []
  for (const [start, end] of ranges) {
    if (position < start || position >= end) result.push([start, end])
    else {
      if (start < position) result.push([start, position])
      if (position + 1 < end) result.push([position + 1, end])
    }
  }
  return result
}
