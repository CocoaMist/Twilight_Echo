import { computed, shallowRef, watch } from 'vue'
import {
  validMusicTagName,
  type MusicTag,
  type MusicTagsCreate,
  type MusicTagsDelete,
  type MusicTagsEntityPage,
  type MusicTagsEntityQuery,
  type MusicTagsListPage,
  type MusicTagsListQuery,
  type MusicTagsMemberSet,
  type MusicTagsMembersPage,
  type MusicTagsMembersQuery,
  type MusicTagsPlay,
  type MusicTagsPlayResult,
  type MusicTagsRecordingsPage,
  type MusicTagsRename,
  type MusicTagsToken
} from '../../../../shared/musicTags.ts'

export const MUSIC_TAGS_PAGE_SIZE = 12
export interface MusicTagsApi {
  entity(query: MusicTagsEntityQuery, signal: AbortSignal): Promise<MusicTagsEntityPage>
  list(query: MusicTagsListQuery, signal: AbortSignal): Promise<MusicTagsListPage>
  members(query: MusicTagsMembersQuery, signal: AbortSignal): Promise<MusicTagsMembersPage>
  recordings(query: MusicTagsMembersQuery, signal: AbortSignal): Promise<MusicTagsRecordingsPage>
  create(query: MusicTagsCreate): Promise<unknown>
  rename(query: MusicTagsRename): Promise<unknown>
  delete(query: MusicTagsDelete): Promise<unknown>
  memberSet(query: MusicTagsMemberSet): Promise<unknown>
  play(query: MusicTagsPlay, signal: AbortSignal): Promise<MusicTagsPlayResult>
}
export type TagIntent =
  | { kind: 'create'; name: string }
  | { kind: 'rename'; tagId: string; name: string }
  | { kind: 'delete'; tagId: string; name: string }
  | { kind: 'member'; tagId: string; name: string; entityId: string; present: boolean }
interface State {
  token: MusicTagsToken | null
  entity: MusicTagsEntityPage | null
  list: MusicTagsListPage | null
  members: MusicTagsMembersPage | null
  recordings: MusicTagsRecordingsPage | null
  selectedId: string | null
  selectedName: string
  intentTag: MusicTag | null
  opened: boolean
  loading: boolean
  saving: boolean
  blocked: boolean
  error: string
  notice: string
  createName: string
  renameName: string
  renameId: string | null
  deleteTag: MusicTag | null
  intent: TagIntent | null
  playing: boolean
  playError: string
  playNotice: string
}
const empty = (): State => ({
  token: null,
  entity: null,
  list: null,
  members: null,
  recordings: null,
  selectedId: null,
  selectedName: '',
  intentTag: null,
  opened: false,
  loading: false,
  saving: false,
  blocked: false,
  error: '',
  notice: '',
  createName: '',
  renameName: '',
  renameId: null,
  deleteTag: null,
  intent: null,
  playing: false,
  playError: '',
  playNotice: ''
})
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const stale = (error: unknown) => (error as { code?: string })?.code === 'STALE_REVISION'
const sameToken = (a: MusicTagsToken, b: MusicTagsToken) =>
  (Object.keys(a) as Array<keyof MusicTagsToken>).every((key) => a[key] === b[key])
export const tagIntentLabel = (intent: TagIntent) =>
  intent.kind === 'create'
    ? `创建“${intent.name}”`
    : intent.kind === 'rename'
      ? `重命名为“${intent.name}”`
      : intent.kind === 'delete'
        ? `删除“${intent.name}”`
        : `${intent.present ? '加入' : '移出'}“${intent.name}”`

