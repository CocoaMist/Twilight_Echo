import type {
  MusicTag,
  MusicTagMember,
  MusicTagRecording,
  MusicTagsToken
} from '../../../../shared/musicTags.ts'
import type { MusicTagsApi } from './musicTagsView.ts'

export function tagsFixture(count = 2) {
  let token: MusicTagsToken = {
    tagsRevision: 1,
    catalogRevision: 1,
    contentRevision: 1,
    linkRevision: 0
  }
  const tags: MusicTag[] = Array.from({ length: count }, (_, index) => ({
    id: `tag-${index + 1}`,
    name: `标签 ${index + 1}`,
    nameRevision: 1,
    membersRevision: 1,
    memberCount: 0,
    updatedAt: 100
  }))
  const references = new Map<string, MusicTagMember[]>(),
    recordings = new Map<string, MusicTagRecording[]>()
  const queries: Array<{ name: string; query: any; signal: AbortSignal }> = [],
    writes: Array<{ name: string; query: any }> = []
  let failWrite: unknown = null
  let changed: (token: MusicTagsToken) => void = () => {}
  const tag = (id: string) => {
    const result = tags.find((item) => item.id === id)
    if (!result) throw new Error('标签已不存在，请刷新后重试')
    return { ...result, memberCount: references.get(id)?.length ?? 0 }
  }
  function bump() {
    token = { ...token, tagsRevision: token.tagsRevision + 1 }
    changed(token)
  }
  function query(name: string, input: any, signal: AbortSignal) {
    queries.push({ name, query: structuredClone(input), signal })
    if (input.token && JSON.stringify(input.token) !== JSON.stringify(token))
      throw Object.assign(new Error('stale'), { code: 'STALE_REVISION' })
    signal.throwIfAborted()
  }
  function page<T>(items: T[], input: { offset?: number; limit?: number }) {
    const offset = input.offset ?? 0
    return {
      token: { ...token },
      offset,
      total: items.length,
      items: items.slice(offset, offset + (input.limit ?? 12))
    }
  }
  function write(name: string, input: any) {
    writes.push({ name, query: structuredClone(input) })
    if (failWrite) {
      const error = failWrite
      failWrite = null
      throw error
    }
  }
  const api: MusicTagsApi = {
    async entity(input, signal) {
      query('tags.entity', input, signal)
      return {
        ...page(
          tags
            .filter((item) => references.get(item.id)?.some((ref) => ref.id === input.entityId))
            .map((item) => tag(item.id)),
          input
        ),
        entityId: input.entityId
      }
    },
    async list(input, signal) {
      query('tags.list', input, signal)
      return page(
        tags.map((item) => tag(item.id)),
        input
      )
    },
    async members(input, signal) {
      query('tags.members', input, signal)
      return { ...page(references.get(input.tagId) ?? [], input), tag: tag(input.tagId) }
    },
    async recordings(input, signal) {
      query('tags.recordings', input, signal)
      return { ...page(recordings.get(input.tagId) ?? [], input), tag: tag(input.tagId) }
    },
    async create(input) {
      write('tags.create', input)
      if (input.tagsRevision !== token.tagsRevision)
        throw Object.assign(new Error('stale'), { code: 'STALE_REVISION' })
      tags.unshift({
        id: `created-${tags.length + 1}`,
        name: input.name.trim(),
        nameRevision: 1,
        membersRevision: 0,
        memberCount: 0,
        updatedAt: 200
      })
      bump()
      return { token: { ...token }, tag: tag(tags[0].id) }
    },
    async rename(input) {
      write('tags.rename', input)
      const item = tags.find((item) => item.id === input.tagId)!
      if (input.nameRevision !== item.nameRevision)
        throw Object.assign(new Error('stale'), { code: 'STALE_REVISION' })
      item.name = input.name
      item.nameRevision++
      bump()
      return { token: { ...token }, tag: tag(item.id) }
    },
    async delete(input) {
      write('tags.delete', input)
      const item = tag(input.tagId)
      if (
        input.nameRevision !== item.nameRevision ||
        input.membersRevision !== item.membersRevision
      )
        throw Object.assign(new Error('stale'), { code: 'STALE_REVISION' })
      tags.splice(
        tags.findIndex((tag) => tag.id === input.tagId),
        1
      )
      references.delete(input.tagId)
      bump()
      return { token: { ...token }, deletedId: input.tagId }
    },
    async memberSet(input) {
      write('tags.member.set', input)
      const item = tags.find((item) => item.id === input.tagId)!
      if (input.membersRevision !== item.membersRevision)
        throw Object.assign(new Error('stale'), { code: 'STALE_REVISION' })
      const previous = references.get(item.id) ?? []
      references.set(
        item.id,
        input.present
          ? previous.some((ref) => ref.id === input.entityId)
            ? previous
            : [
                ...previous,
                {
                  id: input.entityId,
                  kind: 'recording',
                  title: '当前歌曲',
                  artist: '本地艺人',
                  inLibrary: false,
                  sourceCount: 0
                }
              ]
          : previous.filter((ref) => ref.id !== input.entityId)
      )
      item.membersRevision++
      bump()
      return { token: { ...token }, tag: tag(item.id) }
    },
    async play(input, signal) {
      query('tags.play', input, signal)
      writes.push({ name: 'tags.play', query: structuredClone(input) })
      const items = recordings.get(input.tagId) ?? []
      return {
        total: items.length,
        selectedIndex: Math.max(
          0,
          items.findIndex((item) => item.sourceId === input.sourceId)
        )
      }
    }
  }
  return {
    api,
    tags,
    tag,
    references,
    recordings,
    queries,
    writes,
    token: () => ({ ...token }),
    failWrite(error: unknown) {
      failWrite = error
    },
    onChanged(listener: (token: MusicTagsToken) => void) {
      changed = listener
    },
    bump
  }
}
