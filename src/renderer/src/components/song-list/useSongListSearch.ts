import { onUnmounted, ref, watch, type Ref } from 'vue'
const pageQueries = new Map<string, string>()

export function useSongListSearch(viewKey?: Readonly<Ref<string>>): {
  searchQuery: Ref<string>
  debouncedSearchQuery: Ref<string>
  searchInputFocused: Ref<boolean>
} {
  const searchQuery = ref(viewKey ? (pageQueries.get(viewKey.value) ?? '') : '')
  const debouncedSearchQuery = ref(searchQuery.value)
  const searchInputFocused = ref(false)
  let searchDebounceTimer: number | null = null
  if (viewKey)
    watch(viewKey, (key, previous) => {
      pageQueries.set(previous, searchQuery.value)
      if (searchDebounceTimer !== null) clearTimeout(searchDebounceTimer)
      searchDebounceTimer = null
      searchQuery.value = pageQueries.get(key) ?? ''
      debouncedSearchQuery.value = searchQuery.value
    })

  watch(searchQuery, (value) => {
    if (searchDebounceTimer !== null) clearTimeout(searchDebounceTimer)
    searchDebounceTimer = window.setTimeout(() => {
      debouncedSearchQuery.value = value
      searchDebounceTimer = null
    }, 180)
  })

  onUnmounted(() => {
    if (viewKey) pageQueries.set(viewKey.value, searchQuery.value)
    if (searchDebounceTimer !== null) clearTimeout(searchDebounceTimer)
  })

  return {
    searchQuery,
    debouncedSearchQuery,
    searchInputFocused
  }
}
