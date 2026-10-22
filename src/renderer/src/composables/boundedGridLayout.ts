/** Bounded artwork grids used by the PR 154 page layouts. */
export interface GridLayoutMetrics {
  minColumnWidth: number
  maxColumnWidth: number
  columnGap: number
  rowGap: number
  padX: number
  padY: number
  coverGap: number
}

export function resolveGridLayoutMetrics(
  containerWidth: number,
  compact = false
): GridLayoutMetrics {
  if (compact) {
    return {
      minColumnWidth: 140,
      maxColumnWidth: 190,
      columnGap: 10,
      rowGap: 10,
      padX: 0,
      padY: 0,
      coverGap: 8
    }
  }
  if (containerWidth <= 640) {
    return {
      minColumnWidth: 128,
      maxColumnWidth: 200,
      columnGap: 10,
      rowGap: 12,
      padX: 0,
      padY: 0,
      coverGap: 13
    }
  }
  if (containerWidth <= 900) {
    return {
      minColumnWidth: 160,
      maxColumnWidth: 220,
      columnGap: 14,
      rowGap: 16,
      padX: 0,
      padY: 0,
      coverGap: 13
    }
  }
  return {
    minColumnWidth: 200,
    maxColumnWidth: 240,
    columnGap: 24,
    rowGap: 28,
    padX: 0,
    padY: 0,
    coverGap: 13
  }
}

export function estimateGridColumns(
  containerWidth: number,
  metrics = resolveGridLayoutMetrics(containerWidth),
  itemCount = Number.POSITIVE_INFINITY
): number {
  // Use every readable column that fits, but do not reserve empty tracks when
  // a small collection can share more width. CSS caps tracks at the same max.
  const { minColumnWidth, columnGap } = metrics
  const width = Math.max(0, containerWidth)
  const capacity = Math.max(1, Math.floor((width + columnGap) / (minColumnWidth + columnGap)))
  return Math.max(1, Math.min(capacity, Math.floor(itemCount)))
}

export function estimateGridColumnWidth(
  containerWidth: number,
  columns: number,
  metrics = resolveGridLayoutMetrics(containerWidth)
): number {
  const safeColumns = Math.max(1, Math.floor(columns))
  const available = Math.max(0, containerWidth - (safeColumns - 1) * metrics.columnGap)
  return Math.max(1, Math.min(metrics.maxColumnWidth, available / safeColumns))
}
