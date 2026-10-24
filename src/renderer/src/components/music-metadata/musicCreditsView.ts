import { shallowRef } from 'vue'
import type { EntityMetadataDetail } from '../../../../shared/entityMetadata.ts'
import type {
  MusicCredit,
  MusicCreditRole,
  MusicCreditTarget,
  MusicCreditsPage,
  MusicCreditsQuery
} from '../../../../shared/musicCredits.ts'
import { validMusicBrainzArtistId } from '../../../../shared/entityMetadata.ts'

export const MUSIC_CREDITS_PAGE_SIZE = 20
interface CreditsState {
  page: MusicCreditsPage | null
  loading: boolean
  error: string
}
/** The consumer supplies a recording detail, never a release's mixed-track set. */
export function createMusicCreditsView(
  read: (query: MusicCreditsQuery, signal: AbortSignal) => Promise<MusicCreditsPage>
) {
  const state = shallowRef<CreditsState>({ page: null, loading: false, error: '' })
  let subject: { entityId: string; entityRevision: number } | null = null
  let request: AbortController | null = null
  let disposed = false
  async function load(offset = 0, revision?: string) {
    if (!subject || disposed) return
    request?.abort()
    const current = new AbortController()
    request = current
    state.value = { page: null, loading: true, error: '' }
    try {
      const page = await read(
        { ...subject, offset, limit: MUSIC_CREDITS_PAGE_SIZE, ...(revision ? { revision } : {}) },
        current.signal
      )
      if (disposed || request !== current) return
      if (offset > 0 && offset >= page.total) return load()
      state.value = { page, loading: false, error: '' }
    } catch (error) {
      if (!disposed && request === current)
        state.value = {
          page: null,
          loading: false,
          error: error instanceof Error ? error.message : String(error)
        }
    }
  }
  return {
    state,
    setDetail(detail: EntityMetadataDetail | null) {
      request?.abort()
      request = null
      subject =
        detail?.link?.state === 'confirmed' && detail.targetId
          ? { entityId: detail.entityId, entityRevision: detail.revision }
          : null
      state.value = { page: null, loading: false, error: '' }
      return subject ? load() : Promise.resolve()
    },
    page: (offset: number) => load(offset, state.value.page?.revision),
    dispose() {
      disposed = true
      request?.abort()
      request = null
    }
  }
}

const roles: Record<MusicCreditRole, string> = {
  primary_artist: '主要艺人',
  producer: '制作',
  arranger: '编曲',
  mix: '混音',
  mastering: '母带',
  recording_engineer: '录音工程',
  vocal: '演唱',
  instrument: '演奏',
  composer: '作曲',
  lyricist: '作词',
  conductor: '指挥',
  other: '其他关系'
}
export function creditRoleLabel(credit: MusicCredit): string {
  // A forward relation must not be silently inverted into a contribution.
  return credit.direction === 'forward' || credit.role === 'other'
    ? credit.rawRole || roles.other
    : roles[credit.role]
}
export const creditTargetLabel = (kind: MusicCreditTarget['kind']): string =>
  ({
    artist: '人物',
    recording: '录音',
    release: '具体发行',
    album_project: '专辑作品',
    work: '作品'
  })[kind]

/** Canonical source link, alongside in-app exact-reference navigation. */
export function musicBrainzReferenceUrl(ref: MusicCreditTarget): string | null {
  if (
    ref.provider !== 'musicbrainz' ||
    ref.idType !== 'mbid' ||
    !validMusicBrainzArtistId(ref.value)
  )
    return null
  const kind = ref.kind === 'album_project' ? 'release-group' : ref.kind
  return `https://musicbrainz.org/${kind}/${ref.value}`
}
