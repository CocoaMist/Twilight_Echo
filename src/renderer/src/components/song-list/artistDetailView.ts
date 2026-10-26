import { shallowRef } from 'vue'
import type { CatalogEntity, CatalogPage, CatalogQuery } from '../../../../shared/musicCatalog.ts'
import type {
  EntityMetadataDetail,
  EntityMetadataFact,
  EntityMetadataLanguage
} from '../../../../shared/entityMetadata.ts'
import { selectMetadataIntroduction } from '../../../../shared/metadataProviders.ts'
import type { MusicIdentityDetail } from '../../../../shared/musicIdentification.ts'
import type { EntityMetadataReadApi } from '../music-metadata/entityMetadataView.ts'
import { artistIdentityPresentation } from '../music-metadata/artistIdentityView.ts'
import type { ArtistProfileChoice } from '../music-metadata/artistProfileChoice.ts'

export const ARTIST_REFERENCE_PAGE_SIZE = 6
export type ArtistSection = 'overview' | 'albums' | 'songs' | 'participation'
interface ArtistDetailState {
  page: CatalogPage | null
  samples: Record<string, string>
  identities: Record<string, string>
  selected: CatalogEntity | null
  detail: EntityMetadataDetail | null
  shared: boolean
  exact: boolean
  loading: boolean
  error: string
}
const empty = (): ArtistDetailState => ({
  page: null,
  samples: {},
  identities: {},
  selected: null,
  detail: null,
  shared: false,
  exact: true,
  loading: false,
  error: ''
})

/** One read owner for the hero, biography, participation anchor and source-scoped editors. */
export function createArtistDetailView(
  api: Omit<EntityMetadataReadApi, 'detail'> & {
    identity(id: string, signal: AbortSignal): Promise<MusicIdentityDetail>
    choice?(name: string): ArtistProfileChoice | null
    detail(
      id: string,
      language: EntityMetadataLanguage,
      sourceProvider: string,
      signal: AbortSignal,
      includeAutomaticArtwork: boolean
    ): Promise<EntityMetadataDetail>
  }
) {
  const state = shallowRef<ArtistDetailState>(empty())
  let context: { name: string; language: EntityMetadataLanguage } | null = null
  let request: AbortController | null = null
  let choice: string | null = null,
    offset = 0,
    pending = false,
    disposed = false
  const waiting: Array<() => void> = []
  async function refresh(withdraw = false): Promise<void> {
    if (!context || disposed) return
    if (withdraw) {
      request?.abort()
      request = null
      state.value = { ...state.value, detail: null, selected: null }
    }
    if (request) {
      pending = true
      await new Promise<void>((resolve) => waiting.push(resolve))
      return
    }
    const controller = new AbortController(),
      expected = context
    request = controller
    const current = () => !disposed && request === controller && !controller.signal.aborted
    state.value = { ...state.value, loading: true, error: '' }
    try {
      const base: CatalogQuery = {
        kind: 'artist',
        source: 'local',
        artistName: expected.name,
        context: { type: 'collection', collection: 'artists', id: expected.name },
        limit: 200
      }
      let first = await api.catalog(base, controller.signal)
      if (!current()) return
      const exact = first.total > 0
      if (!exact) {
        delete base.artistName
        first = await api.catalog(base, controller.signal)
      }
      if (!current()) return
      let page = first,
        count = 0,
        commonTarget: string | null = null
      let consistent = exact && first.total > 1
      const knownIdentities = new Map<string, MusicIdentityDetail>()
      let selected: CatalogEntity | null = null
      // Bounded batches, fenced to the exact collection revision. Collaborators
      // returned by the legacy collection contract are excluded by artistName.
      while (page.items.length) {
        selected ??= page.items.find((item) => item.id === choice) ?? null
        if (consistent) {
          for (let i = 0; i < page.items.length && consistent; i += 8) {
            const identities = await Promise.all(
              page.items.slice(i, i + 8).map((item) => api.identity(item.id, controller.signal))
            )
            if (!current()) return
            for (const identity of identities) {
              knownIdentities.set(identity.entityId, identity)
              if (
                identity.link?.state !== 'confirmed' ||
                !identity.link.targetId ||
                (commonTarget && commonTarget !== identity.link.targetId)
              ) {
                consistent = false
                break
              }
              commonTarget = identity.link.targetId
            }
          }
        }
        count += page.items.length
        if (count >= first.total || (!consistent && (!choice || selected))) break
        page = await api.catalog(
          { ...base, offset: count, revision: first.revision },
          controller.signal
        )
        if (!current()) return
        if (page.total !== first.total || page.revision !== first.revision)
          throw new Error('人物引用已变化，请重新读取')
      }
      const shared = !selected && consistent && count === first.total
      selected ??= exact && first.total === 1 ? first.items[0] : shared ? first.items[0] : null
      if (choice && !selected) choice = null
      offset = offset < first.total ? offset : 0
      const choices =
        offset === 0
          ? { ...first, items: first.items.slice(0, ARTIST_REFERENCE_PAGE_SIZE) }
          : await api.catalog(
              { ...base, offset, limit: ARTIST_REFERENCE_PAGE_SIZE, revision: first.revision },
              controller.signal
            )
      const references = await Promise.all(
        choices.items.map(async (entity) => {
          const [sourcePage, identity] = await Promise.all([
            api.sources(
              { entityId: entity.id, revision: first.revision, limit: 1 },
              controller.signal
            ),
            knownIdentities.get(entity.id) ?? api.identity(entity.id, controller.signal)
          ])
          const source = sourcePage.items[0]
          return [
            entity.id,
            {
              sample: source
                ? [source.track.title, source.track.album].filter(Boolean).join(' · ')
                : '',
              identity: identity.link?.state === 'confirmed' ? '身份已确认' : '待核对身份'
            }
          ] as const
        })
      )
      const samples = Object.fromEntries(references.map(([id, value]) => [id, value.sample]))
      const identities = Object.fromEntries(references.map(([id, value]) => [id, value.identity]))
      const detail = selected
        ? await api.detail(selected.id, expected.language, 'local', controller.signal, shared)
        : null
      if (!current()) return
      const saved = api.choice?.(expected.name)
      if (
        saved &&
        selected?.id === saved.entityId &&
        (detail?.targetId !== saved.targetId ||
          (saved.targetId && detail?.link?.state !== 'confirmed'))
      ) {
        choice = null
        throw new Error('已保存的人物身份已变化，请重新选择资料条目')
      }
      if (shared && (detail?.link?.state !== 'confirmed' || detail.targetId !== commonTarget))
        throw new Error('人物身份已变化，请重新读取')
      state.value = {
        page: choices,
        samples,
        identities,
        selected,
        detail,
        shared,
        exact,
        loading: false,
        error: ''
      }
    } catch (error) {
      if (current())
        state.value = { ...empty(), error: error instanceof Error ? error.message : String(error) }
    } finally {
      if (request === controller) {
        request = null
        if (pending) {
          pending = false
          await refresh()
        } else waiting.splice(0).forEach((resolve) => resolve())
      }
    }
  }
  function cancel() {
    request?.abort()
    request = null
    pending = false
    waiting.splice(0).forEach((resolve) => resolve())
  }
  return {
    state,
    refresh,
    setContext(name: string | null, language: EntityMetadataLanguage) {
      cancel()
      choice = name ? (api.choice?.(name)?.entityId ?? null) : null
      offset = 0
      context = name ? { name, language } : null
      state.value = empty()
      return refresh()
    },
    select(entity: CatalogEntity) {
      cancel()
      choice = entity.id
      state.value = { ...state.value, detail: null, selected: null }
      return refresh()
    },
    page(next: number) {
      offset = Math.max(0, next)
      return refresh()
    },
    dispose() {
      disposed = true
      context = null
      cancel()
      state.value = empty()
    }
  }
}

