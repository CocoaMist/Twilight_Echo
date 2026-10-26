import { onScopeDispose, shallowReadonly, shallowRef, watch } from 'vue'

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) freeze(child)
  }
  return value
}

/** Query results are disposable projections fenced by the state that requested them. */
export function createCorePlayerResource<T>(
  key: () => string,
  query: () => Promise<T>,
  failed: (error: unknown) => void
) {
  const value = shallowRef<T | null>(null)
  const loading = shallowRef(false)
  let generation = 0
  async function refresh(): Promise<void> {
    const expected = key(),
      request = ++generation
    if (!expected) {
      value.value = null
      loading.value = false
      return
    }
    loading.value = true
    try {
      const result = await query()
      if (request === generation && expected === key()) value.value = freeze(result)
    } catch (error) {
      if (request === generation) failed(error)
      throw error
    } finally {
      if (request === generation) loading.value = false
    }
  }
  watch(
    key,
    () => {
      void refresh().catch(() => {})
    },
    { immediate: true }
  )
  onScopeDispose(() => {
    generation++
  })
  return { value: shallowReadonly(value), loading: shallowReadonly(loading), refresh }
}
