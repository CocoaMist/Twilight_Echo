/** Recreate the actual pre-v11 tables when a migration fixture starts from a
 * fresh database. A version pragma alone would no longer describe old storage. */
export const LEGACY_CATALOG_SCHEMA_SQL = `
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