function permitted(fact: EntityMetadataFact, now: number, shared: boolean) {
  return (
    !fact.usage ||
    (fact.usage.display &&
      fact.usage.cache &&
      (!shared || fact.usage.crossSource) &&
      (fact.usage.expiresAt === undefined || fact.usage.expiresAt > now))
  )
}

/** Personal overrides never become the biography or picture of a whole collection. */
export function artistDetailPresentation(
  detail: EntityMetadataDetail | null,
  shared: boolean,
  name: string,
  language: EntityMetadataLanguage,
  now: number
) {
  const confirmed = detail?.link?.state === 'confirmed'
  const facts = confirmed ? detail.facts.filter((fact) => permitted(fact, now, shared)) : []
  let introduction = detail?.introduction ?? null
  if (shared) {
    const texts = facts.filter((fact) => !fact.sourceProvider || fact.usage?.crossSource)
    const selected = selectMetadataIntroduction(texts, language, true)
    introduction = selected
      ? {
          value: selected.value,
          language: selected.language,
          origin: 'external',
          attribution: selected.attribution
        }
      : null
  } else if (
    introduction?.origin === 'external' &&
    !facts.some(
      (fact) =>
        fact.value === introduction?.value &&
        fact.attribution.provider === introduction.attribution?.provider &&
        fact.attribution.revision === introduction.attribution?.revision
    )
  )
    introduction = null
  const projected = detail
    ? { ...detail, facts, ...(shared ? { artworkOverride: null, manualArtwork: null } : {}) }
    : null
  return {
    ...artistIdentityPresentation(projected, { name }, now),
    introduction,
    country: facts.find((fact) => fact.field === 'country') ?? null,
    hiddenIntroduction: !shared && detail?.override?.mode === 'clear',
    hiddenImage: !shared && detail?.artworkOverride?.mode === 'clear'
  }
}
