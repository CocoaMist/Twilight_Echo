import {
  EXTERNAL_PLAYLIST_MAX_ENTRIES,
  externalRefreshGeneration,
  type ImportedPlaylistData
} from '../../../../shared/externalPlaylist.ts'
import { PlaylistTransactionRejectedError } from '../playlistPersistence.ts'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export function externalMembershipIntent(
  base: ImportedPlaylistData,
  local: ImportedPlaylistData
): boolean {
  return (
    base.generation !== local.generation ||
    !equal(
      base.entries.map((entry) => entry.entryId),
      local.entries.map((entry) => entry.entryId)
    )
  )
}

/** Membership is an occurrence delta inside one refresh lineage. Refresh is
 * a full replacement; old user moves must fail atomically across that boundary.
 * Background resolution never restores a removed occurrence or a stale binding. */
export function replayExternalPlaylist(
  base: ImportedPlaylistData,
  local: ImportedPlaylistData,
  current: ImportedPlaylistData
): ImportedPlaylistData {
  const baseRefresh = externalRefreshGeneration(base)
  if (externalRefreshGeneration(local) !== baseRefresh) {
    // An explicit refresh retains its full membership intent. Manual choices
    // made while reading survive for occurrences retained by that refresh.
    const latest = new Map(current.entries.map((entry) => [entry.entryId, entry]))
    return {
      ...clone(local),
      entries: local.entries.map((entry) => {
        const other = latest.get(entry.entryId)
        return other && other.revision > entry.revision
          ? {
              ...clone(entry),
              revision: other.revision,
              manualBinding: other.manualBinding ? clone(other.manualBinding) : undefined,
              resolution: clone(other.resolution)
            }
          : clone(entry)
      })
    }
  }
  const membershipIntent = externalMembershipIntent(base, local)
  const old = new Map(base.entries.map((entry) => [entry.entryId, entry]))
  const after = new Map(local.entries.map((entry) => [entry.entryId, entry]))
  const manualIntent = local.entries.some(
    (entry) => entry.revision > (old.get(entry.entryId)?.revision ?? entry.revision)
  )
  const sameRefresh = externalRefreshGeneration(current) === baseRefresh
  if (!sameRefresh) {
    if (membershipIntent)
      throw new PlaylistTransactionRejectedError(
        '导入歌单已刷新，未保存本次成员操作，请重新读取后重试'
      )
    if (!manualIntent) return clone(current)
  }
  if (!membershipIntent && !manualIntent && base.generation !== current.generation)
    return clone(current)
  const next = clone(current)
  for (const key of ['complete', 'readError', 'expectedTotal', 'locallyEdited'] as const) {
    if (sameRefresh && !equal(base[key], local[key])) Object.assign(next, { [key]: local[key] })
  }
  next.entries = next.entries
    .filter((entry) => !old.has(entry.entryId) || after.has(entry.entryId))
    .map((entry) => {
      const before = old.get(entry.entryId),
        changed = after.get(entry.entryId)
      if (!before || !changed || equal(before, changed)) return entry
      if (changed.revision > before.revision && changed.revision >= entry.revision)
        return {
          ...entry,
          revision: changed.revision,
          manualBinding: changed.manualBinding ? clone(changed.manualBinding) : undefined,
          resolution: clone(changed.resolution)
        }
      if (
        base.generation === current.generation &&
        !equal(before.resolution, changed.resolution) &&
        changed.revision === entry.revision &&
        equal(entry.manualBinding, before.manualBinding)
      )
        return { ...entry, resolution: clone(changed.resolution) }
      return entry
    })
  const ids = new Set(next.entries.map((entry) => entry.entryId))
  for (const entry of local.entries) {
    if (!old.has(entry.entryId) && !ids.has(entry.entryId)) {
      next.entries.push(clone(entry))
      ids.add(entry.entryId)
    }
  }
  const localOrder = local.entries
    .filter((entry) => old.has(entry.entryId) && ids.has(entry.entryId))
    .map((entry) => entry.entryId)
  const baseOrder = base.entries
    .filter((entry) => ids.has(entry.entryId))
    .map((entry) => entry.entryId)
  if (!equal(localOrder, baseOrder)) {
    const entries = new Map(next.entries.map((entry) => [entry.entryId, entry]))
    next.entries = [
      ...localOrder.map((id) => entries.get(id)!),
      ...next.entries.filter((entry) => !old.has(entry.entryId))
    ]
  }
  if (next.entries.length > EXTERNAL_PLAYLIST_MAX_ENTRIES)
    throw new PlaylistTransactionRejectedError('合并后的歌单超过 20,000 条上限，未保存本次操作')
  const changedMembership = !equal(
    current.entries.map((entry) => entry.entryId),
    next.entries.map((entry) => entry.entryId)
  )
  next.entries = next.entries.map((entry, position) => ({ ...entry, position }))
  if (membershipIntent) {
    next.refreshGeneration = baseRefresh
    if (base.generation !== local.generation) next.generation = local.generation
    if (changedMembership)
      next.membershipRevision =
        current.membershipRevision + Math.max(1, local.membershipRevision - base.membershipRevision)
    else next.membershipRevision = Math.max(current.membershipRevision, local.membershipRevision)
  }
  return next
}
