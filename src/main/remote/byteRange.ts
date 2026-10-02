/** Single byte ranges used by media clients. Invalid/unsatisfiable ranges return null. */
export function parseByteRange(
  range: string,
  total: number
): { start: number; end: number } | null {
  if (!Number.isSafeInteger(total) || total <= 0) return null
  const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim())
  if (!match || (!match[1] && !match[2])) return null
  // BigInt permits legal, arbitrarily large range ends without numeric overflow.
  const size = BigInt(total)
  if (!match[1]) {
    const suffix = BigInt(match[2])
    if (suffix === 0n) return null
    return { start: Number(suffix >= size ? 0n : size - suffix), end: total - 1 }
  }
  const start = BigInt(match[1])
  const end = match[2] ? BigInt(match[2]) : size - 1n
  if (start >= size || end < start) return null
  return { start: Number(start), end: Number(end >= size ? size - 1n : end) }
}
