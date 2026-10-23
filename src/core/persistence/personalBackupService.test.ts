import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import { CoreStateDatabase } from '../../main/library/coreStateDatabase.ts'
import { emptyCoreStateCounts } from '../../shared/coreState.ts'
import {
  PERSONAL_DOMAINS,
  remapPersonalPaths,
  type PersonalData
} from '../../shared/personalBackup.ts'
import type { PersonalLibraryDatabase } from '../../shared/coreBackup.ts'
import { CorePersonalBackupService } from './personalBackupService.ts'
import { createPersonalBackupRepository } from './personalBackup.ts'

import { personalBackupFixture as backup } from './personalBackup.fixture.ts'

function profile(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'core-personal-backup-'))
  const library = new LibraryDatabase(join(root, 'music-library.sqlite'))
  const state = new CoreStateDatabase(join(root, 'core-state.sqlite'))
  state.begin('upgrade', { version: 1, counts: emptyCoreStateCounts() })
  state.commit('upgrade')
  t.after(() => {
    library.close()
    state.close()
    rmSync(root, { recursive: true, force: true })
  })
  const database: PersonalLibraryDatabase & {
    corePersonalRestore(): Promise<{ id: string | null; applied: boolean }>
  } = {
    exportDocument: async (...args) => library.exportDocument(...args),
    restoreDocument: (...args) => library.restoreDocument(...args),
    restorePersonalLibrary: (...args) => library.restorePersonalLibrary(...args),
    previewPersonalLibrary: async (...args) => library.previewPersonalLibrary(...args),
    getMetadata: async () => library.getMetadata(),
    exportPlaybackQueue: async (...args) => library.exportPlaybackQueue(...args),
    corePersonalRestore: async () => state.restorePersonalData()
  }
  const data = (): PersonalData => {
    const rows = state.read('versions').rows
    const versions = {
      version: 1,
      tracks: { versions: [] as unknown[], families: [] as unknown[] },
      albums: { versions: [] as unknown[], families: [] as unknown[] }
    }
    for (const row of rows) {
      const [scope, kind] = row.key.split(':') as ['tracks' | 'albums', 'versions' | 'families']
      versions[scope][kind].push(row.value)
    }
    return {
      statistics: {
        days: Object.fromEntries(
          state.read('statistics-days').rows.map((row) => [row.key, row.value])
        ),
        tracks: Object.fromEntries(
          state.read('statistics-tracks').rows.map((row) => [row.key, row.value])
        )
      },
      ...(rows.length ? { versions } : {})
    }
  }
  let serial = 0,
    flushes = 0
  const repository = createPersonalBackupRepository()
  const input = join(root, 'incoming.json'),
    output = join(root, 'export.json')
  const service = new CorePersonalBackupService({
    root,
    database,
    personalData: data,
    flush: async () => {
      flushes++
    },
    chooseFile: async (kind) => (kind === 'import' ? input : output),
    chooseFolder: async () => 'D:/Music',
    authorizeRoots: async (roots) => {
      assert.deepEqual(roots, ['D:/Music'])
      return roots
    },
    newId: () => `preview:${++serial}`
  })
  return {
    root,
    library,
    state,
    database,
    repository,
    service,
    input,
    output,
    data,
    flushes: () => flushes
  }
}

