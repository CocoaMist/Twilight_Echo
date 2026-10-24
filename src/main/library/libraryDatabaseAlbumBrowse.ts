import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type {
  AlbumBrowsePage,
  AlbumBrowseProject,
  AlbumBrowseQuery,
  AlbumBrowseReadContext,
  AlbumBrowseRelease,
  AlbumBrowseScope,
  AlbumBrowseSource,
  AlbumBrowseToken,
  AlbumSourcesPage,
  AlbumSourcesQuery
} from '../../shared/musicAlbumBrowse.ts'
import { validAlbumBrowsePayload, validAlbumBrowseScope } from '../../shared/musicAlbumBrowse.ts'
import { classificationDimensionsContext } from './libraryDatabaseClassificationDimensions.ts'

type Row = Record<string, unknown>
export interface AlbumBrowseOwner {
  sql: DatabaseSync
  contentRevision(): number
  metadataRevision(): number
  now?(): number
}
const stale = () =>
  Object.assign(new Error('专辑、版本或资料已变化，请重新读取'), { code: 'STALE_REVISION' })
const invalid = () => Object.assign(new Error('专辑浏览参数无效'), { code: 'INVALID_PAYLOAD' })
const str = (value: unknown) => (typeof value === 'string' ? value : '')
const display = (value: unknown) => str(value).slice(0, 32768)
const nullable = (value: unknown) => (value === null || value === undefined ? null : String(value))
const releaseColumns = [
  'id',
  'entity_id',
  'metadata_target',
  'current',
  'source_count',
  'playback_version_count',
  'title',
  'artist'
]
const rowJson = (alias: string, columns: string[]) =>
  `json_object(${columns.map((column) => `'${column}',${alias}.${column}`).join(',')})`

/**
 * Library membership and manual playback bindings are authoritative. Metadata identity
 * only groups confirmed projects/releases; it never rewrites either source binding.
 */
const ALBUM_CTES = `
  album_args(entity_id) AS (VALUES (?)),
  album_members AS MATERIALIZED (
    SELECT s.id,s.provider,s.recording,s.release_id,s.release,s.preferred_release,s.availability
    FROM catalog_bindings s LEFT JOIN tracks t
      ON s.provider='local' AND t.id=s.track_id
    WHERE s.release_id IS NOT NULL
      AND EXISTS(SELECT 1 FROM catalog_memberships m WHERE m.source_id=s.id)
      AND (s.provider<>'local' OR (t.id IS NOT NULL AND NOT EXISTS(
        SELECT 1 FROM catalog_pending p WHERE p.track_id=s.track_id)))),
  album_relations AS (
    SELECT s.*,p.project_id,pp.project_id playback_project_id,
      rl.target_id release_target,pl.target_id project_target,
      CASE WHEN rl.target_id IS NOT NULL THEN 'metadata:'||rl.target_id
        ELSE 'catalog:'||s.release_id END release_group,
      CASE WHEN pl.target_id IS NOT NULL THEN 'metadata:'||pl.target_id
        WHEN p.project_id IS NOT NULL THEN 'catalog:'||p.project_id
        ELSE 'release:'||s.release_id END project_group
    FROM album_members s JOIN catalog_entities e ON e.id=s.release_id AND e.kind='release'
    LEFT JOIN catalog_release_projects p ON p.release_id=s.release_id
    LEFT JOIN catalog_release_projects pp ON pp.release_id=s.release
    LEFT JOIN metadata_identity_links rl ON rl.entity_id=s.release_id
      AND rl.kind='release' AND rl.state='confirmed' AND rl.target_id IS NOT NULL
    LEFT JOIN metadata_identity_links pl ON pl.entity_id=p.project_id
      AND pl.kind='album_project' AND pl.state='confirmed' AND pl.target_id IS NOT NULL),
  album_requested AS (
    SELECT r.* FROM album_relations r CROSS JOIN album_args a
    WHERE r.release=a.entity_id OR r.release_id=a.entity_id OR r.project_id=a.entity_id
      OR r.playback_project_id=a.entity_id),
  album_anchor AS (
    SELECT r.* FROM album_requested r CROSS JOIN album_args a
    ORDER BY CASE WHEN r.release_id=a.entity_id THEN 0 ELSE 1 END,
      r.preferred_release DESC,r.release_id,r.id LIMIT 1),
  album_requested_projects AS (SELECT DISTINCT project_group FROM album_requested),
  album_project_sources AS (
    SELECT r.* FROM album_relations r JOIN album_requested_projects p USING(project_group)),
  album_release_groups AS (
    SELECT r.release_group id,
      coalesce(min(CASE WHEN r.release_id=a.release_id THEN r.release_id END),min(r.release_id)) entity_id,
      min(r.release_target) metadata_target,
      max(CASE WHEN r.release_group=a.release_group THEN 1 ELSE 0 END) current,
      count(DISTINCT r.id) source_count,count(DISTINCT r.release) playback_version_count
    FROM album_project_sources r CROSS JOIN album_anchor a GROUP BY r.release_group),
  album_releases AS (
    SELECT g.*,e.title,e.artist FROM album_release_groups g JOIN catalog_entities e ON e.id=g.entity_id)
`

