import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { CatalogKind } from '../../shared/musicCatalog.ts'
import type { ArtistIdentityCandidate, EntityMetadataJob } from '../../shared/entityMetadata.ts'
import type {
  MusicExternalReference,
  MusicIdentityLink,
  MusicIdentityDetail,
  IdentificationCandidate,
  IdentificationSourceInput,
  IdentificationInput,
  IdentificationProposal,
  IdentificationCandidatesQuery,
  IdentificationInboxQuery,
  IdentificationInboxPage,
  IdentificationReview,
  IdentificationDecision,
  IdentificationPreview,
  IdentificationMemberSnapshot,
  IdentificationMemberResult,
  IdentificationHistoryQuery,
  IdentificationHistoryPage,
  IdentificationHistoryReview,
  IdentificationRestorePreview
} from '../../shared/musicIdentification.ts'
import { LibraryDatabaseIdentificationHistory } from './libraryDatabaseIdentificationHistory.ts'
import { LibraryDatabaseRatings } from './libraryDatabaseRatings.ts'
import { LibraryDatabasePreferences } from './libraryDatabasePreferences.ts'
import { legacyTrackIdentityTags, normalizeTrackIdentityTags } from '../../shared/trackIdentification.ts'
import type { TrackData } from '../../shared/track.ts'
import { parentDirectoryOf } from '../../shared/libraryIdentity.ts'
import {
  explicitMusicBrainzIds, identityProofSources, sourceNativeIds, validIdentificationVerification
} from '../../shared/musicIdentificationVerification.ts'
import { localAlbumLayout, validateAlbumTracks } from '../../shared/musicAlbumValidation.ts'
import { validatePlatformAlbum } from '../../shared/musicPlatformAlbumValidation.ts'
import { albumMemberProposals, type AlbumMemberView, type AlbumMemberProof } from '../../shared/musicAlbumMembers.ts'
import {
  validIdentificationPayload,
  validMusicExternalReference,
  validIdentificationKind
} from '../../shared/musicIdentification.ts'

/** metadata_entities' old provider/external_id columns are creation provenance only.
 * All identity lookup uses refs; existing target UUIDs and fact FKs stay intact. */
export const IDENTIFICATION_INPUT_FENCE_SCHEMA_SQL = `
CREATE TABLE metadata_identification_inputs(entity_id TEXT PRIMARY KEY REFERENCES catalog_entities(id),revision INTEGER NOT NULL);
CREATE TRIGGER metadata_identification_input_changed AFTER UPDATE OF title,artist,kind ON catalog_entities
WHEN old.title IS NOT new.title OR old.artist IS NOT new.artist OR old.kind IS NOT new.kind BEGIN
  INSERT INTO metadata_identification_inputs VALUES(new.id,1)
    ON CONFLICT(entity_id) DO UPDATE SET revision=revision+1;
END;
`
export const IDENTIFICATION_SCHEMA_SQL = `
${IDENTIFICATION_INPUT_FENCE_SCHEMA_SQL}
CREATE TABLE metadata_identity_refs(provider TEXT NOT NULL,kind TEXT NOT NULL,id_type TEXT NOT NULL,
  value TEXT NOT NULL,target_id TEXT NOT NULL REFERENCES metadata_entities(id),
  PRIMARY KEY(provider,kind,id_type,value));
CREATE INDEX metadata_identity_refs_target ON metadata_identity_refs(target_id);
CREATE TABLE metadata_identity_links(id TEXT PRIMARY KEY,entity_id TEXT NOT NULL REFERENCES catalog_entities(id),
  kind TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,target_id TEXT REFERENCES metadata_entities(id),
  state TEXT NOT NULL CHECK(state IN ('unresolved','confirmed','detached')),UNIQUE(entity_id,kind));
CREATE TABLE metadata_identity_candidates(id TEXT PRIMARY KEY,entity_id TEXT NOT NULL REFERENCES catalog_entities(id),
  kind TEXT NOT NULL,candidate_key TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,
  UNIQUE(entity_id,kind,candidate_key));
CREATE INDEX metadata_identity_candidates_entity ON metadata_identity_candidates(entity_id,state,id);
CREATE TABLE metadata_identity_suppressions(entity_id TEXT NOT NULL REFERENCES catalog_entities(id),kind TEXT NOT NULL,
  provider TEXT NOT NULL,id_type TEXT NOT NULL,value TEXT NOT NULL,reason TEXT NOT NULL,changed_at INTEGER NOT NULL,
  PRIMARY KEY(entity_id,kind,provider,id_type,value));
CREATE TABLE metadata_identity_history(seq INTEGER PRIMARY KEY AUTOINCREMENT,link_id TEXT NOT NULL,
  candidate_id TEXT,state TEXT NOT NULL,target_id TEXT,evidence TEXT NOT NULL,changed_at INTEGER NOT NULL);
CREATE INDEX metadata_link_history_identity ON metadata_link_history(entity_id,lower(mbid),seq);
INSERT INTO metadata_identity_refs SELECT provider,kind,'mbid',lower(external_id),id FROM metadata_entities;
INSERT INTO metadata_identity_links
  SELECT lower(hex(randomblob(16))),s.id,'artist',s.revision,s.target_id,
    CASE s.state WHEN 'confirmed' THEN 'confirmed' WHEN 'detached' THEN 'detached' ELSE 'unresolved' END
  FROM metadata_subjects s;
INSERT INTO metadata_identity_suppressions
  SELECT h.entity_id,'artist','musicbrainz','mbid',lower(h.mbid),h.state,h.changed_at
  FROM metadata_link_history h WHERE h.mbid<>'' AND h.state IN ('rejected','detached')
  AND h.seq=(SELECT max(x.seq) FROM metadata_link_history x WHERE x.entity_id=h.entity_id AND lower(x.mbid)=lower(h.mbid));
`

// Input revisions must observe ID/credit/order changes too, including A → B → A.
// Display-only enrichment (covers, lyrics, addedAt) deliberately does not participate.
const sourceBasis = (side: 'old' | 'new') => `json_extract(${side}.payload,
  '$.title','$.artist','$.artists','$.album','$.albumArtist','$.albumId','$.isrc',
  '$.duration','$.discNumber','$.trackNumber','$.cueRange','$.identityTags')`
const touchSource = (side: 'old' | 'new') => `
  INSERT INTO metadata_identification_inputs(entity_id,revision)
    SELECT DISTINCT entity_id,1 FROM catalog_entity_sources WHERE source_id=${side}.id AND true
    ON CONFLICT(entity_id) DO UPDATE SET revision=revision+1;`