test('all ten domains round-trip through Core repositories, SQLite and the existing restart journal', async (t) => {
  const f = profile(t),
    incoming = backup()
  f.repository.writePersonalBackupFile(f.input, incoming)
  const preview = await f.service.preview()
  assert.deepEqual(
    preview!.rows.map((row) => row.domain),
    PERSONAL_DOMAINS
  )
  const options = {
    domains: [...PERSONAL_DOMAINS],
    conflict: 'use-backup' as const,
    mappings: [{ from: 'C:/Old', to: 'D:/Music' }]
  }
  await assert.rejects(f.service.stage({ id: 'stale', options }), { code: 'STALE_REVISION' })
  assert.deepEqual(await f.service.stage({ id: preview!.id, options }), { restartRequired: true })
  assert.equal(f.library.getMetadata().trackCount, 0)
  assert.equal(f.state.read('versions').rows.length, 0)
  await f.repository.applyPendingPersonalRestoreFromDatabase(f.root, f.database)
  await f.service.initialize()
  assert.equal(f.repository.readRendererRestore(f.root), null)
  assert.equal(existsSync(join(f.root, 'personal-restore-pending.json')), false)
  assert.equal(existsSync(join(f.root, 'music-library.json')), false)
  assert.equal(f.library.getMetadata().trackCount, 1)
  assert.equal(await f.service.export(), true)
  const restored = f.repository.readBackupFile(f.output)
  const expected = remapPersonalPaths(incoming.data, options.mappings) as PersonalData
  for (const domain of PERSONAL_DOMAINS.filter((domain) => domain !== 'library'))
    assert.deepEqual(restored.data[domain], expected[domain], domain)
  const library = restored.data.library as {
    tracks: unknown[]
    folders: string[]
    exclusions: unknown[]
  }
  assert.deepEqual(library.tracks, (expected.library as typeof library).tracks)
  assert.deepEqual(library.folders, ['D:/Music'])
  assert.deepEqual(library.exclusions, [])
  assert.equal(f.flushes(), 3)
  const previous = JSON.parse(readFileSync(join(f.root, 'personal-restore-previous.json'), 'utf8'))
  assert.match(previous.data['music-library.json'].databaseSnapshot, /pre-restore-/)
  await f.service.shutdown()
})

test('a legacy renderer journal merges after browser migration and its durable token prevents a lost ACK from overwriting later data', async (t) => {
  const f = profile(t)
  const request = {
    id: 'legacy-restore',
    conflict: 'use-backup',
    data: { statistics: backup().data.statistics, versions: backup().data.versions }
  }
  const journal = join(f.root, 'personal-restore-renderer.json')
  writeFileSync(journal, JSON.stringify(request))
  await f.service.initialize()
  const revision = f.state.read('statistics-days').revision
  f.state.write('statistics-days', [{ key: '2026-10-03', value: 500 }], revision)
  writeFileSync(journal, JSON.stringify(request))
  assert.deepEqual(await f.database.corePersonalRestore(), { id: request.id, applied: false })
  assert.equal(f.state.read('statistics-days').rows[0].value, 500)
  assert.equal(f.state.read('statistics-days').revision, revision + 1)
  assert.equal(existsSync(journal), false)
  await f.service.shutdown()
})

test('statistics and version restore rollback together; the retained journal succeeds after the actual database error is repaired', async (t) => {
  const f = profile(t)
  const journal = join(f.root, 'personal-restore-renderer.json')
  writeFileSync(
    journal,
    JSON.stringify({
      id: 'atomic-restore',
      conflict: 'keep-local',
      data: { statistics: backup().data.statistics, versions: backup().data.versions }
    })
  )
  const before = f.state.read('statistics-days')
  f.state.sql.exec(
    `CREATE TRIGGER fail_version BEFORE INSERT ON core_state WHEN NEW.domain='versions' BEGIN SELECT RAISE(ABORT, 'disk-full-fixture'); END`
  )
  await assert.rejects(f.service.initialize(), /disk-full-fixture/)
  assert.deepEqual(f.state.read('statistics-days'), before)
  assert.equal(f.state.sql.prepare('SELECT * FROM core_personal_restore').get(), undefined)
  assert.equal(existsSync(journal), true)
  f.state.sql.exec('DROP TRIGGER fail_version')
  await f.service.initialize()
  assert.equal(f.state.read('statistics-days').rows[0].value, 20)
  assert.equal(f.state.read('versions').rows[0].key, 'tracks:versions:version')
  await f.service.shutdown()
})
