import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CoreStateDatabase } from '../../main/library/coreStateDatabase.ts'
import { emptyCoreStateCounts } from '../../shared/coreState.ts'
import type { CoreStatisticsApi } from '../../shared/coreStatistics.ts'
import { CoreStatisticsRepository } from './repository.ts'
import { normalizeTrackStats, recordListeningSeconds } from './model.ts'

export const stat = {
  title: 'Song',
  artist: 'Artist',
  seconds: 5,
  plays: 1,
  lastPlayed: Date.UTC(2026, 9, 22),
  skips: 0,
  completions: 0,
  cover: null
}
export function statisticsDatabase(
  db: CoreStateDatabase
): CoreStatisticsApi & { coreStateRead: CoreStateDatabaseRead } {
  return {
    coreStateRead: async (...args) => db.read(...args),
    coreStatisticsStatus: async () => db.statisticsStatus(),
    coreStatisticsBegin: async (...args) => db.statisticsBegin(...args),
    coreStatisticsStage: async (...args) => db.statisticsStage(...args),
    coreStatisticsCommit: async (...args) => db.statisticsCommit(...args),
    coreStatisticsAbort: async (...args) => db.statisticsAbort(...args)
  }
}
type CoreStateDatabaseRead = import('../../shared/coreState.ts').CoreStateApi['coreStateRead']
export function migrate(db: CoreStateDatabase) {
  db.begin('upgrade', { version: 1, counts: emptyCoreStateCounts() })
  db.commit('upgrade')
}
const checkpoint = (seconds = 5) => ({
  replace: false,
  tracks: [{ key: 'song', value: { ...stat, seconds } }],
  days: [{ key: '2026-10-22', value: seconds }]
})

test('statistics pages remain invisible until one transaction publishes tracks and days; revision fences protect the commit', () => {
  const db = new CoreStateDatabase(':memory:')
  try {
    assert.throws(
      () => db.statisticsBegin('blocked', { tracks: 0, days: 0 }, 1, false),
      /migration/
    )
    migrate(db)
    db.statisticsBegin('save', { tracks: 1, days: 1 }, 2, false)
    db.statisticsStage('save', 0, 'statistics-tracks', checkpoint().tracks)
    assert.deepEqual(db.read('statistics-tracks').rows, [])
    assert.throws(() => db.statisticsCommit('save'), /incomplete/)
    db.statisticsStage('save', 1, 'statistics-days', checkpoint().days)
    db.statisticsCommit('save')
    assert.deepEqual(db.read('statistics-tracks').rows, checkpoint().tracks)
    assert.deepEqual(db.read('statistics-days').rows, checkpoint().days)
    assert.throws(
      () => db.statisticsStage('save', 1, 'statistics-days', checkpoint().days),
      /sequence/
    )
    assert.throws(() => db.statisticsCommit('save'), /already committed/)
    db.statisticsBegin('conflict', { tracks: 2, days: 2 }, 0, true)
    db.write('statistics-days', [{ key: 'other', value: 3 }], 2)
    assert.throws(() => db.statisticsCommit('conflict'), /revision conflict/)
    assert.deepEqual(db.read('statistics-tracks').rows, checkpoint().tracks)
  } finally {
    db.close()
  }
})

test('checkpoint import uses bounded batches and empty replacement clears both domains atomically', async () => {
  const db = new CoreStateDatabase(':memory:')
  migrate(db)
  let serial = 0,
    peak = 0
  const database = statisticsDatabase(db),
    stage = database.coreStatisticsStage
  database.coreStatisticsStage = async (...args) => {
    peak = Math.max(peak, args[3].length)
    return stage(...args)
  }
  const repo = new CoreStatisticsRepository({ database, newId: () => `save:${++serial}` })
  try {
    await repo.load()
    await repo.publish({
      replace: true,
      tracks: Array.from({ length: 201 }, (_, i) => ({ key: `track:${i}`, value: stat })),
      days: checkpoint().days
    })
    assert.equal(peak, 128)
    assert.equal(Object.keys((await repo.load()).tracks).length, 201)
    await repo.publish({ replace: true, tracks: [], days: [] })
    assert.deepEqual(await repo.load(), { tracks: {}, days: {} })
    assert.equal(db.statisticsStatus().operation?.batches, 0)
  } finally {
    db.close()
  }
})

test('lost replies are recovered only through status reads; begin, stage and commit are each sent once', async () => {
  const db = new CoreStateDatabase(':memory:')
  migrate(db)
  const database = statisticsDatabase(db)
  const calls: Record<string, number> = {}
  for (const name of [
    'coreStatisticsBegin',
    'coreStatisticsStage',
    'coreStatisticsCommit'
  ] as const) {
    const method = database[name].bind(database) as (...args: unknown[]) => Promise<unknown>
    Object.defineProperty(database, name, {
      value: async (...args: unknown[]) => {
        calls[name] = (calls[name] ?? 0) + 1
        await method(...args)
        throw new Error('Reply lost after durable write')
      }
    })
  }
  const repo = new CoreStatisticsRepository({ database, newId: () => 'once' })
  try {
    await repo.load()
    await repo.publish(checkpoint())
    assert.deepEqual(calls, {
      coreStatisticsBegin: 1,
      coreStatisticsStage: 2,
      coreStatisticsCommit: 1
    })
    assert.equal((await repo.load()).tracks.song.seconds, 5)
    assert.equal(await repo.recover(), null)
  } finally {
    db.close()
  }
})

