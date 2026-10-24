import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename, isAbsolute } from 'node:path'
import { performance } from 'node:perf_hooks'
import { LibraryDatabase } from '../../src/main/library/libraryDatabase.ts'
import type { TrackData } from '../../src/shared/track.ts'

export interface MixedLibraryOptions {
  perSource?: number
  cached?: number
  root?: string
  reuseRoot?: string
  progress?: (phase: string) => void
}

function expectedMixedLibrary(perSource: number, cached: number) {
  const confirmedPairs = perSource / 10
  return {
    localTracks: perSource, platformMembers: perSource, cacheOnlySources: cached,
    librarySources: perSource * 2, catalogSources: perSource * 2 + cached,
    confirmedPairs, libraryRecordings: perSource * 2 - confirmedPairs,
    catalogRecordings: perSource * 2 + cached - confirmedPairs,
    catalogBindingLibraryRecordings: perSource * 2,
    jazzLibraryBindingRecordings: perSource,
    jazzLibraryRecordings: perSource - confirmedPairs / 2,
    libraryReleases: perSource / 5, projectReleases: Math.min(30, perSource / 10) * 2,
    anchorReleaseSources: 10, ratedFourStars: 1, banned: 1, taggedRecordings: 10
  }
}

/** Reproducible values through real ingestion; cache-only rows remain non-members. No HTTP. */
export async function openMixedLibraryFixture(options: MixedLibraryOptions = {}) {
  const perSource = options.perSource ?? 50_000, cached = options.cached ?? 1000
  assert.ok(Number.isSafeInteger(perSource) && perSource >= 20 && perSource % 20 === 0)
  assert.ok(Number.isSafeInteger(cached) && cached >= 0)
  assert.ok(!(options.root && options.reuseRoot), 'Choose root for ingestion or reuseRoot for existing data')
  if (options.reuseRoot !== undefined) assert.ok(isAbsolute(options.reuseRoot), 'reuseRoot must be an absolute path')
  const mode = options.reuseRoot !== undefined ? 'reused' as const : 'seeded' as const
  const ownRoot = !options.root && mode === 'seeded'
  const root = options.reuseRoot !== undefined ? resolve(options.reuseRoot) : options.root ?? mkdtempSync(join(tmpdir(), 'twilight-mixed-library-'))
  const databasePath = join(root, 'music-library.sqlite')
  if (mode === 'reused') assert.ok(existsSync(databasePath), `Cannot reuse missing fixture: ${databasePath}`)
  const database = new LibraryDatabase(databasePath), expected = expectedMixedLibrary(perSource, cached)
  const phaseTimingsMs: Record<string, number> = {}
  const finish = () => {
    assert.equal(Number(database.sql.prepare('SELECT count(*) n FROM catalog_sources').get()!.n), expected.catalogSources)
    assert.equal(Number(database.sql.prepare('SELECT count(DISTINCT source_id) n FROM catalog_memberships').get()!.n), expected.librarySources)
    const anchor = database.sql.prepare("SELECT id,recording_id,release_id FROM catalog_sources WHERE provider='local' AND track_id='mixed-local-0'").get()
    const tag = database.sql.prepare("SELECT id FROM personal_tags WHERE profile_id='default' AND name='Mixed fixture album'").get()
    assert.ok(anchor && tag, 'Existing fixture must contain its anchor and album tag')
    return { database, root, databasePath, expected, tagId: String(tag.id), phaseTimingsMs, mode,
      anchor: { localTrackId: 'mixed-local-0', sourceId: String(anchor.id), recordingId: String(anchor.recording_id), releaseId: String(anchor.release_id) },
      close() {
        database.close()
        if (ownRoot) {
          assert.equal(dirname(resolve(root)), resolve(tmpdir()))
          assert.ok(basename(root).startsWith('twilight-mixed-library-'))
          rmSync(root, { recursive: true, force: true })
        }
      }
    }
  }
  let phase = '', phaseStarted = performance.now()
  const progress = (next: string) => {
    if (phase) phaseTimingsMs[phase] = performance.now() - phaseStarted
    phase = next; phaseStarted = performance.now(); options.progress?.(next)
  }
  const track = (i: number, provider: 'local' | 'ncm'): TrackData => ({
    id: provider === 'local' ? `mixed-local-${i}` : `ncm:${i + 1}`,
    source: provider,
    title: `Mixed ${String(i).padStart(6, '0')}`,
    artist: `Artist ${Math.floor(i / 100)}`,
    album: `Album ${Math.floor(i / 10)}`,
    ...(provider === 'ncm' ? { albumId: `album-${Math.floor(i / 10)}`, ncmSongId: i + 1 } : {}),
    filePath: provider === 'local' ? join(root, 'media', `${i}.flac`) : '',
    fileName: `${i}.flac`, size: 1000000, duration: 180 + i % 60,
    cover: null, lyrics: null, genre: i % 2 ? 'Rock' : 'Jazz',
    format: provider === 'local' ? 'flac' : 'aac', bitDepth: provider === 'local' ? 24 : 16,
    sampleRate: 44100, releaseDate: `20${String(i % 25).padStart(2, '0')}-01-01`
  })
  try {
    if (mode === 'reused') {
      options.progress?.('reuse-existing-fixture')
      database.sql.exec('PRAGMA query_only=ON')
      return finish()
    }
    progress('local-ingestion')
    database.replaceDocument({ version: 2, revision: 1, folders: [join(root, 'media')], exclusions: [],
      tracks: Array.from({ length: perSource }, (_, i) => track(i, 'local')) })
    progress('local-catalog-maintenance')
    while (database.catalogStatus().localPending) database.catalogAdvance(200)
    progress('platform-ingestion')
    let job = database.catalogSync({ kind: 'begin', revision: 1 })
    for (let i = 0; i < perSource + cached; i += 200) {
      job = database.catalogSync({ kind: 'append', ...job,
        tracks: Array.from({ length: Math.min(200, perSource + cached - i) }, (_, j) => track(i + j, 'ncm')) })
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    database.catalogSync({ kind: 'commit', ...job })
    // These rows remain cached after removal from the user's library.
    const deleteMembership = database.sql.prepare('DELETE FROM catalog_memberships WHERE source_id IN (SELECT id FROM catalog_sources WHERE provider=\'ncm\' AND track_id=?)')
    database.sql.exec('BEGIN IMMEDIATE')
    for (let i = perSource; i < perSource + cached; i++) deleteMembership.run(`ncm:${i + 1}`)
    database.sql.exec('COMMIT')
    progress('genre-maintenance')
    while (database.genresAdvance(200).pending) await new Promise<void>(resolve => setImmediate(resolve))
    progress('confirmed-identities-and-personal-state')
    const source = database.sql.prepare('SELECT id,recording_id,release_id FROM catalog_sources WHERE provider=? AND track_id=?')
    const local = (i: number) => source.get('local', `mixed-local-${i}`)!
    const online = (i: number) => source.get('ncm', `ncm:${i + 1}`)!
    const confirmedPairs = perSource / 10
    const entity = database.sql.prepare('INSERT INTO metadata_entities VALUES(?,?,?,?,?)')
    const link = database.sql.prepare("INSERT INTO metadata_identity_links VALUES(?,?,?,1,?,'confirmed')")
    database.sql.exec('BEGIN IMMEDIATE')
    for (let i = 0; i < confirmedPairs; i++) {
      const target = `mixed-recording-${i}`
      entity.run(target, 'fixture', 'recording', target, `Mixed ${i}`)
      for (const row of [local(i), online(i)]) link.run(`link:${row.recording_id}`, row.recording_id!, 'recording', target)
    }
    // First up to 30 albums per source are distinct editions of one confirmed project.
    const projectReleaseCountPerSource = Math.min(30, perSource / 10)
    entity.run('mixed-project', 'fixture', 'album_project', 'mixed-project', 'Mixed edition family')
    const project = database.sql.prepare('SELECT project_id FROM catalog_release_projects WHERE release_id=?')
    for (let i = 0; i < projectReleaseCountPerSource; i++) {
      for (const row of [local(i * 10), online(i * 10)]) {
        const id = project.get(row.release_id!)!.project_id!
        link.run(`link:${id}`, id, 'album_project', 'mixed-project')
      }
    }
    database.sql.exec('COMMIT')
    const rated = String(local(perSource - 1).recording_id), banned = String(local(perSource - 2).recording_id)
    database.ratingsSet({ entityId: rated, steps: 8, token: database.ratingsDetail(rated).token }, 1700000000000)
    database.preferencesSet({ entityId: banned, state: 'ban', token: database.preferencesDetail(banned).token }, 1700000000001)
    const tag = database.tagsCreate({ name: 'Mixed fixture album', tagsRevision: database.tagsState().tagsRevision }, 1700000000002).tag
    const anchor = local(0)
    database.tagsMemberSet({ tagId: tag.id, entityId: String(anchor.release_id), present: true, membersRevision: 0 }, 1700000000003)
    progress('ready')
    return finish()
  } catch (error) { database.close(); throw error }
}
