import type {
  MusicFocusItem,
  MusicFocusSaved,
  MusicFocusPlayStatus,
  MusicFocusToken
} from '../../../../shared/musicFocus.ts'
import type { MusicFocusApi } from './musicFocusView.ts'

export function focusFixture(count = 23, savedCount = 12) {
  let token: MusicFocusToken = {
    savedRevision: 1,
    catalogRevision: 1,
    contentRevision: 1,
    genresRevision: 1,
    metadataRevision: 1,
    ratingsRevision: 1,
    preferencesRevision: 1,
    tagsRevision: 1,
    linkRevision: 0,
    historyRevision: 1,
    queryKey: 'one',
    asOf: 100,
    contextKey: 'local',
    expiresAt: null
  }
  const saved: MusicFocusSaved[] = Array.from({ length: savedCount }, (_, i) => ({
    id: `saved-${i}`,
    name: `查询 ${i + 1}`,
    nameRevision: 1,
    queryRevision: 1,
    updatedAt: 100,
    query: { version: 1, entity: 'recording', scope: 'library', where: { notPlayedWithinDays: 90 } }
  }))
  const items: MusicFocusItem[] = Array.from({ length: count }, (_, i) => ({
    id: `recording-${i}`,
    kind: 'recording',
    title: `曲目 ${i + 1}`,
    artist: '艺人',
    sourceCount: 1,
    inLibrary: true,
    playable: true,
    sourceId: `source-${i}`,
    provider: 'local',
    personalRating: i % 2 ? 4 : null,
    lastPlayed: null,
    releaseYear: 2000 + i
  }))
  const queries: Array<{ name: string; query: any; signal: AbortSignal }> = [],
    writes: Array<{ name: string; query: any }> = [],
    playRequests: Array<{ requestId: string; signal: AbortSignal }> = []
  let playStatus: MusicFocusPlayStatus = { status: 'not_committed' }
  let writeError: unknown = null,
    readError: unknown = null,
    playError: unknown = null
  let onChanged = (_revision: number) => {}
  const copy = <T>(value: T): T => structuredClone(value)
  function query(name: string, input: any, signal: AbortSignal) {
    queries.push({ name, query: copy(input), signal })
    signal.throwIfAborted()
    if (readError) {
      const error = readError
      readError = null
      throw error
    }
    if (input.token && input.token.catalogRevision !== token.catalogRevision)
      throw Object.assign(new Error('stale'), { code: 'STALE_REVISION' })
  }
  function page<T>(array: T[], input: { offset?: number; limit?: number }) {
    const offset = input.offset ?? 0
    return {
      offset,
      total: array.length,
      items: copy(array.slice(offset, offset + (input.limit ?? 20)))
    }
  }
  function write(name: string, input: any) {
    writes.push({ name, query: copy(input) })
    if (writeError) {
      const error = writeError
      writeError = null
      throw error
    }
  }
  function changed() {
    token = { ...token, savedRevision: token.savedRevision + 1 }
    onChanged(token.savedRevision)
  }
  function item(id: string) {
    const found = saved.find((item) => item.id === id)
    if (!found) throw new Error('目标不存在')
    return found
  }
  const api: MusicFocusApi = {
    now: () => 100,
    async query(input, signal) {
      query('focus.query', input, signal)
      const current = { ...token, queryKey: JSON.stringify(input.query) }
      return {
        ...page(
          items.map((item) => ({
            ...item,
            kind: input.query.entity,
            ...(input.query.scope === 'catalog'
              ? { playable: false, inLibrary: false, sourceId: null }
              : {})
          })),
          input
        ),
        token: current
      }
    },
    async facets(input, signal) {
      query('focus.facets', input, signal)
      return {
        ...page([{ value: 'local', label: '本地', count: items.length }], input),
        token: copy(input.token ?? token),
        facet: input.facet
      }
    },
    async saved(input, signal) {
      query('focus.saved.list', input, signal)
      if (input.savedRevision != null && input.savedRevision !== token.savedRevision)
        throw Object.assign(new Error('stale'), { code: 'STALE_REVISION' })
      return {
        ...page(
          saved.filter((item) => item.name.includes(input.search ?? '')),
          input
        ),
        savedRevision: token.savedRevision
      }
    },
    async create(input) {
      write('focus.saved.create', input)
      assertRevision(input.savedRevision, token.savedRevision)
      const result: MusicFocusSaved = {
        id: `created-${saved.length}`,
        name: input.name,
        query: copy(input.query),
        nameRevision: 1,
        queryRevision: 1,
        updatedAt: 200
      }
      saved.unshift(result)
      changed()
      return { savedRevision: token.savedRevision, item: copy(result) }
    },
    async rename(input) {
      write('focus.saved.rename', input)
      const target = item(input.id)
      assertRevision(input.nameRevision, target.nameRevision)
      target.name = input.name
      target.nameRevision++
      changed()
      return { savedRevision: token.savedRevision, item: copy(target) }
    },
    async update(input) {
      write('focus.saved.update', input)
      const target = item(input.id)
      assertRevision(input.queryRevision, target.queryRevision)
      target.query = copy(input.query)
      target.queryRevision++
      changed()
      return { savedRevision: token.savedRevision, item: copy(target) }
    },
    async delete(input) {
      write('focus.saved.delete', input)
      const target = item(input.id)
      assertRevision(input.nameRevision, target.nameRevision)
      assertRevision(input.queryRevision, target.queryRevision)
      saved.splice(saved.indexOf(target), 1)
      changed()
      return { savedRevision: token.savedRevision, deletedId: input.id }
    },
    async play(input, signal, requestId) {
      query('focus.play', input, signal)
      write('focus.play', input)
      playRequests.push({ requestId, signal })
      if (playError) {
        const error = playError
        playError = null
        throw error
      }
      return {
        total: items.length,
        selectedIndex: Math.max(
          0,
          items.findIndex((item) => item.sourceId === input.sourceId)
        )
      }
    },
    async playStatus(input, signal) {
      query('focus.play.status', input, signal)
      return copy(playStatus)
    },
    async genres(input, signal) {
      query('genres.tree', input, signal)
      return {
        ...page(
          Array.from({ length: 22 }, (_, i) => ({
            id: `genre-${i}`,
            name: `流派 ${i + 1}`,
            nameEn: `Genre ${i}`,
            parentId: null,
            ancestorIds: [],
            childCount: i === 0 ? 1 : 0,
            dictionaryVersion: 1,
            userModified: false
          })),
          input
        ),
        revision: 1,
        dictionaryVersion: 1
      }
    },
    async tags(input, signal) {
      query('tags.list', input, signal)
      return {
        ...page(
          [
            {
              id: 'tag-1',
              name: '夜间',
              nameRevision: 1,
              membersRevision: 1,
              memberCount: 1,
              updatedAt: 1
            }
          ],
          input
        ),
        token: { tagsRevision: 1, catalogRevision: 1, contentRevision: 1, linkRevision: 0 }
      }
    }
  }
  return {
    api,
    playRequests,
    items,
    saved,
    queries,
    writes,
    token: () => copy(token),
    setToken(value: Partial<MusicFocusToken>) {
      token = { ...token, ...value }
    },
    failWrite(error: unknown) {
      writeError = error
    },
    failRead(error: unknown) {
      readError = error
    },
    failPlay(error: unknown) {
      playError = error
    },
    setPlayStatus(status: MusicFocusPlayStatus) {
      playStatus = status
    },
    onChanged(callback: (revision: number) => void) {
      onChanged = callback
    }
  }
}
function assertRevision(actual: number, expected: number) {
  if (actual !== expected) throw Object.assign(new Error('stale'), { code: 'STALE_REVISION' })
}