export const IDENTIFICATION_SOURCE_FENCE_SCHEMA_SQL = `
CREATE INDEX catalog_source_album_key ON catalog_sources(album_key);
CREATE TRIGGER metadata_identification_source_before BEFORE UPDATE ON catalog_sources
WHEN ${sourceBasis('old')} IS NOT ${sourceBasis('new')} OR old.availability IS NOT new.availability
  OR old.release_id IS NOT new.release_id OR old.recording_id IS NOT new.recording_id
  OR old.provider IS NOT new.provider OR old.track_id IS NOT new.track_id BEGIN ${touchSource('old')} END;
CREATE TRIGGER metadata_identification_source_after AFTER UPDATE ON catalog_sources
WHEN ${sourceBasis('old')} IS NOT ${sourceBasis('new')} OR old.availability IS NOT new.availability
  OR old.release_id IS NOT new.release_id OR old.recording_id IS NOT new.recording_id
  OR old.provider IS NOT new.provider OR old.track_id IS NOT new.track_id BEGIN ${touchSource('new')} END;
CREATE TRIGGER metadata_identification_source_insert AFTER INSERT ON catalog_sources
BEGIN ${touchSource('new')} END;
CREATE TRIGGER metadata_identification_credit_insert AFTER INSERT ON catalog_source_artists BEGIN
  INSERT INTO metadata_identification_inputs VALUES(new.artist_id,1)
    ON CONFLICT(entity_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER metadata_identification_credit_delete BEFORE DELETE ON catalog_source_artists BEGIN
  INSERT INTO metadata_identification_inputs VALUES(old.artist_id,1)
    ON CONFLICT(entity_id) DO UPDATE SET revision=revision+1;
END;
`

export const IDENTIFICATION_ALBUM_FENCE_SCHEMA_SQL = `
CREATE INDEX metadata_identity_history_link ON metadata_identity_history(link_id,seq);
CREATE TRIGGER metadata_identification_album_cohort AFTER UPDATE ON catalog_sources
WHEN old.source_key IS NOT new.source_key
BEGIN ${touchSource('old')} ${touchSource('new')} END;
`

type Row = Record<string, unknown>
type Owner = { sql: DatabaseSync; transaction<T>(action: () => T): T }
const stale = () =>
  Object.assign(new Error('识别依据或关联已变化，请刷新候选'), { code: 'STALE_REVISION' })
const refKey = (ref: MusicExternalReference) =>
  JSON.stringify([ref.provider, ref.kind, ref.idType, ref.value])
const canonical = (ref: MusicExternalReference): MusicExternalReference => ({
  provider: ref.provider.toLowerCase(),
  kind: ref.kind,
  idType: ref.idType.toLowerCase(),
  value: ref.provider.toLowerCase() === 'musicbrainz' ? ref.value.toLowerCase() : ref.value
})
const decode = (row: Row) => JSON.parse(String(row.payload)) as IdentificationCandidate