test('unreadable unknown commit stays pending; a later status read confirms it without resending any write', async () => {
  const db = new CoreStateDatabase(':memory:')
  migrate(db)
  const database = statisticsDatabase(db),
    commit = database.coreStatisticsCommit,
    status = database.coreStatisticsStatus
  let offline = false,
    commits = 0
  database.coreStatisticsCommit = async (...args) => {
    commits++
    await commit(...args)
    offline = true
    throw Error('Lost reply')
  }
  database.coreStatisticsStatus = async () => {
    if (offline) throw Error('Database unavailable')
    return status()
  }
  const repo = new CoreStatisticsRepository({ database, newId: () => 'pending' })
  try {
    await repo.load()
    await assert.rejects(repo.publish(checkpoint()), /unavailable/)
    await assert.rejects(repo.recover(), /unavailable/)
    assert.equal(commits, 1)
    offline = false
    assert.equal(await repo.recover(), true)
    assert.equal(commits, 1)
    assert.equal(db.read('statistics-days').rows[0].value, 5)
  } finally {
    db.close()
  }
})

test('a new Core discards an interrupted stage and loads the last complete history after database reopening', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'twilight-core-stats-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'core-state.sqlite')
  let db = new CoreStateDatabase(path)
  migrate(db)
  let serial = 0
  const first = new CoreStatisticsRepository({
    database: statisticsDatabase(db),
    newId: () => `save:${++serial}`
  })
  await first.load()
  await first.publish(checkpoint())
  db.statisticsBegin('interrupted', { tracks: 2, days: 2 }, 2, true)
  db.statisticsStage('interrupted', 0, 'statistics-tracks', checkpoint(500).tracks)
  db.close()
  db = new CoreStateDatabase(path)
  try {
    const restarted = new CoreStatisticsRepository({
      database: statisticsDatabase(db),
      newId: () => 'next'
    })
    const loaded = await restarted.load()
    assert.equal(loaded.tracks.song.seconds, 5)
    assert.equal(loaded.days['2026-10-22'], 5)
    assert.equal(db.statisticsStatus().operation, null)
    await restarted.publish(checkpoint(10))
    assert.equal(db.read('statistics-days').rows[0].value, 10)
  } finally {
    db.close()
  }
})

test('a rejected stage is not retried or committed; read recovery discards it before a new checkpoint', async () => {
  const db = new CoreStateDatabase(':memory:')
  migrate(db)
  const database = statisticsDatabase(db),
    stage = database.coreStatisticsStage
  let rejected = true,
    serial = 0
  const staged: string[] = []
  database.coreStatisticsStage = async (...args) => {
    staged.push(args[0])
    if (rejected) {
      rejected = false
      throw Error('Stage unavailable before commit')
    }
    return stage(...args)
  }
  const repository = new CoreStatisticsRepository({
    database,
    newId: () => `checkpoint:${++serial}`
  })
  try {
    await repository.load()
    await assert.rejects(repository.publish({ ...checkpoint(), days: [] }), /Stage unavailable/)
    assert.equal(db.statisticsStatus().operation?.committed, false)
    assert.deepEqual(db.read('statistics-tracks').rows, [])
    assert.equal(await repository.recover(), false)
    assert.equal(db.statisticsStatus().operation, null)
    await repository.publish({ ...checkpoint(), days: [] })
    assert.deepEqual(staged, ['checkpoint:1', 'checkpoint:2'])
    assert.equal(
      db.read('statistics-tracks').rows[0].value &&
        (db.read('statistics-tracks').rows[0].value as typeof stat).seconds,
      5
    )
  } finally {
    db.close()
  }
})

test('normalization retains extension data and arbitrary legacy identities remain own dictionary keys', () => {
  const source = Object.fromEntries([['__proto__', { ...stat, addedAt: 42 }]])
  const tracks = normalizeTrackStats(source)
  assert.equal(Object.hasOwn(tracks, '__proto__'), true)
  assert.equal((tracks.__proto__ as typeof stat & { addedAt: number }).addedAt, 42)
  assert.equal(Object.getPrototypeOf(tracks), Object.prototype)
  const stats = { tracks, days: {} }
  const track: import('../../shared/track.ts').TrackData = {
    id: 'constructor',
    title: '',
    artist: '',
    album: '',
    filePath: 'D:/one.flac',
    fileName: 'one.flac',
    duration: 100,
    size: 1,
    cover: null,
    lyrics: null
  }
  recordListeningSeconds(stats, track, 5, Date.UTC(2026, 9, 22), 1)
  assert.equal(Object.hasOwn(stats.tracks, 'constructor'), true)
  assert.equal(stats.tracks[track.id].seconds, 5)
  assert.equal(Object.getPrototypeOf(stats.tracks), Object.prototype)
})
