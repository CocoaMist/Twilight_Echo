import { computed, ref, shallowRef } from 'vue'
import type {
  CoreNetworkEntry,
  CoreNetworkPage,
  CoreNetworkPageQuery
} from '../../../../shared/coreNetwork.ts'
import type { NetworkSourceProfileSummary } from '../../../../shared/networkSources.ts'

type DirectoryPage = CoreNetworkPage<CoreNetworkEntry> & { token: string }
type DirectoryReader = (
  profileId: string,
  path: string,
  query: Omit<CoreNetworkPageQuery, 'revision'> & { revision?: number; token?: string }
) => Promise<DirectoryPage>
export interface NetworkLibraryItem {
  profileId: string
  profileName: string
  entry: CoreNetworkEntry
}
type LibraryPage = CoreNetworkPage<CoreNetworkEntry & { profileName: string }>
type LibraryReader = (
  query: string,
  page: Omit<CoreNetworkPageQuery, 'revision'> & { revision?: number }
) => Promise<LibraryPage>
const PAGE_SIZE = 200
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * 端口输入归一化。`<input type="number">` 上的 `v-model` 会把已填写的值转成
 * number，而空值仍是字符串 `''`；两种形态都会传到这里，因此不能假设字符串
 * 方法可用。非法端口抛出可读错误，交由调用方展示。
 */
export function parseOptionalPort(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  if (text === '') return null
  const port = Number(text)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('端口需为 1-65535 之间的整数')
  }
  return port
}

/** Owns paged directory state. The cursor remains private to this view. */
export function createNetworkBrowser(readDirectory?: DirectoryReader) {
  const profile = shallowRef<NetworkSourceProfileSummary | null>(null)
  const path = ref('/')
  const entries = shallowRef<CoreNetworkEntry[]>([])
  const loading = ref(false)
  const error = ref('')
  const total = ref(0)
  let revision = 0
  let readRevision: number | undefined
  let token: string | undefined
  let disposed = false

  function capture(): () => boolean {
    const capturedRevision = revision
    return () => !disposed && capturedRevision === revision
  }

  async function fetchPage(append: boolean, expectedRevision = revision): Promise<void> {
    if (!readDirectory || !profile.value || disposed) return
    const profileId = profile.value.id
    const requestedPath = path.value
    const current = () => !disposed && expectedRevision === revision
    loading.value = true
    error.value = ''
    try {
      const page = await readDirectory(profileId, requestedPath, {
        revision: readRevision,
        offset: append ? entries.value.length : 0,
        limit: PAGE_SIZE,
        ...(append && token ? { token } : {})
      })
      if (!current()) return
      readRevision = page.revision
      token = page.token
      total.value = page.total
      entries.value = append ? [...entries.value, ...page.items] : page.items
    } catch (failure) {
      if (current()) error.value = `读取目录失败：${messageOf(failure)}`
    } finally {
      if (current()) loading.value = false
    }
  }

  async function navigateTo(nextPath: string): Promise<void> {
    if (!readDirectory || !profile.value || disposed) return
    revision++
    path.value = nextPath
    entries.value = []
    total.value = 0
    readRevision = undefined
    token = undefined
    error.value = ''
    await fetchPage(false)
  }

  async function loadMore(): Promise<void> {
    if (loading.value || entries.value.length >= total.value) return
    await fetchPage(true)
  }

  async function loadAll(): Promise<void> {
    const expectedRevision = revision
    while (!disposed && expectedRevision === revision && entries.value.length < total.value) {
      await fetchPage(true, expectedRevision)
      if (error.value) return
    }
  }

  function clear(): void {
    revision++
    profile.value = null
    path.value = '/'
    entries.value = []
    total.value = 0
    readRevision = undefined
    token = undefined
    error.value = ''
    loading.value = false
  }

  return {
    profile: computed(() => profile.value),
    path: computed(() => path.value),
    entries: computed(() => entries.value),
    total: computed(() => total.value),
    hasMore: computed(() => entries.value.length < total.value),
    loading: computed(() => loading.value),
    error: computed(() => error.value),
    capture,
    navigateTo,
    loadMore,
    loadAll,
    async enter(nextProfile: NetworkSourceProfileSummary) {
      if (disposed) return
      clear()
      profile.value = nextProfile
      path.value = nextProfile.rootPath
      await navigateTo(nextProfile.rootPath)
    },
    replaceProfile(nextProfile: NetworkSourceProfileSummary) {
      if (!disposed && profile.value?.id === nextProfile.id) profile.value = nextProfile
    },
    leave: clear,
    dispose() {
      disposed = true
      clear()
    }
  }
}

/** Query results are immutable snapshots; shallow refs avoid per-row reactive proxies. */
export function createNetworkLibraryView(search?: LibraryReader, debounceMs = 150) {
  const query = ref('')
  const items = shallowRef<NetworkLibraryItem[]>([])
  const loading = ref(false)
  const error = ref('')
  const total = ref(0)
  let readRevision: number | undefined
  let revision = 0
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  function cancel(): void {
    revision++
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    loading.value = false
  }

  function project(items: LibraryPage['items']): NetworkLibraryItem[] {
    return items.map(({ profileId, profileName, ...entry }) => ({
      profileId,
      profileName,
      entry: { ...entry, profileId }
    }))
  }

  async function load(): Promise<void> {
    cancel()
    if (!search || disposed) return
    const request = revision
    const requestedQuery = query.value
    const current = (): boolean =>
      !disposed && revision === request && query.value === requestedQuery
    loading.value = true
    error.value = ''
    readRevision = undefined
    total.value = 0
    try {
      const result = await search(requestedQuery, {
        offset: 0,
        limit: PAGE_SIZE
      })
      if (current()) {
        readRevision = result.revision
        total.value = result.total
        items.value = project(result.items)
      }
    } catch (failure) {
      if (current()) error.value = `读取媒体库失败：${messageOf(failure)}`
    } finally {
      if (current()) loading.value = false
    }
  }

  async function loadMore(): Promise<void> {
    if (!search || disposed || loading.value || items.value.length >= total.value) return
    const request = revision
    const requestedQuery = query.value
    const current = () => !disposed && revision === request && query.value === requestedQuery
    loading.value = true
    error.value = ''
    try {
      const result = await search(requestedQuery, {
        revision: readRevision,
        offset: items.value.length,
        limit: PAGE_SIZE
      })
      if (current()) items.value = [...items.value, ...project(result.items)]
    } catch (failure) {
      if (current()) error.value = `读取媒体库失败：${messageOf(failure)}`
    } finally {
      if (current()) loading.value = false
    }
  }

  return {
    query,
    items: computed(() => items.value),
    total: computed(() => total.value),
    hasMore: computed(() => items.value.length < total.value),
    loading: computed(() => loading.value),
    error: computed(() => error.value),
    load,
    loadMore,
    schedule() {
      cancel()
      items.value = []
      total.value = 0
      readRevision = undefined
      error.value = ''
      if (disposed || !search) return
      loading.value = true
      timer = setTimeout(() => {
        timer = undefined
        void load()
      }, debounceMs)
    },
    leave() {
      cancel()
      items.value = []
      total.value = 0
      readRevision = undefined
      error.value = ''
    },
    dispose() {
      disposed = true
      cancel()
      items.value = []
      total.value = 0
    }
  }
}
