import { computed, effectScope, readonly, ref, watch } from 'vue'
import type { CorePodcast, CorePodcastEpisode } from '../../../shared/coreStreams.ts'
import {
  podcastEpisodeProgressRatio,
  podcastEpisodeTrackId
} from '../../../shared/podcastSubscriptions.ts'
import { useCoreConnection } from './coreConnection.ts'

export { podcastEpisodeTrackId }

export type PodcastEpisodeView = CorePodcastEpisode
export type PodcastSubscriptionView = CorePodcast
const subscriptions = ref<PodcastSubscriptionView[]>([])
const revision = ref(0)
const loading = ref<Promise<void> | null>(null)
const error = ref('')
const busy = ref(false)
const undoTokens = new Map<string, string>()
const loaded = ref(false)
let observedCore: ReturnType<typeof useCoreConnection> | null = null
const observation = effectScope(true)

function observe(core: ReturnType<typeof useCoreConnection>): void {
  if (observedCore) return
  observedCore = core
  observation.run(() =>
    watch(core.state, (snapshot) => {
      const state = snapshot?.streams
      if (state) error.value = state.error ?? ''
      if (loaded.value && state && state.podcastRevision !== revision.value) {
        void readAll(state.podcastRevision).catch((err) => {
          error.value = err instanceof Error ? err.message : String(err)
        })
      }
    })
  )
}

async function readAll(podcastRevision?: number): Promise<void> {
  const core = useCoreConnection()
  const revisionToRead = podcastRevision ?? core.state.value?.streams?.podcastRevision
  if (revisionToRead == null) throw new Error('流媒体服务尚未就绪')
  const page = await core.query('podcasts.subscriptions', {
    revision: revisionToRead,
    offset: 0,
    limit: 200
  })
  subscriptions.value = page.items
  revision.value = page.revision
  loaded.value = true
}

async function ensureLoaded(): Promise<void> {
  if (loading.value) return loading.value
  const core = useCoreConnection()
  observe(core)
  loading.value = (async () => {
    if (!core.state.value) await core.attach()
    const nextRevision = core.state.value?.streams?.podcastRevision
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

async function applyResult(result: { state: { podcastRevision: number } }): Promise<void> {
  await readAll(result.state.podcastRevision)
  error.value = ''
}

export function getPodcastDefaultPlaybackRate(): number {
  return useCoreConnection().state.value?.streams?.defaultPlaybackRate ?? 1
}

export function setPodcastDefaultPlaybackRate(rate: number): void {
  const core = useCoreConnection(),
    state = core.state.value?.streams
  if (state)
    void core.command('podcasts.defaultRate', { revision: state.preferencesRevision, rate })
}

export function usePodcastStore() {
  const core = useCoreConnection()

  async function subscribe(feedUrl: string): Promise<PodcastSubscriptionView> {
    busy.value = true
    error.value = ''
    try {
      await ensureLoaded()
      const result = (await core.command('podcasts.subscribe', {
        feedUrl: feedUrl.trim(),
        revision: revision.value
      })) as { state: { podcastRevision: number }; id: string }
      await applyResult(result)
      const item = subscriptions.value.find((sub) => sub.id === result.id)
      if (!item) throw new Error('订阅添加后未找到')
      return item
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      busy.value = false
    }
  }

  async function unsubscribe(id: string): Promise<PodcastSubscriptionView | null> {
    await ensureLoaded()
    const removed = subscriptions.value.find((sub) => sub.id === id) ?? null
    if (!removed) return null
    const result = (await core.command('podcasts.edit', {
      revision: revision.value,
      edit: { kind: 'unsubscribe', id }
    })) as { state: { podcastRevision: number }; undoToken?: string }
    if (result.undoToken) undoTokens.set(id, result.undoToken)
    await applyResult(result)
    return removed
  }

  async function restoreSubscription(removed: PodcastSubscriptionView): Promise<void> {
    const token = undoTokens.get(removed.id)
    if (!token) throw new Error('撤销已失效，请重新订阅')
    const result = (await core.command('podcasts.edit', {
      revision: revision.value,
      edit: { kind: 'restore', token }
    })) as { state: { podcastRevision: number } }
    undoTokens.delete(removed.id)
    await applyResult(result)
  }

  async function refresh(id?: string): Promise<void> {
    busy.value = true
    error.value = ''
    try {
      const result = (await core.command('podcasts.refresh', { revision: revision.value, id })) as {
        state: { podcastRevision: number }
      }
      await applyResult(result)
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      busy.value = false
    }
  }

  async function episodes(id: string): Promise<CorePodcastEpisode[]> {
    await ensureLoaded()
    const page = await core.query('podcasts.episodes', {
      id,
      revision: revision.value,
      offset: 0,
      limit: 200
    })
    return page.items
  }

  async function playEpisode(subscriptionId: string, guid: string, resume = true): Promise<void> {
    await ensureLoaded()
    await core.command('streams.play', {
      kind: 'podcast',
      id: subscriptionId,
      guid,
      revision: revision.value,
      resume,
      play: true
    })
  }

  return {
    subscriptions: computed(() => subscriptions.value),
    revision: readonly(revision),
    error: readonly(error),
    busy: readonly(busy),
    ensureLoaded,
    subscribe,
    unsubscribe,
    restoreSubscription,
    refresh,
    refreshAll: () => refresh(),
    episodes,
    playEpisode,
    podcastEpisodeProgressRatio,
    podcastEpisodeTrackId
  }
}

if (import.meta.hot) import.meta.hot.dispose(() => observation.stop())
