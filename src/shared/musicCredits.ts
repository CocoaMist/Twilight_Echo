import type { MusicExternalReference } from './musicIdentification.ts'
import type { MetadataAttribution } from './entityMetadata.ts'

export type MusicCreditRole =
  | 'primary_artist'
  | 'producer'
  | 'arranger'
  | 'mix'
  | 'mastering'
  | 'recording_engineer'
  | 'vocal'
  | 'instrument'
  | 'composer'
  | 'lyricist'
  | 'conductor'
  | 'other'
/** Work references remain external in M2; M5 supplies work navigation. */
export interface MusicCreditTarget {
  provider: string
  kind: 'artist' | 'recording' | 'release' | 'album_project' | 'work'
  idType: string
  value: string
}
export interface MusicCredit {
  personRef: MusicExternalReference
  name: string
  targetRef: MusicCreditTarget
  role: MusicCreditRole
  rawRole: string
  relationTypeId: string
  direction: 'forward' | 'backward' | ''
  order: number
  joinphrase: string
  attributes: Array<{ name: string; value?: string }>
  begin: string
  end: string
  attribution: MetadataAttribution
}
export interface MusicCreditSet {
  items: MusicCredit[]
  truncated: boolean
}
export interface MusicCreditsQuery {
  entityId: string
  /** Identity revision from metadata.entity.detail, including the first page. */
  entityRevision?: number
  offset?: number
  limit?: number
  revision?: string
}
export interface MusicCreditsPage {
  items: MusicCredit[]
  total: number
  offset: number
  revision: string
  /** The provider response itself was incomplete, separate from pagination. */
  truncated: boolean
}
const CREDIT_ROLES = new Map<string, MusicCreditRole>(
  Object.entries({
    'artist-credit': 'primary_artist',
    producer: 'producer',
    'executive producer': 'producer',
    arranger: 'arranger',
    'instrument arranger': 'arranger',
    'vocal arranger': 'arranger',
    mix: 'mix',
    mastering: 'mastering',
    recording: 'recording_engineer',
    vocal: 'vocal',
    instrument: 'instrument',
    composer: 'composer',
    lyricist: 'lyricist',
    conductor: 'conductor'
  }) as Array<[string, MusicCreditRole]>
)
export const musicCreditRole = (raw: string): MusicCreditRole =>
  CREDIT_ROLES.get(raw.toLowerCase()) ?? 'other'
