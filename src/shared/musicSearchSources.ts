import type { TrackData as Track } from './track.ts'
import type { UnifiedSearchTrackItem } from './unifiedMusicSearch.ts'
import { getTrackSearchBlob, normalizeSearchText } from './trackSearchText.ts'
import type { LogicalTrackModel, SourceVariantInput } from './logicalTrackModel.ts'
import type { NetworkEntry } from './networkSources.ts'
import { versionSourceKey } from './trackSourceIdentity.ts'
import {
  prepareSearchFields,
  prepareSearchFieldsFromBlob,
  prepareSearchQuery,
  scorePreparedSearchRelevance,
  matchesPreparedSearch,
  SymSpellIndex,
  getMaxSymSpellTolerance,
  type PreparedSearchFields,
  type PreparedSearchQuery,
  type SearchPersonalSignals
} from './searchRelevance.ts'

export function extractTrackSearchSignals(track: Track): SearchPersonalSignals | undefined {
  const rec = track as unknown as Record<string, unknown>
  const fav = rec.favorite === true || rec.favorite === 1
  const banned = rec.banned === true || rec.banned === 1
  const playCount = typeof rec.playCount === 'number' ? rec.playCount : undefined
  const lastPlayed = typeof rec.lastPlayed === 'number' ? rec.lastPlayed : undefined
  if (!fav && !banned && playCount === undefined && lastPlayed === undefined) return undefined
  return { favorite: fav, banned, playCount, lastPlayed }
}

