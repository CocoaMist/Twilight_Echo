/** Request-local deduplication; no authorization verdict survives a request. */
export const AUTHORIZATION_BATCH_CONCURRENCY = 16

export async function resolveAuthorizationBatch<T>(
  sources: readonly string[],
  resolve: (source: string) => Promise<T>
): Promise<Map<string, T>> {
  const unique = [...new Set(sources)]
  const results = new Map<string, T>()
  let cursor = 0
  let failed = false
  const workers = Array.from(
    { length: Math.min(AUTHORIZATION_BATCH_CONCURRENCY, unique.length) },
    async () => {
      while (!failed && cursor < unique.length) {
        const source = unique[cursor++]!
        try {
          results.set(source, await resolve(source))
        } catch (error) {
          failed = true
          throw error
        }
      }
    }
  )
  // Drain outstanding work before rejecting; callers never commit a partial queue.
  const settled = await Promise.allSettled(workers)
  for (const result of settled) if (result.status === 'rejected') throw result.reason
  return results
}