/** Read-only bounded project → releases → sources. No network or ingestion side effects. */
export class LibraryDatabaseAlbumBrowse {
  private readonly owner: AlbumBrowseOwner
  private readClock = 0
  constructor(owner: AlbumBrowseOwner) {
    this.owner = owner
  }
  private get sql() {
    return this.owner.sql
  }

  private read<T>(action: () => { token: AlbumBrowseToken; result: T }): T {
    const previousClock = this.readClock,
      ownTransaction = !this.sql.isTransaction
    this.readClock = this.owner.now?.() ?? Date.now()
    try {
      if (ownTransaction) this.sql.exec('BEGIN')
      const { token, result } = action()
      if (token.expiresAt !== null && (this.owner.now?.() ?? Date.now()) >= token.expiresAt)
        throw stale()
      if (ownTransaction) this.sql.exec('COMMIT')
      return result
    } catch (error) {
      if (ownTransaction && this.sql.isTransaction) this.sql.exec('ROLLBACK')
      throw error
    } finally {
      this.readClock = previousClock
    }
  }

  private token(expected: AlbumBrowseToken | undefined, context: AlbumBrowseReadContext) {
    const now = this.readClock
    const token: AlbumBrowseToken = {
      genresRevision: Number(
        this.sql.prepare("SELECT value FROM music_genre_state WHERE key='revision'").get()!.value
      ),
      catalogRevision: Number(
        this.sql.prepare("SELECT value FROM catalog_state WHERE key='revision'").get()!.value
      ),
      contentRevision: this.owner.contentRevision(),
      metadataRevision: this.owner.metadataRevision(),
      asOf: expected?.asOf ?? now,
      ...classificationDimensionsContext(this.sql, context, now)
    }
    if (
      expected &&
      (expected.asOf > now ||
        (expected.expiresAt !== null && expected.expiresAt <= now) ||
        Object.keys(token).some(
          (key) => token[key as keyof AlbumBrowseToken] !== expected[key as keyof AlbumBrowseToken]
        ))
    )
      throw stale()
    return token
  }

  private query(sql: string, entityId: string, values: SQLInputValue[] = []): Row[] {
    return this.sql.prepare(`WITH ${ALBUM_CTES} ${sql}`).all(entityId, ...values)
  }
  private release(row: Row): AlbumBrowseRelease {
    return {
      id: str(row.id),
      entityId: str(row.entity_id),
      title: display(row.title),
      artist: display(row.artist),
      current: !!row.current,
      identity: row.metadata_target === null ? 'unidentified' : 'confirmed',
      metadataTargetId: nullable(row.metadata_target),
      sourceCount: Number(row.source_count),
      playbackVersionCount: Number(row.playback_version_count)
    }
  }
  private project(row: Row | null): AlbumBrowseProject | null {
    return row
      ? {
          entityId: str(row.id),
          title: display(row.title),
          artist: display(row.artist),
          identity: row.project_target === null ? 'unidentified' : 'confirmed',
          metadataTargetId: nullable(row.project_target)
        }
      : null
  }
  browse(query: AlbumBrowseQuery, context: AlbumBrowseReadContext = {}): AlbumBrowsePage {
    if (!validAlbumBrowsePayload('albums.browse', query)) throw invalid()
    return this.read(() => {
      const token = this.token(query.token, context),
        offset = query.offset ?? 0
      // One graph serves the heading, exact counts, current release and bounded
      // page. Do not rebuild the whole library for each part of one response.
      const row = this.query(
        `, album_page AS MATERIALIZED (
        SELECT * FROM album_releases ORDER BY current DESC,title COLLATE NOCASE,id LIMIT ? OFFSET ?)
        SELECT (SELECT count(*) FROM album_requested_projects) project_count,
          (SELECT count(*) FROM album_releases) total,
          (SELECT ${rowJson('r', releaseColumns)} FROM album_releases r WHERE current=1) current_release,
          (SELECT json_object('id',e.id,'title',e.title,'artist',e.artist,'project_target',a.project_target)
            FROM album_anchor a JOIN catalog_entities e ON e.id=a.project_id
            WHERE (SELECT count(*) FROM album_requested_projects)=1) project,
          (SELECT json_group_array(${rowJson('p', releaseColumns)})
            FROM (SELECT * FROM album_page ORDER BY current DESC,title COLLATE NOCASE,id) p) items`,
        query.entityId,
        [query.limit ?? 20, offset]
      )[0]
      const current = JSON.parse(str(row.current_release) || 'null') as Row | null
      const result: AlbumBrowsePage = {
        token,
        project: this.project(JSON.parse(str(row.project) || 'null') as Row | null),
        projectCount: Number(row.project_count),
        currentRelease: current ? this.release(current) : null,
        offset,
        total: Number(row.total),
        items: (JSON.parse(str(row.items)) as Row[]).map((item) => this.release(item)),
        externalCatalog: 'unavailable'
      }
      return { token, result }
    })
  }

