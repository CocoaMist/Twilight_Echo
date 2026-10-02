export async function searchUnifiedCollections<T>(options: {
  local: { items: T[]; total: number }
  searchLocal: (limit: number, offset: number) => Promise<{ items: T[]; total: number }>
  providers: Array<{ id: string; name: string }>
  search: (
    providerId: string,
    limit: number,
    offset: number
  ) => Promise<{ items: T[]; total: number }>
  limit: number
  offset: number
  reportError: (message: string) => void
}): Promise<{ items: T[]; total: number }> {
  const sources = [{ ...options.local, name: '本地音乐', search: options.searchLocal }]
  let total = options.local.total
  const results = await Promise.allSettled(
    options.providers.map((provider) => options.search(provider.id, options.limit, 0))
  )
  let successes = 0
  const errors: string[] = []
  for (let index = 0; index < results.length; index++) {
    const result = results[index]
    if (result.status === 'fulfilled') {
      successes++
      const provider = options.providers[index]
      sources.push({
        ...result.value,
        name: provider.name,
        search: (limit, offset) => options.search(provider.id, limit, offset)
      })
      total += result.value.total
    } else {
      errors.push(
        `${options.providers[index].name}：${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
      )
    }
  }
  if (errors.length && successes === 0 && total === 0) throw new Error(errors.join('；'))
  let skip = options.offset
  let remaining = options.limit
  const windows: Array<{ name: string; items: Promise<T[]> }> = []
  for (const source of sources) {
    if (remaining === 0) break
    if (skip >= source.total) {
      skip -= source.total
      continue
    }
    const start = skip
    skip = 0
    const count = Math.min(remaining, source.total - start)
    remaining -= count
    windows.push({
      name: source.name,
      items:
        start + count <= source.items.length
          ? Promise.resolve(source.items.slice(start, start + count))
          : source.search(count, start).then((result) => result.items.slice(0, count))
    })
  }
  const pages = await Promise.allSettled(windows.map((window) => window.items))
  const items: T[] = []
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index]
    if (page.status === 'fulfilled') items.push(...page.value)
    else
      errors.push(
        `${windows[index].name}：${page.reason instanceof Error ? page.reason.message : String(page.reason)}`
      )
  }
  if (errors.length) {
    const message = errors.join('；')
    if (pages.length && pages.every((page) => page.status === 'rejected')) throw new Error(message)
    options.reportError(message)
  }
  return { items, total }
}
