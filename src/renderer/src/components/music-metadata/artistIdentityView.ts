import { shallowRef } from 'vue'
import type { CatalogPage, CatalogQuery } from '../../../../shared/musicCatalog.ts'
import type {
  EntityMetadataDetail,
  EntityMetadataLanguage
} from '../../../../shared/entityMetadata.ts'
import type { MusicIdentityDetail } from '../../../../shared/musicIdentification.ts'
import type { ArtistProfileChoice } from './artistProfileChoice.ts'

/** Retain recently resolved card metadata across virtual-grid unmounts. */
export function createArtistIdentityCache(now = Date.now) {
  const entries = new Map<
    string,
    { detail: EntityMetadataDetail | null; bytes: number; createdAt: number }
  >()
  let bytes = 0
  return {
    get(key: string): EntityMetadataDetail | null | undefined {
      const entry = entries.get(key)
      if (!entry) return undefined
      entries.delete(key)
      // Remote image grants expire after 24 idle hours; do not pin their handles
      // indefinitely in a renderer that stays open across days.
      if (now() - entry.createdAt >= 60 * 60 * 1000) {
        bytes -= entry.bytes
        return undefined
      }
      entries.set(key, entry)
      return entry.detail
    },
    set(key: string, detail: EntityMetadataDetail | null) {
      bytes -= entries.get(key)?.bytes ?? 0
      entries.delete(key)
      const size =
        ((detail?.manualArtwork?.dataUrl.length ?? 0) +
          (detail?.artwork ?? []).reduce((total, image) => total + image.handle.length, 0)) *
        2
      if (size > 16 * 1024 * 1024) return
      entries.set(key, { detail, bytes: size, createdAt: now() })
      bytes += size
      while (entries.size > 256 || bytes > 16 * 1024 * 1024) {
        const oldest = entries.keys().next().value!
        bytes -= entries.get(oldest)!.bytes
        entries.delete(oldest)
      }
    }
  }
}

const cardCaches = new WeakMap<object, ReturnType<typeof createArtistIdentityCache>>()
export function artistIdentityCache(owner: object) {
  let cache = cardCaches.get(owner)
  if (!cache) {
    cache = createArtistIdentityCache()
    cardCaches.set(owner, cache)
  }
  return cache
}