  sources(query: AlbumSourcesQuery, context: AlbumBrowseReadContext = {}): AlbumSourcesPage {
    if (!validAlbumBrowsePayload('albums.sources', query)) throw invalid()
    return this.read(() => {
      const token = this.token(query.token, context),
        offset = query.offset ?? 0
      const columns = [
        'id',
        'provider',
        'recording',
        'availability',
        'preferred_release',
        'release_target',
        'project_target',
        'title',
        'artist',
        'album',
        'version_id',
        'version_entity',
        'version_label',
        'family_id',
        'preferred_version',
        'version_target',
        'version_project_target'
      ]
      const row = this.query(
        `, album_selected_release AS MATERIALIZED (
          SELECT * FROM album_releases WHERE id=?),
        album_selected_sources AS MATERIALIZED (
          SELECT s.* FROM album_project_sources s JOIN album_selected_release r ON r.id=s.release_group),
        album_source_page AS MATERIALIZED (
          SELECT s.*,coalesce(CAST(json_extract(c.payload,'$.discNumber') AS INTEGER),0) disc_position,
            coalesce(CAST(json_extract(c.payload,'$.trackNumber') AS INTEGER),0) track_position
          FROM album_selected_sources s JOIN catalog_sources c ON c.id=s.id
          ORDER BY s.preferred_release DESC,disc_position,track_position,s.id LIMIT ? OFFSET ?),
        album_source_details AS (
          SELECT s.*,json_extract(c.payload,'$.title') title,json_extract(c.payload,'$.artist') artist,
          json_extract(c.payload,'$.album') album,v.id version_id,v.entity_id version_entity,v.label version_label,
          v.family_id,v.preferred_version,vl.target_id version_target,vpl.target_id version_project_target
        FROM album_source_page s JOIN catalog_sources c ON c.id=s.id LEFT JOIN catalog_versions v
          ON v.scope='albums' AND v.entity_id=s.release
        LEFT JOIN metadata_identity_links vl ON vl.entity_id=v.entity_id
          AND vl.kind='release' AND vl.state='confirmed' AND vl.target_id IS NOT NULL
        LEFT JOIN metadata_identity_links vpl ON vpl.entity_id=s.playback_project_id
          AND vpl.kind='album_project' AND vpl.state='confirmed' AND vpl.target_id IS NOT NULL
        ) SELECT (SELECT ${rowJson('r', releaseColumns)} FROM album_selected_release r) release,
          (SELECT count(DISTINCT provider) FROM album_selected_sources) provider_count,
          (SELECT json_group_array(provider) FROM (
            SELECT DISTINCT provider FROM album_selected_sources ORDER BY provider LIMIT 128)) providers,
          (SELECT json_group_array(${rowJson('d', columns)}) FROM (
            SELECT * FROM album_source_details ORDER BY preferred_release DESC,disc_position,track_position,id) d) items`,
        query.entityId,
        [query.releaseId, query.limit ?? 20, offset]
      )[0]
      const selected = JSON.parse(str(row.release) || 'null') as Row | null
      const release = selected ? this.release(selected) : null
      const items = (JSON.parse(str(row.items)) as Row[]).map(
        (row): AlbumBrowseSource => ({
          sourceId: str(row.id),
          provider: str(row.provider),
          recordingId: str(row.recording),
          title: display(row.title),
          artist: display(row.artist),
          album: display(row.album),
          availability: row.availability as AlbumBrowseSource['availability'],
          preferred: !!row.preferred_release,
          playbackVersion:
            row.version_id === null
              ? null
              : {
                  id: str(row.version_id),
                  entityId: str(row.version_entity),
                  label: display(row.version_label),
                  familyId: nullable(row.family_id),
                  preferredVersionId: nullable(row.preferred_version),
                  metadataTargetId: nullable(row.version_target),
                  projectMetadataTargetId: nullable(row.version_project_target)
                },
          identityConflict:
            (row.release_target !== null &&
              row.version_target !== null &&
              row.release_target !== row.version_target) ||
            (row.project_target !== null &&
              row.version_project_target !== null &&
              row.project_target !== row.version_project_target)
        })
      )
      const result: AlbumSourcesPage = {
        token,
        release,
        offset,
        total: release?.sourceCount ?? 0,
        items,
        providers: JSON.parse(str(row.providers)) as string[],
        providerCount: Number(row.provider_count)
      }
      return { token, result }
    })
  }

  containsSource(
    scope: AlbumBrowseScope,
    sourceId: string,
    context: AlbumBrowseReadContext = {}
  ): boolean {
    if (
      !validAlbumBrowseScope(scope) ||
      typeof sourceId !== 'string' ||
      !sourceId ||
      sourceId.length > 128 ||
      sourceId.includes('\0')
    )
      throw invalid()
    return this.read(() => {
      const token = this.token(scope.token, context)
      return {
        token,
        result:
          this.query(
            `SELECT 1 FROM album_project_sources WHERE release_group=? AND id=? LIMIT 1`,
            scope.entityId,
            [scope.releaseId, sourceId]
          ).length > 0
      }
    })
  }
}
