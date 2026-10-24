import { BROWSE_REVISION_OBJECTS, PERSONAL_METADATA_REVISION_OBJECTS, PERSONAL_METADATA_TABLES } from './libraryDatabaseBrowseRevision.ts'
import { EXPLORATION_SCHEMA_OBJECTS } from './libraryDatabaseExploration.ts'
import { PREFERENCE_WORK_MIGRATION_SQL } from './libraryDatabasePreferences.ts'

/** Real pre-v27 graph absence and old personal kind constraints. */
export const LEGACY_PERSONAL_METADATA_SCHEMA_SQL = PERSONAL_METADATA_REVISION_OBJECTS.map(name => `DROP TRIGGER IF EXISTS ${name};`).join('') +
  PERSONAL_METADATA_TABLES.map(name => `DROP TABLE IF EXISTS ${name};`).join('')
export const LEGACY_EXPLORATION_SCHEMA_SQL = LEGACY_PERSONAL_METADATA_SCHEMA_SQL + EXPLORATION_SCHEMA_OBJECTS.filter(n =>
  n.endsWith('_insert') || n.endsWith('_update') || n.endsWith('_delete'))
  .map(n => `DROP TRIGGER IF EXISTS ${n};`).join('') + `
  DROP TABLE IF EXISTS music_exploration_relations;
  DROP TABLE IF EXISTS music_exploration_sets;
  DROP TABLE IF EXISTS music_exploration_refs;
  DROP TABLE IF EXISTS music_exploration_state;
  ` + PREFERENCE_WORK_MIGRATION_SQL.replaceAll("'artist','work'", "'artist'")

/** Recreate a real pre-v26 profile without saved Focus queries. */
export const LEGACY_FOCUS_SCHEMA_SQL = LEGACY_EXPLORATION_SCHEMA_SQL + 'DROP TABLE IF EXISTS personal_focus_queries; DROP TABLE IF EXISTS personal_focus_state;'

/** Recreate a real pre-v25 profile without tags or their identity revision triggers. */
export const LEGACY_TAG_SCHEMA_SQL = LEGACY_FOCUS_SCHEMA_SQL + `
DROP TRIGGER IF EXISTS personal_tags_identity_insert;
DROP TRIGGER IF EXISTS personal_tags_identity_update;
DROP TRIGGER IF EXISTS personal_tags_identity_delete;
DROP TABLE IF EXISTS personal_tag_members;
DROP TABLE IF EXISTS personal_tags;
DROP TABLE IF EXISTS personal_tags_state;
`

/** Recreate a real pre-v24 profile, including the absence of the new playlist authority. */
export const LEGACY_PREFERENCE_SCHEMA_SQL = LEGACY_TAG_SCHEMA_SQL + `
DROP TRIGGER IF EXISTS personal_preferences_identity_insert;
DROP TRIGGER IF EXISTS personal_preferences_identity_update;
DROP TRIGGER IF EXISTS personal_preferences_identity_delete;
DROP TRIGGER IF EXISTS personal_preferences_playlist_revision;
DROP TABLE IF EXISTS personal_preference_history;
DROP TABLE IF EXISTS personal_preference_values;
DROP TABLE IF EXISTS personal_preference_playlists;
DROP TABLE IF EXISTS personal_preference_restores;
DROP TABLE IF EXISTS personal_preferences_state;
`

/** Recreate a real pre-v23 profile, not just an older version pragma. */
export const LEGACY_RATING_SCHEMA_SQL = LEGACY_PREFERENCE_SCHEMA_SQL + `
DROP TRIGGER IF EXISTS personal_ratings_identity_insert;
DROP TRIGGER IF EXISTS personal_ratings_identity_update;
DROP TRIGGER IF EXISTS personal_ratings_identity_delete;
DROP TABLE IF EXISTS personal_rating_history;
DROP TABLE IF EXISTS personal_rating_values;
DROP TABLE IF EXISTS personal_ratings_state;
`
export const LEGACY_BROWSE_REVISION_SQL = LEGACY_RATING_SCHEMA_SQL + BROWSE_REVISION_OBJECTS.filter(name => name !== 'music_browse_state')
  .map(name => `DROP TRIGGER IF EXISTS ${name};`).join('') + 'DROP TABLE IF EXISTS music_browse_state;'

/** Recreate the actual pre-v11 tables when a migration fixture starts from a
 * fresh database. A version pragma alone would no longer describe old storage. */
