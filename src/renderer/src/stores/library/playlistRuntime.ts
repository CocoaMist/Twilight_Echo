import { toRaw, triggerRef, type Ref } from 'vue'
import type { PlaylistRuntime } from '../../../../core/playlists/ports.ts'
import type { Playlist } from '../../../../shared/playlists.ts'
import * as identity from '../../utils/logicalTrackModel.ts'
import { getMusicVersions, musicVersionRevision } from '../musicVersions.ts'

export function rendererPlaylistRuntime(playlists?: Ref<Playlist[]>): PlaylistRuntime {
  return {
    now: Date.now,
    newId: () => crypto.randomUUID(),
    identity,
    versions: {
      ensure: () => {
        getMusicVersions()
      },
      revision: () => musicVersionRevision.value
    },
    clone: <T>(value: T): T => {
      const raw = toRaw(value)
      try {
        return structuredClone(raw)
      } catch {
        return JSON.parse(JSON.stringify(raw)) as T
      }
    },
    notify: () => {
      if (playlists) triggerRef(playlists)
    },
    repository: {
      load: () => window.api.data.loadPlaylists(),
      save: (data, revision) => window.api.data.savePlaylists(data, revision)
    }
  }
}
