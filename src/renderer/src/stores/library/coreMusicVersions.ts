import { computed, readonly, shallowRef, watch } from 'vue'
import type { createCoreConnectionStore } from '../coreConnection.ts'
import {
  emptyMusicVersions,
  editMusicVersions,
  parseMusicVersions,
  type MusicVersionsDocument,
  type MusicVersion,
  type VersionFamily,
  type VersionOperation,
  type VersionScope
} from '../../../../shared/musicVersions.ts'
import type { CoreVersionsEdit } from '../../../../shared/coreVersions.ts'

type Client = Pick<
  ReturnType<typeof createCoreConnectionStore>,
  'state' | 'attach' | 'query' | 'command'
>

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const item of Object.values(value)) freeze(item)
  }
  return value
}

/** Browser state contains display indexes and uncommitted previews only. */
export function createCoreMusicVersions(core: Client) {
  const state = shallowRef<MusicVersionsDocument>(freeze(emptyMusicVersions()))
  const revision = shallowRef(0)
  const error = shallowRef('')
  const drafts = new WeakMap<MusicVersionsDocument, CoreVersionsEdit>()
  const key = () => {
    const snapshot = core.state.value
    return snapshot?.phase === 'ready' && snapshot.versionsRevision !== null
      ? `${snapshot.epoch}:${snapshot.versionsRevision}`
      : ''
  }
  let loaded = '',
    reading: { key: string; promise: Promise<void> } | null = null
  function recordError(cause: unknown): void {
    error.value = cause instanceof Error ? cause.message : String(cause)
  }
  async function load(): Promise<void> {
    if (!key()) await core.attach()
    const expected = key()
    if (!expected) return
    if (reading?.key === expected) return reading.promise
    const snapshot = core.state.value!,
      expectedRevision = snapshot.versionsRevision!
    const promise = (async () => {
      const next = emptyMusicVersions()
      for (const scope of ['tracks', 'albums'] as const) {
        for (const kind of ['versions', 'families'] as const) {
          let offset = 0,
            total = 1
          do {
            const page = await core.query('versions.page', {
              revision: expectedRevision,
              scope,
              kind,
              offset,
              limit: 128
            })
            ;(next[scope][kind] as Array<MusicVersion | VersionFamily>).push(...page.items)
            offset += page.items.length
            total = page.total
          } while (offset < total)
        }
      }
      if (expected !== key()) return
      state.value = freeze(parseMusicVersions(JSON.stringify(next)))
      revision.value = expectedRevision
      loaded = expected
      error.value = ''
    })()
      .catch((cause) => {
        if (expected === key()) recordError(cause)
        throw cause
      })
      .finally(() => {
        if (reading?.promise === promise) reading = null
      })
    reading = { key: expected, promise }
    return promise
  }
  const stop = watch(key, (value) => {
    if (value && value !== loaded) void load().catch(() => {})
  })
  function get(): MusicVersionsDocument {
    if (loaded !== key() || !loaded) void load().catch(() => {})
    return state.value
  }
  const indexes = computed(() => ({
    tracks: new Map(
      state.value.tracks.versions.flatMap((version) =>
        version.sources.map((source) => [source, version] as const)
      )
    ),
    albums: new Map(
      state.value.albums.versions.flatMap((version) =>
        version.sources.map((source) => [source, version] as const)
      )
    )
  }))
  function preview(
    scope: VersionScope,
    operation: VersionOperation,
    keys: string[],
    label: string
  ) {
    const before = get()
    if (loaded !== key() || error.value) throw new Error('版本记录尚未就绪，请重新读取')
    const after = editMusicVersions(before, scope, operation, keys, label)
    drafts.set(after, { revision: revision.value, scope, operation, keys: [...keys], label })
    return { before, after }
  }
  async function save(next: MusicVersionsDocument, expected: MusicVersionsDocument): Promise<void> {
    const edit = drafts.get(next)
    if (!edit || state.value !== expected || loaded !== key())
      throw new Error('版本记录已变化，请重新预览')
    drafts.delete(next)
    try {
      await core.command('versions.edit', edit)
      await load()
    } catch (cause) {
      recordError(cause)
      throw cause
    }
  }
  return {
    load,
    get,
    preview,
    save,
    sourceVersion: (scope: VersionScope, source: string) => {
      get()
      return indexes.value[scope].get(source)
    },
    revision: readonly(revision),
    error: readonly(error),
    dispose: stop
  }
}
