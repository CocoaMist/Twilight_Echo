import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CoreStateDatabase, CoreStateDurabilityError } from './coreStateDatabase.ts'
import {
  CORE_STATE_DOMAINS,
  emptyCoreStateCounts,
  type CoreStateDomain,
  type CoreStateRow
} from '../../shared/coreState.ts'

const data: Record<CoreStateDomain, CoreStateRow[]> = {
  versions: [
    {
      key: 'tracks:versions:v1',
      value: { id: 'v1', label: 'Master', sources: ['local:a', 'ncm:7'], preferredSource: 'ncm:7' }
    }
  ],
  'statistics-tracks': [
    {
      key: 'local:a',
      value: {
        title: 'A',
        artist: 'Artist',
        seconds: 42,
        plays: 2,
        skips: 1,
        completions: 1,
        lastPlayed: 123,
        addedAt: 2
      }
    }
  ],
  'statistics-days': [{ key: '2026-10-21', value: 42 }],
  inbox: [{ key: '["a","tags"]', value: { fingerprint: 'original', status: 'ignored' } }],
  'podcast-preferences': [{ key: 'defaultPlaybackRate', value: 1.25 }],
  'eq-preferences': [
    { key: 'autoPreamp', value: true },
    { key: 'manualPreamp', value: -3 }
  ]
}
const manifest = () => ({
  version: 1 as const,
  counts: Object.fromEntries(
    CORE_STATE_DOMAINS.map((domain) => [domain, data[domain].length])
  ) as Record<CoreStateDomain, number>
})
function stage(db: CoreStateDatabase, start = 0) {
  let batch = start
  for (const domain of CORE_STATE_DOMAINS) db.stage('upgrade', batch++, domain, data[domain])
  return batch
}

test('staging stays invisible; publication commits every domain and the marker atomically', () => {
  const db = new CoreStateDatabase(':memory:')
  try {
    db.begin('upgrade', manifest())
    stage(db)
    for (const domain of CORE_STATE_DOMAINS) assert.deepEqual(db.read(domain).rows, [])
    assert.equal(db.status().complete, false)
    assert.equal(db.commit('upgrade').complete, true)
    for (const domain of CORE_STATE_DOMAINS)
      assert.deepEqual(
        [...db.read(domain).rows].sort((a, b) => a.key.localeCompare(b.key)),
        [...data[domain]].sort((a, b) => a.key.localeCompare(b.key))
      )
    assert.equal(db.commit('upgrade').complete, true)
    assert.throws(() => db.abort('upgrade'), /cannot be aborted/)
  } finally {
    db.close()
  }
})
test('interruption resumes from durable stages; only identical explicitly idempotent batches may repeat', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'twilight-core-state-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'core-state.sqlite')
  let db = new CoreStateDatabase(path)
  db.begin('upgrade', manifest())
  db.stage('upgrade', 0, 'versions', data.versions)
  db.close()
  db = new CoreStateDatabase(path)
  try {
    assert.equal(db.status().nextBatch, 1)
    assert.equal(db.begin('upgrade', manifest()).nextBatch, 1)
    assert.equal(db.stage('upgrade', 0, 'versions', data.versions).nextBatch, 1)
    assert.throws(
      () => db.stage('upgrade', 0, 'versions', [{ ...data.versions[0], value: { changed: true } }]),
      /Invalid|changed/
    )
    assert.throws(
      () => db.stage('upgrade', 2, 'statistics-days', data['statistics-days']),
      /sequence gap/
    )
    assert.throws(() => db.commit('upgrade'), /incomplete/)
    assert.equal(db.read('versions').rows.length, 0)
    let batch = 1
    for (const domain of CORE_STATE_DOMAINS.slice(1))
      db.stage('upgrade', batch++, domain, data[domain])
    assert.equal(db.commit('upgrade').complete, true)
  } finally {
    db.close()
  }
})
test('existing Core records cannot be overwritten by an upgrade; failure preserves its staged source', () => {
  const db = new CoreStateDatabase(':memory:')
  try {
    db.begin('upgrade', manifest())
    stage(db)
    db.sql.prepare('INSERT INTO core_state VALUES (?,?,?)').run('statistics-days', 'existing', '99')
    assert.throws(() => db.commit('upgrade'), /must not be overwritten/)
    assert.equal(db.status().complete, false)
    assert.equal(db.status().counts['statistics-tracks'], 1)
    assert.deepEqual(db.read('statistics-days').rows, [{ key: 'existing', value: 99 }])
  } finally {
    db.close()
  }
})
test('migration gates writes; business revisions and paged-read fences reject stale clients', () => {
  const db = new CoreStateDatabase(':memory:')
  try {
    assert.throws(
      () => db.write('statistics-days', data['statistics-days'], 0),
      /migration must complete/
    )
    db.begin('empty', { version: 1, counts: emptyCoreStateCounts() })
    db.commit('empty')
    const revision = db.read('statistics-days').revision
    const next = db.write(
      'statistics-days',
      Array.from({ length: 128 }, (_, i) => ({
        key: `day:${String(i).padStart(3, '0')}`,
        value: i
      })),
      revision
    )
    db.write('statistics-days', [{ key: 'day:128', value: 128 }], next)
    const first = db.read('statistics-days', undefined, 128)
    const second = db.read('statistics-days', first.next!, 128, first.revision)
    assert.equal(first.rows.length, 128)
    assert.equal(second.rows.length, 1)
    assert.equal(new Set([...first.rows, ...second.rows].map((row) => row.key)).size, 129)
    assert.throws(
      () => db.write('statistics-days', data['statistics-days'], revision),
      /revision conflict/
    )
    assert.throws(() => db.read('statistics-days', first.next!, 128, revision), /revision changed/)
  } finally {
    db.close()
  }
})
test('graph validation rejects invalid source identity relationships before publishing any domain', () => {
  const db = new CoreStateDatabase(':memory:')
  try {
    db.begin('upgrade', { version: 1, counts: { ...emptyCoreStateCounts(), versions: 1 } })
    db.stage('upgrade', 0, 'versions', [
      {
        key: 'tracks:versions:v1',
        value: { id: 'v1', label: 'Broken', sources: ['a'], preferredSource: 'missing' }
      }
    ])
    assert.throws(() => db.commit('upgrade'), /graph validation/)
    assert.equal(db.read('versions').rows.length, 0)
    assert.equal(db.status().complete, false)
  } finally {
    db.close()
  }
})

test('a failed rollback closes Core state and exposes a fatal durability error instead of accepting more writes', () => {
  const db = new CoreStateDatabase(':memory:')
  const exec = db.sql.exec.bind(db.sql)
  db.sql.exec = (sql: string) => {
    if (sql === 'ROLLBACK') throw new Error('Injected rollback failure')
    return exec(sql)
  }
  assert.throws(
    () => db.write('statistics-days', data['statistics-days'], 0),
    CoreStateDurabilityError
  )
  assert.equal(db.sql.isOpen, false)
  assert.throws(() => db.status(), /not open/)
})
