import type { NetworkEntry } from '../../shared/networkSources.ts'
import { normalizeIpcString } from '../security/ipcValidation.ts'

/** Keep the playback DTO small; filesystem identity is derived by the manager. */
export function normalizeEntry(value: unknown): NetworkEntry {
  if (!value || typeof value !== 'object') throw new Error('entry must be an object')
  const entry = value as Partial<NetworkEntry>
  const kind = entry.kind ?? 'file'
  if (!['directory', 'file', 'audio', 'playlist'].includes(kind)) {
    throw new Error('invalid entry kind')
  }
  if (entry.sizeBytes != null && (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0)) {
    throw new Error('invalid entry size')
  }
  return {
    id: normalizeIpcString(entry.id, 'entry id', 128),
    profileId: normalizeIpcString(entry.profileId, 'entry profile id', 128),
    name: normalizeIpcString(entry.name, 'entry name', 512),
    kind,
    path: normalizeIpcString(entry.path, 'entry path', 4096),
    sizeBytes: entry.sizeBytes
  }
}