/** Card data comes from exact collection membership, not a same-name online search. */
export function createArtistIdentityView(api: {
  catalog(query: CatalogQuery, signal: AbortSignal): Promise<CatalogPage>
  detail(
    id: string,
    language: EntityMetadataLanguage,
    signal: AbortSignal,
    shared: boolean
  ): Promise<EntityMetadataDetail>
  identity?(id: string, signal: AbortSignal): Promise<MusicIdentityDetail>
  choice?(name: string): ArtistProfileChoice | null
  cache?: ReturnType<typeof createArtistIdentityCache>
  cacheScope?(): string
}) {
  const detail = shallowRef<EntityMetadataDetail | null>(null)
  let context: { name: string; language: EntityMetadataLanguage } | null = null
  let request: AbortController | null = null
  let pending = false,
    disposed = false
  const cacheKey = (value: NonNullable<typeof context>) =>
    JSON.stringify([api.cacheScope?.(), value.name, value.language, api.choice?.(value.name)])
  async function refresh(): Promise<void> {
    if (!context || disposed) return
    if (request) {
      pending = true
      return
    }
    const current = new AbortController(),
      expected = context,
      key = cacheKey(expected)
    request = current
    const publish = (result: EntityMetadataDetail | null) => {
      if (disposed || request !== current || key !== cacheKey(expected)) return
      detail.value = result
      api.cache?.set(key, result)
    }
    try {
      let page = await api.catalog(
        {
          kind: 'artist',
          source: 'local',
          artistName: expected.name,
          limit: 200,
          context: { type: 'collection', collection: 'artists', id: expected.name }
        },
        current.signal
      )
      const total = page.total,
        firstId = page.items[0]?.id,
        revision = page.revision
      const choice = api.choice?.(expected.name)
      if (choice) {
        let chosen = false,
          offset = 0
        while (page.items.length) {
          if (page.items.some((item) => item.id === choice.entityId)) {
            chosen = true
            break
          }
          offset += page.items.length
          if (offset >= total) break
          page = await api.catalog(
            {
              kind: 'artist',
              source: 'local',
              artistName: expected.name,
              limit: 200,
              offset,
              revision,
              context: { type: 'collection', collection: 'artists', id: expected.name }
            },
            current.signal
          )
          if (page.total !== total || page.revision !== revision) break
        }
        const selected = chosen
          ? await api.detail(choice.entityId, expected.language, current.signal, false)
          : null
        const result =
          selected?.targetId === choice.targetId &&
          (choice.targetId === null || selected?.link?.state === 'confirmed')
            ? selected
            : null
        publish(result)
        return
      }
      let targetId: string | null = null,
        count = 0,
        consistent = total > 0
      // Local performers are source-scoped. Multiple songs can share a card
      // only after every member confirms the same target; never pick a homonym.
      if (total > 1 && api.identity) {
        while (consistent && page.items.length) {
          for (const entity of page.items) {
            const identity = await api.identity(entity.id, current.signal)
            if (
              identity.link?.state !== 'confirmed' ||
              !identity.link.targetId ||
              (targetId && identity.link.targetId !== targetId)
            ) {
              consistent = false
              break
            }
            targetId = identity.link.targetId
            count++
          }
          if (!consistent || count >= total) break
          page = await api.catalog(
            {
              kind: 'artist',
              source: 'local',
              artistName: expected.name,
              limit: 200,
              offset: count,
              revision,
              context: { type: 'collection', collection: 'artists', id: expected.name }
            },
            current.signal
          )
          if (page.total !== total || page.revision !== revision) consistent = false
        }
        consistent &&= count === total
      } else consistent &&= total === 1 && page.items.length === 1
      let result =
        consistent && firstId
          ? await api.detail(firstId, expected.language, current.signal, total > 1)
          : null
      if (result && targetId && result.targetId !== targetId) result = null
      // A personal choice belongs to its selected source entity, not all other
      // same-target sources in this collection.
      if (result && total > 1) result = { ...result, artworkOverride: null, manualArtwork: null }
      publish(result)
    } catch {
      if (!disposed && request === current) detail.value = null
    } finally {
      if (request === current) {
        request = null
        if (pending) {
          pending = false
          void refresh()
        }
      }
    }
  }
  return {
    detail,
    refresh,
    setContext(name: string | null, language: EntityMetadataLanguage) {
      request?.abort()
      request = null
      pending = false
      detail.value = null
      context = name ? { name, language } : null
      const cached = context ? api.cache?.get(cacheKey(context)) : undefined
      if (cached !== undefined) {
        detail.value = cached
        return Promise.resolve()
      }
      return refresh()
    },
    dispose() {
      disposed = true
      context = null
      request?.abort()
      request = null
      detail.value = null
    }
  }
}

/** Never replace file tags or collection keys with a normalized display name. */
export function artistIdentityPresentation(
  detail: EntityMetadataDetail | null,
  fallback: { name: string; cover?: string | null },
  now: number
) {
  const valid = detail?.link?.state === 'confirmed'
  const name = valid
    ? detail.facts.find(
        (f) =>
          f.field === 'name' &&
          (!f.usage ||
            (f.usage.display &&
              f.usage.cache &&
              f.usage.crossSource &&
              (f.usage.expiresAt === undefined || f.usage.expiresAt > now)))
      )?.value
    : null
  const image = valid
    ? detail.artwork?.find(
        (a) =>
          a.scope === 'artist' &&
          a.usage.display &&
          a.usage.cache &&
          a.usage.crossSource &&
          (a.usage.expiresAt === undefined || a.usage.expiresAt > now)
      )
    : null
  const cover = detail?.artworkOverride
    ? detail.artworkOverride.mode === 'clear'
      ? null
      : (detail.manualArtwork?.dataUrl ?? null)
    : (image?.handle ?? null)
  return {
    name: name || fallback.name,
    cover,
    attribution: !detail?.artworkOverride && image ? image.attribution : null
  }
}
