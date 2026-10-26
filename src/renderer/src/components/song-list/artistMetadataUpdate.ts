import { shallowRef } from 'vue'
import type { CatalogKind } from '../../../../shared/musicCatalog.ts'
import type {
  MusicIdentityDetail,
  MusicExternalReference
} from '../../../../shared/musicIdentification.ts'
import { metadataProviderReference } from '../../../../shared/metadataProviders.ts'
import type {
  EntityMetadataDemand,
  EntityMetadataJob,
  EntityMetadataPolicyView
} from '../../../../shared/entityMetadata.ts'
import {
  METADATA_REQUERY_STATES,
  type MetadataTaskSourcesQuery,
  type MetadataTaskSourcesPage,
  type MetadataTaskRequery
} from '../../../../shared/entityMetadataTasks.ts'

export function artistUpdateProviders(
  policy: EntityMetadataPolicyView,
  kind: CatalogKind = 'artist',
  references?: MusicExternalReference[]
): Array<string | undefined> {
  const registered =
    policy.sources?.flatMap((source) => source.enrichment.filter((item) => item.kind === kind)) ??
    []
  const providers: Array<string | undefined> = []
  if (registered.some((item) => item.provider === 'musicbrainz-details' && !item.reason))
    providers.push('musicbrainz-details')
  else if (
    !registered.some((item) => item.provider === 'musicbrainz-details') &&
    kind === 'artist' &&
    policy.identity &&
    policy.introduction
  )
    providers.push(undefined)
  if (registered.some((item) => item.provider === 'public-artwork' && !item.reason))
    providers.push('public-artwork')
  for (const item of registered)
    if (
      !item.reason &&
      !providers.includes(item.provider) &&
      !['musicbrainz-details', 'public-artwork'].includes(item.provider)
    )
      providers.push(item.provider)
  return references
    ? providers.filter((provider) =>
        metadataProviderReference(provider ?? 'musicbrainz-wiki', kind, references)
      )
    : providers
}

/** Explicit demands use the existing durable queue, independently of automatic import/history switches. */
export function createArtistMetadataUpdate(
  api: {
    policy(signal: AbortSignal): Promise<EntityMetadataPolicyView>
    jobs(entityId: string, signal: AbortSignal): Promise<{ items: EntityMetadataJob[] }>
    enrich(request: EntityMetadataDemand): Promise<EntityMetadataJob>
    sources(query: MetadataTaskSourcesQuery): Promise<MetadataTaskSourcesPage>
    requery(request: MetadataTaskRequery): Promise<unknown>
    newId(): string
    identity?(entityId: string, signal: AbortSignal): Promise<MusicIdentityDetail>
  },
  kind: CatalogKind = 'artist'
) {
  const state = shallowRef({
    policy: null as EntityMetadataPolicyView | null,
    references: undefined as MusicExternalReference[] | undefined,
    jobs: [] as EntityMetadataJob[],
    loading: false,
    submitting: false,
    error: '',
    notice: ''
  })
  let context: Omit<EntityMetadataDemand, 'batchId'> | null = null,
    generation = 0,
    disposed = false
  let request: AbortController | null = null
  async function refresh() {
    if (!context || disposed) return
    request?.abort()
    const controller = new AbortController(),
      expected = generation,
      id = context.entityId
    request = controller
    state.value = { ...state.value, loading: true, error: '' }
    try {
      const [policy, jobs, identity] = await Promise.all([
        api.policy(controller.signal),
        api.jobs(id, controller.signal),
        api.identity?.(id, controller.signal)
      ])
      if (!disposed && expected === generation && request === controller)
        state.value = {
          ...state.value,
          policy,
          jobs: jobs.items,
          references: identity?.references,
          loading: false
        }
    } catch (error) {
      if (!disposed && expected === generation && request === controller)
        state.value = {
          ...state.value,
          loading: false,
          error: error instanceof Error ? error.message : String(error)
        }
    }
  }
  return {
    state,
    refresh,
    setContext(next: typeof context) {
      generation++
      request?.abort()
      context = next
      state.value = {
        policy: null,
        references: undefined,
        jobs: [],
        loading: false,
        submitting: false,
        error: '',
        notice: ''
      }
      return refresh()
    },
    async submit() {
      if (
        !context ||
        !state.value.policy ||
        state.value.loading ||
        state.value.submitting ||
        disposed
      )
        return
      const providers = artistUpdateProviders(state.value.policy, kind, state.value.references)
      if (!providers.length) return
      const expected = generation,
        target = context,
        batchId = api.newId()
      state.value = { ...state.value, submitting: true, error: '', notice: '' }
      const failures: string[] = []
      let accepted = 0
      // Each accepted demand survives closing the page. A later rejection does
      // not retract earlier work or turn it into a reported success.
      for (const provider of providers) {
        if (disposed || expected !== generation) break
        try {
          const job = await api.enrich({ ...target, batchId, ...(provider ? { provider } : {}) })
          if (disposed || expected !== generation) return
          if (METADATA_REQUERY_STATES.some((value) => value === job.state)) {
            let offset = 0
            for (;;) {
              if (disposed || expected !== generation) break
              const page = await api.sources({ jobId: job.id, offset, limit: 100 })
              if (disposed || expected !== generation) return
              if (page.generation !== job.generation)
                throw new Error('任务已变化，请重新读取后更新')
              const source = page.items.find((item) => item.entity.id === target.entityId)
              if (source) {
                await api.requery({
                  // enqueue already registered batchId as a consumer. Requery
                  // requires a new demand, independently for each provider.
                  demandId: api.newId(),
                  items: [
                    {
                      jobId: job.id,
                      generation: job.generation,
                      entityId: source.entity.id,
                      inputVersion: source.inputVersion,
                      linkRevision: source.linkRevision
                    }
                  ]
                })
                break
              }
              offset += page.items.length
              if (!page.items.length || offset >= page.total)
                throw new Error('所选条目已不属于此人物，请重新核对身份')
            }
          }
          accepted++
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error))
        }
      }
      if (!disposed && expected === generation) {
        state.value = {
          ...state.value,
          submitting: false,
          notice: accepted ? `已提交 ${accepted} 项资料更新，可在任务中心继续查看。` : '',
          error: failures.join('；')
        }
        await refresh()
        if (failures.length && expected === generation)
          state.value = { ...state.value, error: failures.join('；') }
      }
    },
    dispose() {
      disposed = true
      generation++
      request?.abort()
      context = null
      state.value = { ...state.value, loading: false, submitting: false }
    }
  }
}