/** The sole writer of identity mappings, including the M2.1 compatibility projection. */
export class LibraryDatabaseIdentification {
  private readonly owner: Owner
  constructor(owner: Owner) {
    this.owner = owner
  }
  private get sql() {
    return this.owner.sql
  }
  private transaction<T>(action: () => T): T {
    return this.sql.isTransaction ? action() : this.owner.transaction(action)
  }
  private get preferences() { return new LibraryDatabasePreferences(this.owner) }
  private get ratings() { return new LibraryDatabaseRatings(this.owner) }
  private entity(entityId: string): Row & { kind: CatalogKind } {
    const row = this.sql.prepare('SELECT * FROM catalog_entities WHERE id=?').get(entityId) as
      | Row
      | undefined
    if (!row || !validIdentificationKind(row.kind))
      throw new Error('音乐实体不存在，请先完成目录索引')
    return row as Row & { kind: CatalogKind }
  }
  private link(entityId: string): MusicIdentityLink | null {
    const row = this.sql
      .prepare('SELECT * FROM metadata_identity_links WHERE entity_id=?')
      .get(entityId) as Row | undefined
    let confirmation: MusicIdentityLink['confirmation']
    if (row?.state === 'confirmed') {
      const history = this.sql.prepare("SELECT evidence FROM metadata_identity_history WHERE link_id=? AND state='confirmed' ORDER BY seq DESC LIMIT 1")
        .get(String(row.id)) as Row | undefined
      const decision = history ? JSON.parse(String(history.evidence)).decision : undefined
      confirmation = decision?.mode === 'automatic' ? { mode: 'automatic', rule: decision.rule }
        : { mode: history ? 'manual' : 'legacy' }
    }
    return row
      ? {
          id: String(row.id),
          entityId,
          kind: row.kind as CatalogKind,
          revision: Number(row.revision),
          targetId: row.target_id === null ? null : String(row.target_id),
          state: row.state as MusicIdentityLink['state'],
          ...(confirmation ? { confirmation } : {})
        }
      : null
  }
  private ensure(entityId: string): MusicIdentityLink {
    const entity = this.entity(entityId)
    this.sql
      .prepare("INSERT OR IGNORE INTO metadata_identity_links VALUES(?,?,?,0,NULL,'unresolved')")
      .run(randomUUID(), entityId, entity.kind)
    return this.link(entityId)!
  }
  private references(targetId: string | null): MusicExternalReference[] {
    if (!targetId) return []
    return (
      this.sql
        .prepare(
          'SELECT * FROM metadata_identity_refs WHERE target_id=? ORDER BY provider,kind,id_type,value'
        )
        .all(targetId) as Row[]
    ).map((row) => ({
      provider: String(row.provider),
      kind: row.kind as CatalogKind,
      idType: String(row.id_type),
      value: String(row.value)
    }))
  }
  detail(entityId: string): MusicIdentityDetail {
    const entity = this.entity(entityId),
      link = this.link(entityId)
    return {
      entityId,
      kind: entity.kind,
      link,
      references: this.references(link?.state === 'confirmed' ? link.targetId : null)
    }
  }
  private historyOwner(): LibraryDatabaseIdentificationHistory {
    return new LibraryDatabaseIdentificationHistory({
      sql: this.sql,
      detail: id => this.detail(id),
      input: id => this.input(id),
      references: id => this.references(id),
      currentMemberParent: parent => this.currentMemberParent(parent),
      ratingImpact: (entityId, kind, targetId) => this.ratings.identityImpact(entityId, kind, targetId),
      preferenceImpact: (entityId, kind, targetId) => this.preferences.identityImpact(entityId, kind, targetId)
    })
  }
  history(query: IdentificationHistoryQuery): IdentificationHistoryPage {
    return this.historyOwner().page(query)
  }
  restorePreview(request: IdentificationHistoryReview): IdentificationRestorePreview {
    return this.historyOwner().preview(request)
  }
  restore(request: IdentificationHistoryReview, now: number): MusicIdentityDetail {
    if (!validIdentificationPayload('identification.restore', request)) throw new Error('无效的恢复关联请求')
    return this.transaction(() => {
      const history = this.historyOwner(), preview = history.preview(request)
      if (preview.stale) throw stale()
      if (!preview.canRestore) throw Object.assign(new Error('该历史关联当前不可恢复，请重新识别或核对关联'), { code: 'IDENTITY_CONFLICT' })
      const { audit } = history.receipt(request)
      const link = preview.current.link!, targetId = preview.history.targetId!
      this.ratings.applyIdentity(link.entityId, preview.current.kind, targetId, request.ratingResolution, now)
      this.preferences.applyIdentity(link.entityId, preview.current.kind, targetId, request.preferenceResolution, now)
      for (const ref of preview.references) this.sql.prepare(`DELETE FROM metadata_identity_suppressions
        WHERE entity_id=? AND kind=? AND provider=? AND id_type=? AND value=?`)
        .run(link.entityId, ref.kind, ref.provider, ref.idType, ref.value)
      if (link.state === 'confirmed' && link.targetId !== targetId) {
        this.suppress(link.entityId, this.references(link.targetId), 'replaced', now)
        this.markSuppressed(link.entityId, now)
        this.sql.prepare(`INSERT INTO metadata_identity_history(link_id,state,target_id,evidence,changed_at)
          VALUES(?,'replaced',?,'{}',?)`).run(link.id, link.targetId, now)
      }
      this.sql.prepare("UPDATE metadata_identity_links SET target_id=?,state='confirmed',revision=revision+1 WHERE id=?")
        .run(targetId, link.id)
      const receipt = JSON.stringify({ ...audit, references: preview.references,
        decision: { mode: 'manual', restoredFrom: request.historySeq,
          ...(request.ratingResolution ? { ratingResolution: request.ratingResolution } : {}),
          ...(request.preferenceResolution ? { preferenceResolution: request.preferenceResolution } : {}) } })
      this.legacy({ ...link, targetId, state: 'confirmed' }, preview.references, receipt, now)
      this.sql.prepare(`INSERT INTO metadata_identity_history(link_id,candidate_id,state,target_id,evidence,changed_at)
        VALUES(?,?,'confirmed',?,?,?)`).run(link.id, audit!.id, targetId, receipt, now)
      this.settleIdentificationJobs(link.entityId, 'confirm', now)
      this.scheduleIdentity(link.entityId, targetId)
      return this.detail(link.entityId)
    })
  }
  input(entityId: string): IdentificationInput {
    const entity = this.entity(entityId)
    const row = this.sql
      .prepare('SELECT revision FROM metadata_identification_inputs WHERE entity_id=?')
      .get(entityId) as Row | undefined
    // Bound IDs before hydrating payloads, even for an artist with thousands of songs.
    const sourceRows = this.sql.prepare(`SELECT * FROM catalog_sources WHERE id IN (
      SELECT DISTINCT b.source_id FROM catalog_entity_sources b JOIN catalog_sources s ON s.id=b.source_id
      WHERE b.entity_id=? AND s.availability<>'missing' ORDER BY b.source_id LIMIT 65
    ) ORDER BY id`).all(entityId) as Row[]
    const sources: IdentificationSourceInput[] = []
    const cohorts = new Map<string, string>()
    let bytes = 0
    let sourcesTruncated = sourceRows.length > 64
    for (const source of sourceRows.slice(0, 64)) {
      const track = JSON.parse(String(source.payload)) as TrackData
      // Snapshots deliberately omit paths. The canonical local source selector
      // retains the real file identity; only an opaque cohort leaves this owner.
      const selector = JSON.parse(String(source.source_key)) as unknown[]
      const directory = source.provider === 'local' && selector[0] === 'local' && typeof selector[1] === 'string'
        ? parentDirectoryOf(selector[1]) : ''
      // versionSourceKey folds Windows drive paths, but preserves POSIX case.
      const cohortKey = source.provider === 'local' && directory ? directory : ''
      if (cohortKey && !cohorts.has(cohortKey)) cohorts.set(cohortKey, String(cohorts.size + 1))
      const artists = track.artists?.length ? track.artists : [{ name: track.artist }]
      const artistIndexes = entity.kind === 'artist' ? artists.flatMap((artist, index) => {
        const key = artist.id !== undefined
          ? [source.provider, String(artist.id)]
          : [source.provider, source.recording_id, index]
        const alias = this.sql.prepare("SELECT entity_id FROM catalog_aliases WHERE namespace='source.artist' AND key=?")
          .get(JSON.stringify(key))
        return alias?.entity_id === entityId ? [index] : []
      }) : []
      const item: IdentificationSourceInput = {
        sourceId: String(source.id), provider: String(source.provider), trackId: String(source.track_id),
        title: track.title, artist: track.artist, album: track.album, albumArtist: track.albumArtist ?? '',
        albumId: track.albumId, artists, artistIndexes, duration: track.duration,
        discNumber: track.discNumber, trackNumber: track.trackNumber, isrc: track.isrc,
        tags: normalizeTrackIdentityTags(track.identityTags) ?? legacyTrackIdentityTags(track as unknown as Row),
        ...(cohortKey ? { albumCohort: cohorts.get(cohortKey)! } : {})
      }
      bytes += JSON.stringify(item).length
      if (bytes > 262144) { sourcesTruncated = true; break }
      sources.push(item)
    }
    // Only the fields consumed by this matcher form its input fence. Unrelated
    // catalog revisions and introduction overrides cannot invalidate identities.
    return {
      entityId,
      kind: entity.kind,
      name: String(entity.title),
      artist: String(entity.artist),
      version: JSON.stringify([
        Number(row?.revision ?? 0),
        entity.kind,
        entity.title,
        entity.artist,
        sources.map((source) => source.sourceId)
      ]),
      linkRevision: this.link(entityId)?.revision ?? 0,
      sources,
      sourcesTruncated
    }
  }
  private active(entityId: string): boolean {
    return !!this.sql
      .prepare(
        `SELECT 1 FROM catalog_entity_sources b JOIN catalog_sources s ON s.id=b.source_id
      WHERE b.entity_id=? AND s.availability<>'missing' LIMIT 1`
      )
      .get(entityId)
  }
  private memberStamp(entityId: string): string {
    const entity = this.entity(entityId), row = this.sql.prepare(
      'SELECT revision FROM metadata_identification_inputs WHERE entity_id=?'
    ).get(entityId)
    return JSON.stringify([Number(row?.revision ?? 0), entity.kind, entity.title, entity.artist])
  }
  /** Capture independent child fences in the claim transaction, before any HTTP. */
  albumMemberSnapshot(input: IdentificationInput): IdentificationMemberSnapshot | undefined {
    const layout = localAlbumLayout(input)
    if (layout.missing.length || layout.conflicts.length) return undefined
    const rows = this.sql.prepare(`SELECT DISTINCT e.id,e.kind FROM catalog_entity_sources b
      JOIN catalog_entities e ON e.id=b.entity_id WHERE b.source_id IN (SELECT value FROM json_each(?))
      AND e.kind IN ('artist','recording') ORDER BY e.id LIMIT 201`)
      .all(JSON.stringify(input.sources!.map(s => s.sourceId))) as Row[]
    return { truncated: rows.length > 200, items: rows.slice(0, 200).map(row => ({
      entityId: String(row.id), kind: row.kind as 'artist' | 'recording',
      inputStamp: this.memberStamp(String(row.id)), linkRevision: this.link(String(row.id))?.revision ?? 0
    })) }
  }
  private suppressed(entityId: string, ref: MusicExternalReference): boolean {
    return !!this.sql
      .prepare(
        `SELECT 1 FROM metadata_identity_suppressions
      WHERE entity_id=? AND kind=? AND provider=? AND id_type=? AND value=?`
      )
      .get(entityId, ref.kind, ref.provider, ref.idType, ref.value)
  }
  private save(candidate: IdentificationCandidate, key?: string) {
    if (key !== undefined)
      this.sql
        .prepare('INSERT INTO metadata_identity_candidates VALUES(?,?,?,?,?,?,?)')
        .run(
          candidate.id,
          candidate.entityId,
          candidate.kind,
          key,
          candidate.state,
          candidate.revision,
          JSON.stringify(candidate)
        )
    else
      this.sql
        .prepare('UPDATE metadata_identity_candidates SET state=?,revision=?,payload=? WHERE id=?')
        .run(candidate.state, candidate.revision, JSON.stringify(candidate), candidate.id)
  }
  publish(
    input: IdentificationInput,
    proposals: IdentificationProposal[],
    now: number
  ): IdentificationCandidate[] {
    if (!Array.isArray(proposals) || proposals.length > 100) throw new Error('识别候选超过上限')
    return this.transaction(() => {
      const current = this.input(input.entityId)
      if (
        current.version !== input.version ||
        current.kind !== input.kind ||
        current.linkRevision !== input.linkRevision ||
        !this.active(input.entityId)
      )
        throw stale()
      this.ensure(input.entityId)
      const seen = new Set<string>()
      return proposals.flatMap((proposal) => {
        if (
          !proposal ||
          !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(proposal.provider) ||
          typeof proposal.name !== 'string' ||
          !proposal.name.trim() ||
          proposal.name.length > 2048 ||
          typeof proposal.summary !== 'string' ||
          proposal.summary.length > 4096 ||
          typeof proposal.matcherVersion !== 'string' ||
          !proposal.matcherVersion ||
          proposal.matcherVersion.length > 128 ||
          !Array.isArray(proposal.references) ||
          !proposal.references.length ||
          proposal.references.length > 16 ||
          !proposal.references.every(
            (ref) => validMusicExternalReference(ref) && ref.kind === input.kind
          ) ||
          !proposal.evidence ||
          !validIdentificationVerification(proposal.evidence.verification) ||
          !['explicit_id', 'provider_native', 'search', 'cross_reference', 'album_tracks'].includes(
            proposal.evidence.origin
          ) ||
          typeof proposal.evidence.incomplete !== 'boolean' ||
          typeof proposal.evidence.provenance !== 'string' ||
          proposal.evidence.provenance.length > 8192 ||
          !['matches', 'missing', 'conflicts'].every((key) => {
            const values = proposal.evidence[key as 'matches']
            return (
              Array.isArray(values) &&
              values.length <= 64 &&
              values.every((v) => typeof v === 'string' && v.length <= 2048)
            )
          })
        )
          throw new Error('无效的识别候选')
        const references = [
          ...new Map(proposal.references.map(canonical).map((ref) => [refKey(ref), ref])).values()
        ].sort((a, b) => refKey(a).localeCompare(refKey(b)))
        const key = JSON.stringify([proposal.provider.toLowerCase(), references.map(refKey)])
        if (seen.has(key)) return []
        seen.add(key)
        const row = this.sql
          .prepare(
            'SELECT payload FROM metadata_identity_candidates WHERE entity_id=? AND kind=? AND candidate_key=?'
          )
          .get(input.entityId, input.kind, key) as Row | undefined
        const previous = row ? decode(row) : null
        const suppressed = references.some((ref) => this.suppressed(input.entityId, ref))
        const candidate: IdentificationCandidate = {
          id: previous?.id ?? randomUUID(),
          entityId: input.entityId,
          kind: input.kind,
          provider: proposal.provider.toLowerCase(),
          name: proposal.name,
          summary: proposal.summary,
          references,
          evidence: proposal.evidence,
          matcherVersion: proposal.matcherVersion,
          inputVersion: input.version,
          linkRevision: input.linkRevision,
          revision: (previous?.revision ?? 0) + 1,
          state: suppressed ? 'rejected' : 'candidate',
          suppressed,
          createdAt: previous?.createdAt ?? now,
          updatedAt: now
        }
        // A repeated identical result is idempotent and does not revoke a decision.
        if (
          previous &&
          previous.inputVersion === candidate.inputVersion &&
          previous.linkRevision === candidate.linkRevision &&
          previous.suppressed === suppressed &&
          previous.name === candidate.name &&
          previous.summary === candidate.summary &&
          previous.matcherVersion === candidate.matcherVersion &&
          JSON.stringify(previous.evidence) === JSON.stringify(candidate.evidence)
        )
          return [previous]
        this.save(candidate, previous ? undefined : key)
        return [candidate]
      })
    })
  }
  candidates(query: IdentificationCandidatesQuery) {
    if (!validIdentificationPayload('identification.candidates', query))
      throw new Error('无效的候选查询')
    this.entity(query.entityId)
    const where = `entity_id=?${query.state ? ' AND state=?' : ''}`
    const args = query.state ? [query.entityId, query.state] : [query.entityId]
    return {
      total: Number(
        (
          this.sql
            .prepare(`SELECT count(*) AS n FROM metadata_identity_candidates WHERE ${where}`)
            .get(...args) as Row
        ).n
      ),
      items: (
        this.sql
          .prepare(
            `SELECT payload FROM metadata_identity_candidates WHERE ${where} ORDER BY id LIMIT ? OFFSET ?`
          )
          .all(...args, query.limit ?? 50, query.offset ?? 0) as Row[]
      ).map(decode)
    }
  }
  inbox(query: IdentificationInboxQuery): IdentificationInboxPage {
    if (!validIdentificationPayload('identification.inbox', query)) throw new Error('无效的资料复核查询')
    const live = `s.availability<>'missing'
        AND EXISTS(SELECT 1 FROM catalog_memberships m WHERE m.source_id=s.id)
        AND (s.provider<>'local' OR (EXISTS(SELECT 1 FROM tracks t WHERE t.id=s.track_id)
          AND NOT EXISTS(SELECT 1 FROM catalog_pending p WHERE p.track_id=s.track_id)))`
    const where = `c.state=?${query.kind ? ' AND e.kind=?' : ''} AND EXISTS(
      SELECT 1 FROM catalog_entity_sources b JOIN catalog_sources s ON s.id=b.source_id
      WHERE b.entity_id=e.id AND ${live})`
    const args = [query.state ?? 'candidate', ...(query.kind ? [query.kind] : [])]
    const from = `FROM metadata_identity_candidates c JOIN catalog_entities e ON e.id=c.entity_id WHERE ${where}`
    return {
      total: Number(this.sql.prepare(`SELECT count(DISTINCT c.entity_id) n ${from}`).get(...args)!.n),
      offset: query.offset ?? 0,
      items: this.sql.prepare(`SELECT e.id,e.kind,e.title,e.artist,count(*) candidate_count,
        (SELECT json_object('provider',s.provider,'title',COALESCE(json_extract(s.payload,'$.title'),''),
          'album',COALESCE(json_extract(s.payload,'$.album'),''))
         FROM catalog_entity_sources b JOIN catalog_sources s ON s.id=b.source_id
         WHERE b.entity_id=e.id AND ${live} ORDER BY s.id LIMIT 1) sample ${from}
        GROUP BY e.id ORDER BY e.kind,e.id LIMIT ? OFFSET ?`).all(...args, query.limit ?? 20, query.offset ?? 0).map(row => ({
          entity: { id: String(row.id), kind: row.kind as CatalogKind, title: String(row.title), artist: String(row.artist) },
          candidateCount: Number(row.candidate_count),
          sample: row.sample ? JSON.parse(String(row.sample)) : null
        }))
    }
  }
  private candidate(request: IdentificationReview): IdentificationCandidate {
    if (!validIdentificationPayload('identification.preview', request))
      throw new Error('无效的候选版本')
    const row = this.sql
      .prepare('SELECT payload FROM metadata_identity_candidates WHERE id=?')
      .get(request.candidateId) as Row | undefined
    if (!row) throw new Error('候选不存在')
    const candidate = decode(row)
    if (candidate.revision !== request.revision) throw stale()
    return candidate
  }
  private targets(references: MusicExternalReference[]): string[] {
    return [
      ...new Set(
        references.flatMap((ref) => {
          const row = this.sql
            .prepare(
              'SELECT target_id FROM metadata_identity_refs WHERE provider=? AND kind=? AND id_type=? AND value=?'
            )
            .get(ref.provider, ref.kind, ref.idType, ref.value) as Row | undefined
          return row ? [String(row.target_id)] : []
        })
      )
    ]
  }
  preview(request: IdentificationReview): IdentificationPreview {
    const candidate = this.candidate(request),
      current = this.detail(candidate.entityId),
      input = this.input(candidate.entityId)
    const targets = this.targets(candidate.references)
    const memberProof = candidate.evidence.verification
    const staleInput =
      input.version !== candidate.inputVersion ||
      input.linkRevision !== candidate.linkRevision ||
      request.linkRevision !== input.linkRevision ||
      !this.active(candidate.entityId) ||
      (memberProof?.method === 'album_member' && !this.currentMemberParent(memberProof.parent))
    const conflicts = targets.length > 1 ? ['external_references_belong_to_different_targets'] : []
    const namespaces = new Map<string, string>()
    for (const ref of [
      ...candidate.references,
      ...this.references(targets.length === 1 ? targets[0] : null)
    ]) {
      const key = JSON.stringify([ref.provider, ref.kind, ref.idType])
      if (
        namespaces.has(key) &&
        namespaces.get(key) !== ref.value &&
        !conflicts.includes('conflicting_ids_in_same_namespace')
      )
        conflicts.push('conflicting_ids_in_same_namespace')
      namespaces.set(key, ref.value)
    }
    const proposedTargetId = targets[0] ?? null
    const ratingImpact = this.ratings.identityImpact(candidate.entityId, candidate.kind, proposedTargetId)
    const preferenceImpact = this.preferences.identityImpact(candidate.entityId, candidate.kind, proposedTargetId, candidate.references)
    return {
      candidate,
      current,
      proposedTargetId,
      stale: staleInput,
      conflicts,
      action:
        current.link?.state !== 'confirmed'
          ? 'link'
          : proposedTargetId === current.link.targetId
            ? 'keep'
            : 'replace',
      canConfirm: !staleInput && !conflicts.length,
      ...(ratingImpact ? { ratingImpact } : {}),
      ...(preferenceImpact ? { preferenceImpact } : {})
    }
  }
  private suppress(entityId: string, refs: MusicExternalReference[], reason: string, now: number) {
    for (const ref of refs)
      this.sql
        .prepare('INSERT OR REPLACE INTO metadata_identity_suppressions VALUES(?,?,?,?,?,?,?)')
        .run(entityId, ref.kind, ref.provider, ref.idType, ref.value, reason, now)
  }
  private markSuppressed(entityId: string, now: number) {
    this.sql
      .prepare(
        `UPDATE metadata_identity_candidates SET state='rejected',revision=revision+1,
      payload=json_set(payload,'$.state','rejected','$.suppressed',json('true'),'$.revision',revision+1,'$.updatedAt',?)
      WHERE entity_id=? AND EXISTS(SELECT 1 FROM json_each(payload,'$.references') r
        JOIN metadata_identity_suppressions s ON s.entity_id=metadata_identity_candidates.entity_id
        AND s.kind=json_extract(r.value,'$.kind') AND s.provider=json_extract(r.value,'$.provider')
        AND s.id_type=json_extract(r.value,'$.idType') AND s.value=json_extract(r.value,'$.value'))`
      )
      .run(now, entityId)
  }
  private legacy(
    link: MusicIdentityLink,
    refs: MusicExternalReference[],
    evidence: string,
    now: number
  ) {
    if (link.kind !== 'artist') return
    const mbid =
      refs.find((ref) => ref.provider === 'musicbrainz' && ref.idType === 'mbid')?.value ?? ''
    this.sql.prepare('INSERT OR IGNORE INTO metadata_subjects(id) VALUES(?)').run(link.entityId)
    this.sql
      .prepare(
        'UPDATE metadata_subjects SET target_id=?,mbid=?,state=?,revision=revision+1 WHERE id=?'
      )
      .run(link.targetId, mbid, link.state, link.entityId)
    this.sql
      .prepare(
        'INSERT INTO metadata_link_history(entity_id,target_id,mbid,state,evidence,changed_at) VALUES(?,?,?,?,?,?)'
      )
      .run(link.entityId, link.targetId, mbid, link.state, evidence, now)
  }
  private settleLegacyJobs(
    candidate: IdentificationCandidate,
    decision: 'confirm' | 'reject',
    now: number
  ) {
    const rows = this.sql
      .prepare(
        `SELECT id,payload FROM metadata_jobs WHERE entity_id=? AND state='needs_review'
      AND json_extract(payload,'$.candidateId')=?`
      )
      .all(candidate.entityId, candidate.id) as Row[]
    for (const row of rows) {
      const job = JSON.parse(String(row.payload)) as EntityMetadataJob
      if (job.type !== 'resolve' || !job.candidate) continue
      this.sql
        .prepare("UPDATE metadata_jobs SET state='completed',payload=? WHERE id=?")
        .run(
          JSON.stringify({
            ...job,
            state: 'completed',
            outcome: 'matched',
            reason: decision === 'confirm' ? 'confirmed' : 'rejected',
            updatedAt: now
          }),
          job.id
        )
    }
  }
  private settleIdentificationJobs(entityId: string, decision: 'confirm' | 'reject', now: number) {
    const rows = this.sql.prepare("SELECT payload FROM metadata_jobs WHERE entity_id=? AND state='needs_review'")
      .all(entityId) as Row[]
    for (const row of rows) {
      const job = JSON.parse(String(row.payload)) as EntityMetadataJob
      if (job.type !== 'identify' || !job.identification) continue
      const pending = job.identification.candidateIds.some(id =>
        this.sql.prepare("SELECT 1 FROM metadata_identity_candidates WHERE id=? AND state='candidate'").get(id))
      // Confirmation advances the link revision, closing this recall session.
      // Rejection leaves other candidates reviewable under the unchanged link.
      if (decision === 'reject' && pending) continue
      this.sql.prepare("UPDATE metadata_jobs SET state='completed',payload=? WHERE id=?").run(
        JSON.stringify({ ...job, state: 'completed', reason: decision === 'confirm' ? 'identity_confirmed' : 'candidates_reviewed', updatedAt: now }), job.id)
    }
  }
  decide(request: IdentificationDecision, now: number): MusicIdentityDetail {
    return this.applyDecision(request, now, 'manual')
  }
  /** Called only by finish, inside its generation/input-fenced transaction. */
  confirmVerified(input: IdentificationInput, candidates: IdentificationCandidate[], complete: boolean,
    adapterId: string, now: number): boolean {
    if (!complete || this.link(input.entityId)?.state !== 'unresolved') return false
    const eligible = candidates.filter(c => c.state === 'candidate' && !c.suppressed &&
      c.evidence.verification && !c.evidence.incomplete && !c.evidence.conflicts.length)
    if (eligible.length !== 1) return false
    const c = eligible[0], proof = c.evidence.verification!, ref = canonical(proof.reference)
    if (c.references.length !== 1 || refKey(c.references[0]) !== refKey(ref) ||
      ref.kind !== input.kind || c.provider !== ref.provider ||
      adapterId !== (ref.provider === 'musicbrainz' ? 'musicbrainz' : `platform.${ref.provider}`) ||
      this.suppressed(input.entityId, ref)) return false
    const sameSources = (ids: string[]) => JSON.stringify([...ids].sort()) === JSON.stringify([...proof.sourceIds].sort())
    if (proof.method === 'typed_id') {
      const ids = explicitMusicBrainzIds(input)
      if (ref.provider !== 'musicbrainz' || ref.idType !== 'mbid' || c.evidence.origin !== 'explicit_id' ||
        ids.size !== 1 || ids.get(ref.value) !== true || !sameSources(identityProofSources(input, ref))) return false
    } else if (proof.method === 'provider_native') {
      const ids = new Set((input.sources ?? []).filter(s => s.provider === ref.provider).flatMap(s => sourceNativeIds(input, s)))
      if (ref.provider === 'local' || ref.provider === 'musicbrainz' || ref.idType !== 'native' ||
        c.evidence.origin !== 'provider_native' || ids.size !== 1 || !ids.has(ref.value) ||
        !sameSources(identityProofSources(input, ref))) return false
    } else if (proof.method === 'album_tracks') {
      if (ref.provider !== 'musicbrainz' || ref.idType !== 'mbid' || c.evidence.origin !== 'album_tracks' ||
        !sameSources((input.sources ?? []).map(s => s.sourceId)) ||
        !['release', 'album_project'].includes(input.kind) ||
        ref.value !== (input.kind === 'release' ? proof.release.id : proof.release.projectId)) return false
      const validation = validateAlbumTracks(input, proof.release)
      if (validation.missing.length || validation.conflicts.length ||
        (input.kind === 'release' && (!validation.pressing || proof.matchedReleaseIds.length !== 1))) return false
      if (proof.matchedReleases?.some(release => {
        const comparison = validateAlbumTracks(input, release)
        return comparison.missing.length || comparison.conflicts.length || release.projectId !== proof.release.projectId
      })) return false
    } else if (proof.method === 'platform_album_tracks') {
      if (input.kind !== 'release' || c.evidence.origin !== 'album_tracks' ||
        !sameSources((input.sources ?? []).map(s => s.sourceId)) ||
        ref.provider !== proof.album.provider || ref.idType !== 'native' || ref.value !== proof.album.id ||
        proof.matchedAlbumIds.length !== 1 || proof.matchedAlbumIds[0] !== ref.value) return false
      const validation = validatePlatformAlbum(input, proof.album)
      if (validation.missing.length || validation.conflicts.length) return false
    } else return false
    const review = { candidateId: c.id, revision: c.revision, linkRevision: c.linkRevision }
    const preview = this.preview(review)
    if (!preview.canConfirm || preview.ratingImpact?.conflict || preview.preferenceImpact?.conflict) return false
    this.applyDecision({ ...review, decision: 'confirm' }, now, 'automatic')
    return true
  }
  private currentMemberParent(parent: AlbumMemberProof['parent']): boolean {
    const row = this.sql.prepare(`SELECT json_extract(h.evidence,'$.inputVersion') input_version FROM metadata_identity_history h
      JOIN metadata_identity_links l ON l.id=h.link_id JOIN catalog_entities e ON e.id=l.entity_id
      WHERE h.seq=? AND h.candidate_id=? AND h.state='confirmed' AND h.target_id=l.target_id
      AND l.entity_id=? AND l.state='confirmed' AND l.revision=? AND e.kind IN ('release','album_project')
      AND json_extract(h.evidence,'$.decision.mode')='automatic'
      AND json_extract(h.evidence,'$.decision.rule') IN ('album_tracks','platform_album_tracks')`)
      .get(parent.historySeq, parent.candidateId, parent.entityId, parent.linkRevision)
    return !!row && this.active(parent.entityId) && this.input(parent.entityId).version === row.input_version
  }
  /** Same finish transaction as the parent. No new queue and no name-wide binding. */
  confirmAlbumMembers(input: IdentificationInput, candidates: IdentificationCandidate[],
    snapshot: IdentificationMemberSnapshot | undefined, now: number): IdentificationMemberResult[] | undefined {
    if (!snapshot) return undefined
    const link = this.link(input.entityId)!
    const history = this.sql.prepare(`SELECT seq,candidate_id FROM metadata_identity_history
      WHERE link_id=? AND state='confirmed' ORDER BY seq DESC LIMIT 1`).get(link.id)
    const parent = candidates.find(c => c.id === history?.candidate_id), proof = parent?.evidence.verification
    if (!parent || !history || !proof || !['album_tracks', 'platform_album_tracks'].includes(proof.method)) return undefined
    let albums: AlbumMemberView[]
    if (proof.method === 'album_tracks') {
      // Old multi-pressing receipts omitted the other releases. They prove the
      // project only, not that the first pressing's child IDs apply to all.
      const releases = proof.matchedReleases ?? (proof.matchedReleaseIds.length === 1 ? [proof.release] : [])
      if (!releases.length) return undefined
      albums = releases.map(r => ({ id: r.id, tracks: r.tracks.map(t => ({ ...t, id: t.recordingId })) }))
    } else if (proof.method === 'platform_album_tracks') albums = [{ id: proof.album.id, tracks: proof.album.tracks }]
    else return undefined
    const receipt: AlbumMemberProof['parent'] = {
      entityId: input.entityId, candidateId: parent.id, historySeq: Number(history.seq),
      linkRevision: link.revision
    }
    if (!this.currentMemberParent(receipt)) return undefined
    return snapshot.items.map(expected => {
      const skipped = (reason: string): IdentificationMemberResult => ({
        entityId: expected.entityId, state: 'skipped', candidateIds: [], reason
      })
      if (this.memberStamp(expected.entityId) !== expected.inputStamp) return skipped('member_input_changed')
      const current = this.link(expected.entityId)
      if ((current?.revision ?? 0) !== expected.linkRevision) return skipped('member_link_changed')
      if (current && current.state !== 'unresolved') return skipped(`member_${current.state}`)
      const child = this.input(expected.entityId)
      if (child.kind !== expected.kind || !this.active(child.entityId)) return skipped('member_unavailable')
      const derived = albumMemberProposals(child, input, albums, {
        provider: proof.reference.provider, idType: proof.reference.idType
      }, receipt)
      if (!derived.proposals.length) return skipped(derived.reason ?? 'missing_member_identity')
      const saved = this.publish(child, derived.proposals, now)
      const eligible = saved.filter(c => c.state === 'candidate' && !c.suppressed &&
        !c.evidence.incomplete && !c.evidence.missing.length && !c.evidence.conflicts.length)
      if (eligible.length === 1) {
        const c = eligible[0], review = { candidateId: c.id, revision: c.revision, linkRevision: c.linkRevision }
        const preview = this.preview(review)
        if (preview.canConfirm && !preview.ratingImpact?.conflict && !preview.preferenceImpact?.conflict) {
          this.applyDecision({ ...review, decision: 'confirm' }, now, 'automatic')
          return { entityId: child.entityId, state: 'confirmed', candidateIds: saved.map(c => c.id), reason: null }
        }
      }
      return { entityId: child.entityId, state: saved.some(c => c.state === 'candidate') ? 'needs_review' : 'skipped',
        candidateIds: saved.map(c => c.id), reason: derived.reason ?? 'member_suppressed_or_conflicting' }
    })
  }
  private scheduleIdentity(entityId: string, targetId: string | null) {
    // Identity publication and its follow-up work share the same transaction.
    // A new reference can also unlock another source on this shared identity.
    this.sql.prepare(`INSERT INTO metadata_identification_schedule(entity_id,origin)
      SELECT id,'history' FROM catalog_entities WHERE id=? OR id IN (
        SELECT entity_id FROM metadata_identity_links WHERE target_id=? AND state='confirmed')
      ON CONFLICT(entity_id) DO UPDATE SET dirty=1`).run(entityId, targetId)
  }
  private applyDecision(request: IdentificationDecision, now: number, mode: 'manual' | 'automatic'): MusicIdentityDetail {
    if (!validIdentificationPayload('identification.decide', request))
      throw new Error('无效的识别决定')
    return this.transaction(() => {
      const { decision, ratingResolution, preferenceResolution, ...review } = request
      const preview = this.preview(review),
        candidate = preview.candidate
      if (preview.stale) throw stale()
      const link = this.ensure(candidate.entityId)
      if (mode === 'automatic' && (link.state !== 'unresolved' || candidate.suppressed ||
        preview.ratingImpact?.conflict || preview.preferenceImpact?.conflict || candidate.references.some(ref => this.suppressed(candidate.entityId, ref)))) return this.detail(candidate.entityId)
      const audit = JSON.stringify({ ...candidate, decision: {
        mode, ...(mode === 'automatic' ? { rule: candidate.evidence.verification!.method } : {}),
        ...(ratingResolution ? { ratingResolution } : {}),
        ...(preferenceResolution ? { preferenceResolution } : {})
      } })
      let targetId = preview.proposedTargetId
      if (decision === 'confirm') {
        if (!preview.canConfirm)
          throw Object.assign(new Error('外部引用已属于不同身份，请先复核关联冲突'), {
            code: 'IDENTITY_CONFLICT'
          })
        targetId ??= randomUUID()
        this.ratings.applyIdentity(candidate.entityId, candidate.kind, targetId, ratingResolution, now)
        this.preferences.applyIdentity(candidate.entityId, candidate.kind, targetId, preferenceResolution, now, candidate.references)
        if (link.state === 'confirmed' && link.targetId !== targetId) {
          this.suppress(link.entityId, this.references(link.targetId), 'replaced', now)
          this.markSuppressed(link.entityId, now)
          this.sql
            .prepare(
              "INSERT INTO metadata_identity_history(link_id,candidate_id,state,target_id,evidence,changed_at) VALUES(?,?,'replaced',?,?,?)"
            )
            .run(link.id, candidate.id, link.targetId, JSON.stringify(candidate), now)
        }
        // Independent UUIDs; deprecated columns cannot impose provider admission.
        this.sql
          .prepare("INSERT OR IGNORE INTO metadata_entities VALUES(?,'internal',?,?,?)")
          .run(targetId, candidate.kind, targetId, candidate.name)
        for (const ref of candidate.references) {
          this.sql
            .prepare('INSERT OR IGNORE INTO metadata_identity_refs VALUES(?,?,?,?,?)')
            .run(ref.provider, ref.kind, ref.idType, ref.value, targetId)
          this.sql
            .prepare(
              'DELETE FROM metadata_identity_suppressions WHERE entity_id=? AND kind=? AND provider=? AND id_type=? AND value=?'
            )
            .run(candidate.entityId, ref.kind, ref.provider, ref.idType, ref.value)
        }
        this.sql
          .prepare(
            "UPDATE metadata_identity_links SET target_id=?,state='confirmed',revision=revision+1 WHERE id=?"
          )
          .run(targetId, link.id)
        this.legacy(
          { ...link, targetId, state: 'confirmed' },
          this.references(targetId),
          audit,
          now
        )
      } else {
        if (
          candidate.state === 'confirmed' &&
          link.state === 'confirmed' &&
          link.targetId === targetId
        )
          throw new Error('该候选已关联，请使用解除关联')
        this.suppress(candidate.entityId, candidate.references, 'rejected', now)
      }
      this.save({
        ...candidate,
        state: decision === 'confirm' ? 'confirmed' : 'rejected',
        suppressed: decision === 'reject',
        revision: candidate.revision + 1,
        updatedAt: now
      })
      this.settleLegacyJobs(candidate, decision, now)
      this.settleIdentificationJobs(candidate.entityId, decision, now)
      this.sql
        .prepare(
          'INSERT INTO metadata_identity_history(link_id,candidate_id,state,target_id,evidence,changed_at) VALUES(?,?,?,?,?,?)'
        )
        .run(
          link.id,
          candidate.id,
          decision === 'confirm' ? 'confirmed' : 'rejected',
          targetId,
          audit,
          now
        )
      this.scheduleIdentity(candidate.entityId, targetId)
      return this.detail(candidate.entityId)
    })
  }
  detach(linkId: string, revision: number, now: number): MusicIdentityDetail {
    if (!validIdentificationPayload('identification.detach', { linkId, revision }))
      throw new Error('无效的解除关联请求')
    return this.transaction(() => {
      const row = this.sql
        .prepare('SELECT entity_id FROM metadata_identity_links WHERE id=?')
        .get(linkId) as Row | undefined
      if (!row) throw new Error('关联不存在')
      const link = this.link(String(row.entity_id))!
      if (link.revision !== revision) throw stale()
      if (link.state !== 'confirmed') throw new Error('当前没有已确认关联')
      const refs = this.references(link.targetId)
      this.suppress(link.entityId, refs, 'detached', now)
      this.markSuppressed(link.entityId, now)
      this.sql
        .prepare(
          "UPDATE metadata_identity_links SET state='detached',revision=revision+1 WHERE id=?"
        )
        .run(link.id)
      this.legacy({ ...link, state: 'detached' }, refs, '{}', now)
      this.sql
        .prepare(
          "INSERT INTO metadata_identity_history(link_id,state,target_id,evidence,changed_at) VALUES(?,'detached',?,'{}',?)"
        )
        .run(link.id, link.targetId, now)
      this.scheduleIdentity(link.entityId, link.targetId)
      return this.detail(link.entityId)
    })
  }
  legacyCandidate(entityId: string, candidate: ArtistIdentityCandidate, now: number) {
    const input = this.input(entityId)
    const [saved] = this.publish(
      input,
      [
        {
          provider: 'musicbrainz-wiki',
          name: candidate.name,
          summary: candidate.disambiguation,
          references: [
            { provider: 'musicbrainz', kind: 'artist', idType: 'mbid', value: candidate.mbid }
          ],
          matcherVersion: 'explicit-mbid-v1',
          evidence: {
            origin: 'explicit_id',
            matches: ['artist_mbid'],
            missing: [],
            conflicts: [],
            incomplete: false,
            provenance: JSON.stringify(candidate.evidence)
          }
        }
      ],
      now
    )
    return saved
  }
  /** Keep the explicit MBID API; its caller has already checked job generation/input. */
  legacyDecision(
    entityId: string,
    candidate: ArtistIdentityCandidate,
    decision: 'confirm' | 'reject',
    now: number
  ) {
    const saved = this.legacyCandidate(entityId, candidate, now)
    this.decide(
      {
        candidateId: saved.id,
        revision: saved.revision,
        linkRevision: saved.linkRevision,
        decision
      },
      now
    )
    if (decision === 'reject') {
      // Preserve the old rejected-link readback without erasing a confirmed link.
      this.sql
        .prepare(
          "UPDATE metadata_subjects SET mbid=?,state='rejected',revision=revision+1 WHERE id=? AND (state IS NULL OR state<>'confirmed')"
        )
        .run(candidate.mbid.toLowerCase(), entityId)
      this.sql
        .prepare(
          "INSERT INTO metadata_link_history(entity_id,mbid,state,evidence,changed_at) VALUES(?,?,'rejected',?,?)"
        )
        .run(entityId, candidate.mbid.toLowerCase(), JSON.stringify(candidate), now)
    }
  }
  legacyDetach(entityId: string, now: number) {
    const link = this.ensure(entityId)
    if (link.state === 'confirmed') return this.detach(link.id, link.revision, now)
    // M2.1 also allowed clearing a rejected/unresolved artist.
    this.sql
      .prepare("UPDATE metadata_identity_links SET state='detached',revision=revision+1 WHERE id=?")
      .run(link.id)
    this.legacy({ ...link, state: 'detached' }, this.references(link.targetId), '{}', now)
    this.scheduleIdentity(entityId, link.targetId)
    return this.detail(entityId)
  }
  migrateLegacyCandidates() {
    for (const row of this.sql
      .prepare(
        `SELECT j.entity_id,j.input,j.payload FROM metadata_jobs j
        JOIN catalog_entities e ON e.id=j.entity_id AND e.kind='artist' WHERE j.state='needs_review'`
      )
      .iterate()) {
      const job = JSON.parse(String(row.payload)) as EntityMetadataJob
      if (job.type !== 'resolve' || !job.candidate) continue
      const entity = this.entity(String(row.entity_id))
      const subject = this.sql
        .prepare('SELECT revision FROM metadata_subjects WHERE id=?')
        .get(String(row.entity_id)) as Row | undefined
      const legacyInput = JSON.stringify([entity.title, entity.artist, subject?.revision ?? 0])
      if (String(row.input) === legacyInput && this.active(String(row.entity_id))) {
        const candidate = this.legacyCandidate(String(row.entity_id), job.candidate, job.updatedAt)
        this.sql
          .prepare('UPDATE metadata_jobs SET payload=? WHERE id=?')
          .run(JSON.stringify({ ...job, candidateId: candidate.id }), job.id)
      }
    }
  }
}