/** A failed write is retained as intent; only an explicit save after rereading may send it again. */
export function createMusicTagsView(api: MusicTagsApi) {
  const state = shallowRef<State>(empty())
  const ready = computed(
    () => !!state.value.token && !state.value.loading && !state.value.saving && !state.value.blocked
  )
  let entityId: string | null = null,
    scope = '',
    disposed = false,
    generation = 0
  let contextInitialized = false
  let reading: AbortController | null = null,
    playing: AbortController | null = null
  function abortReads() {
    reading?.abort()
    reading = null
  }
  function cancelPlay() {
    const wasPlaying = !!playing
    playing?.abort()
    playing = null
    if (wasPlaying)
      state.value = {
        ...state.value,
        playing: false,
        playNotice: '已取消准备；若播放已经开始，请核对当前队列，不要重复点击。'
      }
  }
  function invalidate(epoch = false) {
    if (disposed || !contextInitialized) return
    if (epoch) generation++
    abortReads()
    cancelPlay()
    state.value = {
      ...state.value,
      token: null,
      entity: null,
      list: null,
      members: null,
      recordings: null,
      intentTag: null,
      deleteTag: null,
      loading: false,
      saving: epoch ? false : state.value.saving,
      blocked: true,
      error: '',
      notice: ''
    }
  }
  function currentTag(id: string) {
    return (
      [
        state.value.intentTag,
        state.value.members?.tag,
        state.value.recordings?.tag,
        ...(state.value.entity?.items ?? []),
        ...(state.value.list?.items ?? [])
      ].find((tag) => tag?.id === id) ?? null
    )
  }
  const canSaveIntent = computed(
    () =>
      ready.value &&
      !!state.value.intent &&
      (state.value.intent.kind === 'create' || !!currentTag(state.value.intent.tagId))
  )
  async function read(
    options: {
      fresh?: boolean
      entityOffset?: number
      listOffset?: number
      membersOffset?: number
      recordingsOffset?: number
    } = {}
  ) {
    if (
      disposed ||
      !contextInitialized ||
      state.value.saving ||
      (state.value.blocked && !options.fresh)
    )
      return
    abortReads()
    cancelPlay()
    const request = new AbortController(),
      turn = generation
    reading = request
    const old = state.value
    state.value = {
      ...old,
      loading: true,
      error: '',
      blocked: false,
      ...(options.fresh
        ? {
            token: null,
            entity: null,
            list: null,
            members: null,
            recordings: null,
            intentTag: null
          }
        : {})
    }
    const active = () => !disposed && reading === request && turn === generation
    const accept = (token: MusicTagsToken, expected: MusicTagsToken) => {
      if (!sameToken(token, expected))
        throw Object.assign(new Error('标签快照已变化'), { code: 'STALE_REVISION' })
    }
    try {
      const token = options.fresh ? undefined : (old.token ?? undefined)
      let entity: MusicTagsEntityPage | null = null,
        list: MusicTagsListPage | null = null,
        members: MusicTagsMembersPage | null = null,
        recordings: MusicTagsRecordingsPage | null = null,
        intentTag: MusicTag | null = null
      if (entityId) {
        entity = await api.entity(
          {
            entityId,
            offset: options.entityOffset ?? old.entity?.offset ?? 0,
            limit: MUSIC_TAGS_PAGE_SIZE,
            ...(token ? { token } : {})
          },
          request.signal
        )
        if (!active()) return
        if (token) accept(entity.token, token)
      }
      if (!entityId || state.value.opened) {
        list = await api.list(
          {
            offset: options.listOffset ?? old.list?.offset ?? 0,
            limit: MUSIC_TAGS_PAGE_SIZE,
            ...(entity ? { token: entity.token } : token ? { token } : {})
          },
          request.signal
        )
        if (!active()) return
        if (entity || token) accept(list.token, entity?.token ?? token!)
      }
      const currentToken = (entity ?? list)!.token
      if (state.value.selectedId) {
        const query = {
          tagId: state.value.selectedId,
          token: currentToken,
          limit: MUSIC_TAGS_PAGE_SIZE
        }
        ;[members, recordings] = await Promise.all([
          api.members(
            { ...query, offset: options.membersOffset ?? old.members?.offset ?? 0 },
            request.signal
          ),
          api.recordings(
            { ...query, offset: options.recordingsOffset ?? old.recordings?.offset ?? 0 },
            request.signal
          )
        ])
        if (!active()) return
        accept(members.token, currentToken)
        accept(recordings.token, currentToken)
      }
      const intent = state.value.intent
      if (intent && intent.kind !== 'create') {
        intentTag =
          [members?.tag, ...(entity?.items ?? []), ...(list?.items ?? [])].find(
            (tag) => tag?.id === intent.tagId
          ) ?? null
        if (!intentTag) {
          const page = await api.members(
            { tagId: intent.tagId, token: currentToken, limit: 1 },
            request.signal
          )
          if (!active()) return
          accept(page.token, currentToken)
          intentTag = page.tag
        }
      }
      if (!active()) return
      state.value = {
        ...state.value,
        token: currentToken,
        entity,
        list,
        members,
        recordings,
        intentTag,
        selectedName: members?.tag.name ?? state.value.selectedName,
        loading: false
      }
    } catch (error) {
      if (!active()) return
      if (stale(error)) invalidate()
      else
        state.value = {
          ...state.value,
          token: null,
          entity: null,
          list: null,
          members: null,
          recordings: null,
          loading: false,
          blocked: true,
          error: `标签读取失败：${message(error)}`
        }
    }
  }
  async function saveIntent() {
    if (!canSaveIntent.value || !state.value.intent) return
    const intent = state.value.intent,
      turn = generation
    const tag = intent.kind === 'create' ? null : currentTag(intent.tagId)
    abortReads()
    cancelPlay()
    state.value = { ...state.value, saving: true, error: '', notice: '', deleteTag: null }
    try {
      if (intent.kind === 'create')
        await api.create({
          name: intent.name,
          tagsRevision: state.value.token!.tagsRevision
        })
      else if (intent.kind === 'rename')
        await api.rename({
          tagId: intent.tagId,
          name: intent.name,
          nameRevision: tag!.nameRevision
        })
      else if (intent.kind === 'delete')
        await api.delete({
          tagId: intent.tagId,
          nameRevision: tag!.nameRevision,
          membersRevision: tag!.membersRevision
        })
      else
        await api.memberSet({
          tagId: intent.tagId,
          entityId: intent.entityId,
          present: intent.present,
          membersRevision: tag!.membersRevision
        })
      if (disposed || turn !== generation) return
      state.value = {
        ...state.value,
        saving: false,
        intent: null,
        intentTag: null,
        createName: intent.kind === 'create' ? '' : state.value.createName,
        renameId: null,
        renameName: '',
        ...(intent.kind === 'delete' && state.value.selectedId === intent.tagId
          ? { selectedId: null, selectedName: '', members: null, recordings: null }
          : {})
      }
      await read({
        fresh: true,
        entityOffset: 0,
        listOffset: 0,
        membersOffset: 0,
        recordingsOffset: 0
      })
      if (disposed || turn !== generation) return
      state.value = {
        ...state.value,
        notice: state.value.token ? '标签已保存' : '操作已提交，请重新读取核对。'
      }
    } catch (error) {
      if (disposed || turn !== generation) return
      state.value = {
        ...state.value,
        token: null,
        saving: false,
        entity: null,
        list: null,
        members: null,
        recordings: null,
        intentTag: null,
        blocked: true,
        error: stale(error)
          ? '标签已变化，操作已保留，请重新读取核对。'
          : `保存结果未确认：${message(error)}。操作已保留，请重新读取核对。`
      }
    }
  }
  function perform(intent: TagIntent) {
    if (!ready.value) return Promise.resolve()
    state.value = { ...state.value, intent, notice: '' }
    return saveIntent()
  }
  async function play(sourceId?: string) {
    if (!ready.value || !state.value.recordings?.total || !state.value.selectedId || playing) return
    const tagId = state.value.selectedId,
      token = state.value.recordings.token
    const request = new AbortController(),
      turn = generation
    playing = request
    state.value = { ...state.value, playing: true, playError: '', playNotice: '' }
    try {
      const result = await api.play(
        {
          tagId,
          token,
          ...(sourceId ? { sourceId } : {})
        },
        request.signal
      )
      if (disposed || playing !== request || turn !== generation) return
      state.value = {
        ...state.value,
        playing: false,
        playNotice: `已播放标签集合：${result.total} 首，从第 ${result.selectedIndex + 1} 首开始。`
      }
      playing = null
    } catch (error) {
      if (disposed || playing !== request || turn !== generation) return
      playing = null
      state.value = {
        ...state.value,
        playing: false,
        playError: stale(error)
          ? '标签或曲库已变化，请重新读取后再播放。'
          : `播放结果未确认：${message(error)}。请核对当前队列后再决定是否播放。`
      }
      if (stale(error)) invalidate()
    }
  }
  return {
    state,
    ready,
    canSaveIntent,
    refresh: () => read({ fresh: true }),
    saveIntent,
    play,
    cancelPlay,
    invalidate,
    entityPage: (offset: number) => read({ entityOffset: offset }),
    listPage: (offset: number) => read({ listOffset: offset }),
    membersPage: (offset: number) => read({ membersOffset: offset }),
    recordingsPage: (offset: number) => read({ recordingsOffset: offset }),
    toggleManager() {
      state.value = { ...state.value, opened: !state.value.opened }
      if (state.value.opened && ready.value) return read()
      return Promise.resolve()
    },
    closeSelection() {
      if (state.value.saving) return
      cancelPlay()
      state.value = {
        ...state.value,
        selectedId: null,
        selectedName: '',
        members: null,
        recordings: null,
        playError: '',
        playNotice: ''
      }
    },
    select(tag: MusicTag) {
      if (!ready.value) return Promise.resolve()
      state.value = {
        ...state.value,
        selectedId: tag.id,
        selectedName: tag.name,
        members: null,
        recordings: null,
        renameId: null,
        deleteTag: null,
        playError: '',
        playNotice: ''
      }
      return read({ membersOffset: 0, recordingsOffset: 0 })
    },
    setCreateName(name: string) {
      state.value = { ...state.value, createName: name }
    },
    create() {
      return validMusicTagName(state.value.createName)
        ? perform({ kind: 'create', name: state.value.createName })
        : Promise.resolve()
    },
    startRename(tag: MusicTag) {
      if (ready.value)
        state.value = { ...state.value, renameId: tag.id, renameName: tag.name, deleteTag: null }
    },
    setRenameName(name: string) {
      state.value = { ...state.value, renameName: name }
    },
    rename() {
      return state.value.renameId && validMusicTagName(state.value.renameName)
        ? perform({ kind: 'rename', tagId: state.value.renameId, name: state.value.renameName })
        : Promise.resolve()
    },
    cancelRename() {
      if (!state.value.saving) state.value = { ...state.value, renameId: null, renameName: '' }
    },
    requestDelete(tag: MusicTag) {
      if (ready.value) state.value = { ...state.value, deleteTag: tag, renameId: null }
    },
    cancelDelete() {
      if (!state.value.saving) state.value = { ...state.value, deleteTag: null }
    },
    confirmDelete() {
      const tag = state.value.deleteTag
      return tag ? perform({ kind: 'delete', tagId: tag.id, name: tag.name }) : Promise.resolve()
    },
    member(tag: MusicTag, present: boolean, memberEntityId = entityId) {
      return memberEntityId
        ? perform({
            kind: 'member',
            tagId: tag.id,
            name: tag.name,
            entityId: memberEntityId,
            present
          })
        : Promise.resolve()
    },
    discardIntent() {
      if (!state.value.saving) state.value = { ...state.value, intent: null, intentTag: null }
    },
    setContext(id: string | null, nextScope: string) {
      if (disposed || (contextInitialized && id === entityId && scope === nextScope))
        return Promise.resolve()
      contextInitialized = true
      generation++
      abortReads()
      cancelPlay()
      entityId = id
      scope = nextScope
      state.value = empty()
      return read({ fresh: true })
    },
    dispose() {
      disposed = true
      generation++
      abortReads()
      cancelPlay()
    }
  }
}
export function observeMusicTagsView(
  view: ReturnType<typeof createMusicTagsView>,
  input: {
    entityId(): string | null
    scope(): string
    snapshot(): {
      epoch: string
      tagsRevision?: number | null
      catalogRevision?: number | null
      libraryRevision?: number | null
      tagsLinkRevision?: number | null
    } | null
  }
) {
  let initialized = false
  const known = Array<boolean>(7).fill(false)
  return watch(
    [
      () => input.entityId(),
      () => input.scope(),
      () => input.snapshot()?.epoch,
      () => input.snapshot()?.tagsRevision,
      () => input.snapshot()?.catalogRevision,
      () => input.snapshot()?.libraryRevision,
      () => input.snapshot()?.tagsLinkRevision
    ] as const,
    (values, previous) => {
      const changed = values.map((value, index) => {
        const result = known[index] && value !== previous?.[index]
        if (value != null) known[index] = true
        return result
      })
      if (!initialized || values[0] !== previous?.[0] || values[1] !== previous?.[1]) {
        initialized = true
        void view.setContext(values[0], values[1])
      } else if (changed.slice(2).some(Boolean)) view.invalidate(changed[2])
    },
    { immediate: true, flush: 'sync' }
  )
}
