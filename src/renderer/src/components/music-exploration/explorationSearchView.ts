import { shallowRef } from 'vue'
import type { MusicExplorationPage, MusicExplorationQuery } from '../../../../shared/musicExploration.ts'

export function createExplorationSearchView(read: (query: MusicExplorationQuery, signal: AbortSignal) => Promise<MusicExplorationPage>, clock: {
  now?(): number; schedule?(callback: () => void, delay: number): () => void
} = {}) {
  const state = shallowRef<{ page: MusicExplorationPage | null; loading: boolean; error: string }>({ page: null, loading: false, error: '' })
  let current: AbortController | null = null, text = '', scope: 'library' | 'catalog' = 'library', disposed = false
  let cancelExpiry: (() => void) | null = null
  const now = clock.now ?? Date.now
  const schedule = clock.schedule ?? ((callback: () => void, delay: number) => {
    const timer = setTimeout(callback, delay)
    ;(timer as unknown as { unref?(): void }).unref?.()
    return () => clearTimeout(timer)
  })
  function expire(deadline: number) {
    const remaining = deadline - now()
    if (remaining > 0) { cancelExpiry = schedule(() => expire(deadline), Math.min(remaining, 2147483647)); return }
    current?.abort(); current = null; cancelExpiry = null
    state.value = { page: null, loading: false, error: '资料缓存已到期，请重新读取' }
  }
  async function load(offset = 0, keepToken = false) {
    current?.abort()
    cancelExpiry?.(); cancelExpiry = null
    const request = new AbortController(); current = request
    const token = keepToken ? state.value.page?.token : undefined
    state.value = { page: null, loading: !!text, error: '' }
    if (!text || disposed) return
    try {
      const page = await read({ search: text, kinds: ['artist', 'work', 'performance'], scope, offset, limit: 10, ...(token ? { token } : {}) }, request.signal)
      if (current !== request || disposed) return
      state.value = { page, loading: false, error: '' }
      if (page.token.expiresAt !== null) expire(page.token.expiresAt)
    } catch (error) {
      if (current === request && !disposed) state.value = { page: null, loading: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
  return { state, setQuery(query: string, nextScope: 'library' | 'catalog' = 'library') { text = query.trim(); scope = nextScope; return load() },
    page(offset: number) { return load(offset, true) }, refresh() { return load() },
    dispose() { disposed = true; current?.abort(); current = null; cancelExpiry?.(); cancelExpiry = null } }
}
