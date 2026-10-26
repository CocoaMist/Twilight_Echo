import { computed, effectScope, readonly, ref, watch } from 'vue'
import type { RadioBrowserStation, CoreRadioStation } from '../../../shared/coreStreams.ts'
import { useCoreConnection } from './coreConnection.ts'

const stations = ref<CoreRadioStation[]>([])
const revision = ref(0)
const loading = ref<Promise<void> | null>(null)
const error = ref('')
const loaded = ref(false)
let mutation: Promise<unknown> = Promise.resolve()
let observedCore: ReturnType<typeof useCoreConnection> | null = null
const observation = effectScope(true)

function observe(core: ReturnType<typeof useCoreConnection>): void {
  if (observedCore) return
  observedCore = core
  observation.run(() =>
    watch(core.state, (snapshot) => {
      const nextRevision = snapshot?.streams?.radioRevision
      if (loaded.value && nextRevision != null && nextRevision !== revision.value) {
        void readAll(nextRevision)
          .then(() => {
            error.value = ''
          })
          .catch((err) => {
            error.value = err instanceof Error ? err.message : String(err)
          })
      }
    })
  )
}

async function readAll(radioRevision?: number): Promise<void> {
  const core = useCoreConnection()
  const revisionToRead = radioRevision ?? core.state.value?.streams?.radioRevision
  if (revisionToRead == null) throw new Error('流媒体服务尚未就绪')
  const items: CoreRadioStation[] = []
  let offset = 0
  for (;;) {
    const page = await core.query('radio.stations', {
      revision: revisionToRead,
      offset,
      limit: 200
    })
    items.push(...page.items)
    offset += page.items.length
    if (!page.items.length || offset >= page.total) {
      stations.value = items
      revision.value = page.revision
      loaded.value = true
      return
    }
  }
}

async function ensureLoaded(): Promise<void> {
  if (loading.value) return loading.value
  const core = useCoreConnection()
  observe(core)
  loading.value = (async () => {
    if (!core.state.value) await core.attach()
    const nextRevision = core.state.value?.streams?.radioRevision
    if (!loaded.value || nextRevision !== revision.value) await readAll(nextRevision)
  })()
    .then(() => {
      error.value = ''
    })
    .catch((err) => {
      error.value = err instanceof Error ? err.message : String(err)
      throw err
    })
    .finally(() => {
      loading.value = null
    })
  return loading.value
}

function mutate<T>(action: () => Promise<T>): Promise<T> {
  const next = mutation.then(action)
  mutation = next.catch(() => {})
  return next
}

export function useRadioStore() {
  const core = useCoreConnection()

  async function edit(
    edit: import('../../../shared/coreStreams.ts').CoreRadioEdit['edit']
  ): Promise<{ id?: string; added?: number }> {
    return mutate(async () => {
      await ensureLoaded()
      const result = (await core.command('radio.edit', { revision: revision.value, edit })) as {
        state: { radioRevision: number }
        id?: string
        added?: number
      }
      await readAll(result.state.radioRevision)
      error.value = ''
      return result
    })
  }

  async function addStation(input: {
    name: string
    streamUrl: string
    homepage?: string
    tags?: string[]
    allowInsecureHttp?: boolean
  }): Promise<CoreRadioStation> {
    const result = await edit({ kind: 'add', ...input })
    const station = stations.value.find((item) => item.id === result.id)
    if (!station) throw new Error('电台添加后未找到')
    return station
  }

  async function removeStation(id: string): Promise<void> {
    await edit({ kind: 'remove', id })
  }

  async function importPlaylistText(
    text: string,
    options: { fileNameHint?: string; allowInsecureHttp?: boolean } = {}
  ): Promise<number> {
    const result = await edit({ kind: 'import', text, ...options })
    return result.added ?? 0
  }

  async function searchDirectory(
    query: string,
    options: { limit?: number; offset?: number } = {}
  ): Promise<RadioBrowserStation[]> {
    return core.query('radio.directory', { query, limit: options.limit, offset: options.offset })
  }

  async function playStation(id: string): Promise<void> {
    await ensureLoaded()
    await core.command('streams.play', { kind: 'radio', id, revision: revision.value, play: true })
  }

  return {
    stations: computed(() => stations.value),
    revision: readonly(revision),
    error: readonly(error),
    ensureLoaded,
    addStation,
    removeStation,
    searchDirectory,
    importPlaylistText,
    playStation
  }
}

if (import.meta.hot) import.meta.hot.dispose(() => observation.stop())