/** The existing ordering/index algorithm, with recording preferences injected. */
export function createUnifiedSearchSources(
  identity: LogicalTrackModel,
  preferenceRevision: () => number
) {
  const { compareSourceVariantPriority, preferredSourceKey, toSourceVariant } = identity
  type SearchIndexEntry = {
    item: UnifiedSearchTrackItem
    blob: string
    normFileName: string
    text: string
    fields: PreparedSearchFields | null
  }
  const localIndexes = new WeakMap<
    readonly Track[],
    { revision: number; entries: SearchIndexEntry[]; symSpell: SymSpellIndex | null }
  >()

  function toSearchItem(
    track: Track,
    options: Omit<SourceVariantInput, 'track'>
  ): UnifiedSearchTrackItem {
    return { kind: 'track', ...toSourceVariant({ track, ...options }) }
  }

  function compareSearchItems(left: UnifiedSearchTrackItem, right: UnifiedSearchTrackItem): number {
    return (
      compareSourceVariantPriority(left, right) ||
      left.track.title.localeCompare(right.track.title, 'zh') ||
      left.track.artist.localeCompare(right.track.artist, 'zh') ||
      left.track.id.localeCompare(right.track.id)
    )
  }

  function getEntryFields(entry: SearchIndexEntry): PreparedSearchFields {
    if (!entry.fields) {
      entry.fields = prepareSearchFieldsFromBlob(
        entry.blob,
        '\u0000',
        entry.item.track,
        entry.normFileName
      )
    }
    return entry.fields
  }

  function getSymSpell(
    tracks: readonly Track[],
    cached: { symSpell: SymSpellIndex | null }
  ): SymSpellIndex {
    if (!cached.symSpell) {
      const symSpell = new SymSpellIndex()
      for (const track of tracks) {
        symSpell.addTrack({
          title: (track.title ?? '').trim(),
          artist: (track.artist ?? '').trim(),
          album: (track.album ?? '').trim()
        })
      }
      cached.symSpell = symSpell
    }
    return cached.symSpell
  }

  function searchUnifiedLocalPage(
    tracks: readonly Track[],
    query: string,
    limit: number,
    offset: number
  ): { items: UnifiedSearchTrackItem[]; total: number } {
    let preparedQuery = prepareSearchQuery(query)
    if (!preparedQuery.fullNormalized) return { items: [], total: 0 }
    const revision = preferenceRevision()
    let cached = localIndexes.get(tracks)
    if (!cached || cached.revision !== revision) {
      const index: SearchIndexEntry[] = tracks.map((track) => {
        const blob = getTrackSearchBlob(track)
        const normFileName = normalizeSearchText(track.fileName)
        return {
          item: toSearchItem(track, { sourceName: '本地音乐', providerAvailable: true }),
          blob,
          normFileName,
          text: `${blob}\u0000${normFileName}`,
          fields: null
        }
      })
      index.sort((left, right) => compareSearchItems(left.item, right.item))
      cached = { revision, entries: index, symSpell: cached?.symSpell ?? null }
      localIndexes.set(tracks, cached)
    }

    const collectMatches = (pq: PreparedSearchQuery): SearchIndexEntry[] => {
      const matched: SearchIndexEntry[] = []
      if (!pq.isMultiToken) {
        const q = pq.fullNormalized
        for (const entry of cached!.entries) {
          if (entry.text.includes(q)) matched.push(entry)
        }
      } else {
        const tokens = pq.tokens
        for (const entry of cached!.entries) {
          if (tokens.every((token) => entry.text.includes(token))) matched.push(entry)
        }
      }
      return matched
    }

    let matchedEntries = collectMatches(preparedQuery)
    if (
      matchedEntries.length === 0 &&
      preparedQuery.tokens.some((token) => getMaxSymSpellTolerance(token) > 0)
    ) {
      const suggestion = getSymSpell(tracks, cached).suggestQuery(query)
      if (suggestion) {
        preparedQuery = prepareSearchQuery(suggestion.correctedQuery, suggestion.penaltyFactor)
        matchedEntries = collectMatches(preparedQuery)
      }
    }

    const total = matchedEntries.length
    if (total === 0) return { items: [], total: 0 }

    let firstPreferred: boolean | undefined
    let firstScore: number | undefined
    let allSameRank = true
    const scored: Array<{ entry: SearchIndexEntry; preferred: boolean; score: number }> =
      new Array(total)

    for (let i = 0; i < total; i++) {
      const entry = matchedEntries[i]
      const track = entry.item.track
      const preferred = preferredSourceKey(track) === versionSourceKey(track)
      const score = scorePreparedSearchRelevance(getEntryFields(entry), preparedQuery, {
        searchFileName: true,
        signals: extractTrackSearchSignals(track)
      }).total
      if (i === 0) {
        firstPreferred = preferred
        firstScore = score
      } else if (preferred !== firstPreferred || score !== firstScore) {
        allSameRank = false
      }
      scored[i] = { entry, preferred, score }
    }

    if (!allSameRank) {
      scored.sort(
        (left, right) =>
          Number(right.preferred) - Number(left.preferred) || right.score - left.score
      )
    }

    const end = Math.min(total, offset + limit)
    const items: UnifiedSearchTrackItem[] = []
    for (let i = offset; i < end; i++) {
      items.push(scored[i].entry.item)
    }
    return { items, total }
  }

  function searchUnifiedNetworkPage(
    entries: Array<{ profileName: string; entry: NetworkEntry }>,
    query: string,
    limit: number,
    offset: number
  ): { items: UnifiedSearchTrackItem[]; total: number } {
    let preparedQuery = prepareSearchQuery(query)
    const items: UnifiedSearchTrackItem[] = []
    if (!preparedQuery.fullNormalized || entries.length === 0) return { items, total: 0 }

    const matchesNetworkEntry = (
      profileName: string,
      entry: NetworkEntry,
      pq: PreparedSearchQuery
    ): boolean => {
      const metadata = entry.metadata
      if (!pq.isMultiToken) {
        const q = pq.fullNormalized
        return [metadata?.title, metadata?.artist, metadata?.album, entry.name].some(
          (value) => value && normalizeSearchText(value).includes(q)
        )
      }
      const fields = prepareSearchFields({
        title: metadata?.title ?? entry.name.replace(/\.[^.]+$/, ''),
        artist: metadata?.artist ?? profileName,
        album: metadata?.album ?? profileName,
        fileName: entry.name
      })
      return matchesPreparedSearch(fields, pq, true)
    }

    let matchedIndices: number[] = []
    for (let i = 0; i < entries.length; i++) {
      const { profileName, entry } = entries[i]
      if (matchesNetworkEntry(profileName, entry, preparedQuery)) {
        matchedIndices.push(i)
      }
    }

    if (
      matchedIndices.length === 0 &&
      preparedQuery.tokens.some((token) => getMaxSymSpellTolerance(token) > 0)
    ) {
      const symSpell = new SymSpellIndex()
      for (const { profileName, entry } of entries) {
        const metadata = entry.metadata
        symSpell.addTrack({
          title: metadata?.title ?? entry.name.replace(/\.[^.]+$/, ''),
          artist: metadata?.artist ?? profileName,
          album: metadata?.album ?? profileName
        })
      }
      const suggestion = symSpell.suggestQuery(query)
      if (suggestion) {
        preparedQuery = prepareSearchQuery(suggestion.correctedQuery, suggestion.penaltyFactor)
        matchedIndices = []
        for (let i = 0; i < entries.length; i++) {
          const { profileName, entry } = entries[i]
          if (matchesNetworkEntry(profileName, entry, preparedQuery)) {
            matchedIndices.push(i)
          }
        }
      }
    }

    const total = matchedIndices.length
    const end = Math.min(total, offset + limit)
    for (let i = offset; i < end; i++) {
      const { profileName, entry } = entries[matchedIndices[i]]
      const metadata = entry.metadata
      items.push(
        toSearchItem(
          {
            id: entry.id,
            title: metadata?.title ?? entry.name.replace(/\.[^.]+$/, ''),
            artist: metadata?.artist ?? profileName,
            album: metadata?.album ?? profileName,
            filePath: '',
            fileName: entry.name,
            duration: metadata?.duration ?? 0,
            size: entry.sizeBytes ?? 0,
            cover: null,
            lyrics: null,
            source: 'network',
            format: metadata?.format,
            networkSource: { profileId: entry.profileId, entry }
          },
          { sourceName: '网络源', providerAvailable: true }
        )
      )
    }
    return { items, total }
  }

  return { toSearchItem, compareSearchItems, searchUnifiedLocalPage, searchUnifiedNetworkPage }
}
export type UnifiedSearchSources = ReturnType<typeof createUnifiedSearchSources>