export const LEGACY_MUSIC_TASKS_SQL = LEGACY_BROWSE_REVISION_SQL + 'DROP INDEX metadata_jobs_legacy_batch; DROP TABLE metadata_legacy_inputs; DROP TABLE metadata_legacy_batches; ALTER TABLE metadata_legacy_documents DROP COLUMN input_revision;'
export const LEGACY_MUSIC_METADATA_SQL = LEGACY_MUSIC_TASKS_SQL + 'DROP TABLE metadata_legacy_bindings; DROP TABLE metadata_legacy_albums; DROP TABLE metadata_legacy_documents; DROP TABLE metadata_legacy_history;'
export const LEGACY_METADATA_DETAILS_SQL = LEGACY_MUSIC_METADATA_SQL + 'DROP TABLE metadata_credits; DROP TABLE metadata_credit_sets;'
export const LEGACY_IDENTIFICATION_SCHEDULE_SQL = LEGACY_METADATA_DETAILS_SQL + `
  DROP TRIGGER metadata_schedule_input_insert; DROP TRIGGER metadata_schedule_input_update;
  DROP TRIGGER metadata_schedule_member_insert; DROP TRIGGER metadata_schedule_member_delete;
  DROP TABLE metadata_identification_schedule; DROP TABLE metadata_identification_schedule_state;
`
export const LEGACY_IDENTIFICATION_ALBUM_FENCE_SQL = LEGACY_IDENTIFICATION_SCHEDULE_SQL + `
  DROP TRIGGER metadata_identification_album_cohort;
  DROP INDEX metadata_identity_history_link;
`
export const LEGACY_IDENTIFICATION_SOURCE_FENCE_SQL = LEGACY_IDENTIFICATION_ALBUM_FENCE_SQL + `
  DROP INDEX catalog_source_album_key;
  DROP TRIGGER metadata_identification_source_before; DROP TRIGGER metadata_identification_source_after;
  DROP TRIGGER metadata_identification_source_insert;
  DROP TRIGGER metadata_identification_credit_insert; DROP TRIGGER metadata_identification_credit_delete;
`
export const LEGACY_IDENTIFICATION_SCHEMA_SQL = LEGACY_IDENTIFICATION_SOURCE_FENCE_SQL + `
  DROP INDEX metadata_link_history_identity;
  DROP TRIGGER metadata_identification_input_changed; DROP TABLE metadata_identification_inputs;
  DROP TABLE metadata_identity_candidates; DROP TABLE metadata_identity_suppressions;
  DROP TABLE metadata_identity_history; DROP TABLE metadata_identity_links; DROP TABLE metadata_identity_refs;
  DROP TABLE catalog_release_projects; DROP INDEX catalog_entities_kind;
  DELETE FROM catalog_entities WHERE kind='album_project';
  DELETE FROM catalog_state WHERE key IN ('project_cursor','project_horizon');
  DROP VIEW catalog_entity_sources;
  CREATE VIEW catalog_entity_sources AS
    SELECT recording AS entity_id,id AS source_id FROM catalog_bindings
    UNION ALL SELECT release,id FROM catalog_bindings WHERE release IS NOT NULL
    UNION ALL SELECT artist_id,source_id FROM catalog_source_artists;
`
export const LEGACY_METADATA_SCHEMA_SQL = LEGACY_IDENTIFICATION_SCHEMA_SQL + `
  DROP TABLE metadata_demands; DROP TABLE metadata_jobs; DROP TABLE metadata_overrides;
  DROP TABLE metadata_facts; DROP TABLE metadata_subjects; DROP TABLE metadata_link_history; DROP TABLE metadata_entities;
`
export const LEGACY_CATALOG_SCHEMA_SQL = LEGACY_METADATA_SCHEMA_SQL + `
  DROP VIEW catalog_entity_sources; DROP VIEW catalog_bindings;
  DROP TRIGGER catalog_tracks_ai; DROP TRIGGER catalog_tracks_au; DROP TRIGGER catalog_tracks_ad;
  DROP TABLE catalog_version_sources; DROP TABLE catalog_versions;
  DROP TABLE catalog_import_members; DROP TABLE catalog_imports;
  DROP TABLE catalog_memberships; DROP TABLE catalog_facts; DROP TABLE catalog_source_artists;
  DROP TABLE catalog_sources; DROP TABLE catalog_aliases; DROP TABLE catalog_entities;
  DROP TABLE catalog_pending; DROP TABLE catalog_state;
`
export const LEGACY_QUEUE_SCHEMA_SQL = LEGACY_CATALOG_SCHEMA_SQL + `
  CREATE TABLE legacy_queue_entries(queue_id TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE,position INTEGER NOT NULL,entry_id TEXT NOT NULL UNIQUE,track_id TEXT NOT NULL,original_position INTEGER NOT NULL,PRIMARY KEY(queue_id,position));
  INSERT INTO legacy_queue_entries SELECT queue_id,position,entry_id,track_id,original_position FROM queue_entries;
  CREATE TABLE legacy_queue_snapshots(entry_id TEXT PRIMARY KEY REFERENCES legacy_queue_entries(entry_id) ON DELETE CASCADE,payload TEXT NOT NULL);
  INSERT INTO legacy_queue_snapshots SELECT entry_id,payload FROM queue_snapshots;
  DROP TABLE queue_snapshots;
  DROP TABLE queue_entries;
  ALTER TABLE legacy_queue_entries RENAME TO queue_entries;
  ALTER TABLE legacy_queue_snapshots RENAME TO queue_snapshots;
  CREATE INDEX queue_entries_original ON queue_entries(queue_id,original_position);
`
