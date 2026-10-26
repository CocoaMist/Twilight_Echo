import { shallowRef, type Ref, type ShallowRef } from 'vue'
import { createLibraryPlaybackController as createCoreController } from '../../../../core/playback/libraryPlaybackController.ts'
import type { LibraryQueueApi } from './libraryQueueSource.ts'
import type {
  LibraryQueuePlaybackWindow,
  LibraryQueueSnapshot
} from '../../../../shared/libraryDatabase.ts'
export type {
  LibraryQueuePageProducer,
  LibraryQueuePageOptions
} from '../../../../core/playback/libraryPlaybackController.ts'

/** Vue projections for existing components; queue semantics live in the portable Core. */
export function createLibraryPlaybackController(api: LibraryQueueApi) {
  const controller = createCoreController(api, (value) => shallowRef(value))
  // Keep the original property descriptors: spreading would freeze getters
  // such as diagnostics at attachment time and hide unknown write outcomes.
  return controller as typeof controller & {
    active: Ref<boolean>
    window: ShallowRef<LibraryQueuePlaybackWindow | null>
    snapshot: ShallowRef<LibraryQueueSnapshot | null>
    contentRevision: Ref<number>
    busy: Ref<boolean>
  }
}
