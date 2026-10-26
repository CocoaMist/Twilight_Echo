/** Durable read fence for classification dimensions backed by identity and metadata.
 * Catalog/content/genre revisions cover their own tables; these cover facts that
 * can change independently, including A → B → A and expired-fact deletion.
 */
export const BROWSE_METADATA_TABLES = [
  'metadata_identity_links', 'metadata_identity_candidates', 'metadata_subjects',
  'metadata_facts', 'metadata_overrides', 'metadata_legacy_documents',
  'metadata_legacy_albums', 'metadata_legacy_bindings'
] as const

export const BROWSE_REVISION_OBJECTS = [
  'music_browse_state',
  ...BROWSE_METADATA_TABLES.flatMap(table =>
    ['ai', 'au', 'ad'].map(operation => `music_browse_${table}_${operation}`))
]

export const BROWSE_REVISION_SCHEMA_SQL = `
CREATE TABLE music_browse_state(id INTEGER PRIMARY KEY CHECK(id=1),metadata_revision INTEGER NOT NULL);
INSERT INTO music_browse_state VALUES(1,0);
${BROWSE_METADATA_TABLES.flatMap(table =>
  (['INSERT', 'UPDATE', 'DELETE'] as const).map((operation, index) => `
CREATE TRIGGER music_browse_${table}_${['ai', 'au', 'ad'][index]} AFTER ${operation} ON ${table}
BEGIN UPDATE music_browse_state SET metadata_revision=metadata_revision+1 WHERE id=1; END;`
  )).join('\n')}
`

/** Added only after the v28 personal metadata authorities exist. */
export const PERSONAL_METADATA_TABLES = [
  'metadata_source_preferences', 'metadata_artwork_overrides', 'metadata_legacy_provenance'
] as const
export const PERSONAL_METADATA_REVISION_OBJECTS = PERSONAL_METADATA_TABLES.flatMap(table =>
  ['ai', 'au', 'ad'].map(operation => `music_browse_${table}_${operation}`))
export const PERSONAL_METADATA_REVISION_SCHEMA_SQL = PERSONAL_METADATA_TABLES.flatMap(table =>
  (['INSERT', 'UPDATE', 'DELETE'] as const).map((operation, index) => `
CREATE TRIGGER music_browse_${table}_${['ai', 'au', 'ad'][index]} AFTER ${operation} ON ${table}
BEGIN UPDATE music_browse_state SET metadata_revision=metadata_revision+1 WHERE id=1; END;`
  )).join('\n')
