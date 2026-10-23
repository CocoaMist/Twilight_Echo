import { computed } from 'vue'
import { createCoreMusicVersions } from './library/coreMusicVersions.ts'
import { useCoreConnection } from './coreConnection.ts'
import type {
  MusicVersionsDocument,
  VersionOperation,
  VersionScope
} from '../../../shared/musicVersions.ts'

let singleton: ReturnType<typeof createCoreMusicVersions> | null = null
function store() {
  return (singleton ??= createCoreMusicVersions(useCoreConnection()))
}
export const loadMusicVersions = () => store().load()
export const getMusicVersions = () => store().get()
export const sourceVersion = (scope: VersionScope, source: string) =>
  store().sourceVersion(scope, source)
export const previewMusicVersionEdit = (
  scope: VersionScope,
  operation: VersionOperation,
  keys: string[],
  label: string
) => store().preview(scope, operation, keys, label)
export const saveMusicVersions = (next: MusicVersionsDocument, expected: MusicVersionsDocument) =>
  store().save(next, expected)
export const musicVersionRevision = computed(() => store().revision.value)
export const musicVersionError = computed(() => store().error.value)
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    singleton?.dispose()
    singleton = null
  })
