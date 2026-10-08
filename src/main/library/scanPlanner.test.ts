import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import type { LocalLibraryFileIdentity } from '../../shared/localLibraryScan.ts'
import { createLocalLibraryScanPlan } from './scanPlanner.ts'

test('startup plan parses only new, changed, or unindexed tracks', () => {
  const root = join('C:\\', 'music')
  const unchanged = identity(join(root, 'unchanged.flac'), 100, 10)
  const changedBefore = identity(join(root, 'changed.flac'), 200, 20)
  const changedAfter = identity(join(root, 'changed.flac'), 201, 21)
  const missingTrack = identity(join(root, 'missing-track.flac'), 300, 30)
  const added = identity(join(root, 'added.flac'), 400, 40)

  const plan = createLocalLibraryScanPlan({
    mode: 'startup',
    identities: [unchanged, changedAfter, missingTrack, added],
    knownIdentities: [unchanged, changedBefore, missingTrack],
    knownTrackPaths: [unchanged.filePath, changedBefore.filePath],
    excludedPaths: [],
    changes: [{ kind: 'add', path: unchanged.filePath }],
    completeIdentitySnapshot: true
  })

  assert.deepEqual(plan.parseFilePaths, [
    changedAfter.filePath,
    missingTrack.filePath,
    added.filePath
  ])
  assert.equal(plan.skippedUnchanged, 1)
  assert.deepEqual(plan.removedFilePaths, [])
})

test('missing or revision-mismatched index forces a one-time metadata reconciliation', () => {
  const entries = [identity('C:\\music\\one.flac', 1, 1), identity('C:\\music\\two.flac', 2, 2)]
  const plan = createLocalLibraryScanPlan({
    mode: 'startup',
    identities: entries,
    knownIdentities: entries,
    knownTrackPaths: entries.map((entry) => entry.filePath),
    excludedPaths: [],
    forceParse: true,
    completeIdentitySnapshot: true
  })

  assert.deepEqual(
    plan.parseFilePaths,
    entries.map((entry) => entry.filePath)
  )
  assert.equal(plan.skippedUnchanged, 0)
})

test('a sibling CUE dependency change reparses an otherwise unchanged audio file', () => {
  const filePath = 'C:\\music\\disc.flac'
  const before = { ...identity(filePath, 100, 10), cueSignature: 'cue-before' }
  const after = { ...identity(filePath, 100, 10), cueSignature: 'cue-after' }
  const plan = createLocalLibraryScanPlan({
    mode: 'startup',
    identities: [after],
    knownIdentities: [before],
    knownTrackPaths: [filePath],
    excludedPaths: [],
    completeIdentitySnapshot: true
  })

  assert.deepEqual(plan.parseFilePaths, [filePath])
  assert.equal(plan.skippedUnchanged, 0)
})

test('exclusions are rechecked before planning metadata work', () => {
  const excluded = identity('C:\\music\\excluded.flac', 1, 1)
  const plan = createLocalLibraryScanPlan({
    mode: 'startup',
    identities: [excluded],
    knownIdentities: [],
    knownTrackPaths: [],
    excludedPaths: [excluded.filePath],
    forceParse: true,
    completeIdentitySnapshot: true
  })

  assert.deepEqual(plan.parseFilePaths, [])
  assert.equal(plan.skippedUnchanged, 1)
})

test('complete snapshots remove persisted tracks that became excluded', () => {
  const excluded = identity('C:\\music\\excluded.flac', 1, 1)
  const kept = identity('C:\\music\\kept.flac', 2, 2)
  const plan = createLocalLibraryScanPlan({
    mode: 'full',
    identities: [excluded, kept],
    knownIdentities: [excluded, kept],
    knownTrackPaths: [excluded.filePath, kept.filePath],
    excludedPaths: [excluded.filePath],
    completeIdentitySnapshot: true
  })

  assert.deepEqual(plan.removedFilePaths, [excluded.filePath])
  assert.deepEqual(plan.parseFilePaths, [kept.filePath])
})

test('complete snapshots infer removals while partial watcher batches remove only explicit paths', () => {
  const present = identity('C:\\music\\present.flac', 1, 1)
  const missing = identity('C:\\music\\missing.flac', 2, 2)
  const complete = createLocalLibraryScanPlan({
    mode: 'startup',
    identities: [present],
    knownIdentities: [present, missing],
    knownTrackPaths: [present.filePath, missing.filePath],
    excludedPaths: [],
    completeIdentitySnapshot: true
  })
  const partial = createLocalLibraryScanPlan({
    mode: 'watch',
    identities: [],
    knownIdentities: [present, missing],
    knownTrackPaths: [present.filePath, missing.filePath],
    excludedPaths: [],
    changes: [{ kind: 'remove', path: present.filePath }],
    completeIdentitySnapshot: false
  })

  assert.deepEqual(complete.removedFilePaths, [missing.filePath])
  assert.deepEqual(partial.removedFilePaths, [present.filePath])

  const cueDependencyRemoval = createLocalLibraryScanPlan({
    mode: 'watch',
    identities: [present],
    knownIdentities: [present],
    knownTrackPaths: [present.filePath],
    excludedPaths: [],
    changes: [{ kind: 'remove', path: 'C:\\music\\disc.cue' }],
    completeIdentitySnapshot: false
  })
  assert.deepEqual(cueDependencyRemoval.removedFilePaths, [])
})

test('directory-level reconcile still uses complete snapshot removals when planner receives a full identity set', () => {
  const present = identity('C:\\music\\keep.flac', 1, 1)
  const missing = identity('C:\\music\\gone.flac', 2, 2)
  const plan = createLocalLibraryScanPlan({
    mode: 'watch',
    identities: [present],
    knownIdentities: [present, missing],
    knownTrackPaths: [present.filePath, missing.filePath],
    excludedPaths: [],
    changes: [{ kind: 'reconcile', path: 'C:\\music' }],
    completeIdentitySnapshot: true
  })

  assert.deepEqual(plan.removedFilePaths, [missing.filePath])
  assert.deepEqual(plan.parseFilePaths, [])
  assert.equal(plan.skippedUnchanged, 1)
})

test('startup planning remains linear for 25000 indexed files', () => {
  const entries = Array.from({ length: 25_000 }, (_, index) =>
    identity(`C:\\music\\track-${index}.flac`, index + 1, index + 0.5)
  )
  const startedAt = performance.now()
  const plan = createLocalLibraryScanPlan({
    mode: 'startup',
    identities: entries,
    knownIdentities: entries,
    knownTrackPaths: entries.map((entry) => entry.filePath),
    excludedPaths: [],
    completeIdentitySnapshot: true
  })
  const elapsedMs = performance.now() - startedAt

  assert.equal(plan.parseFilePaths.length, 0)
  assert.equal(plan.skippedUnchanged, entries.length)
  assert.ok(elapsedMs < 5_000, `25000-file startup plan took ${elapsedMs.toFixed(2)}ms`)
})

function identity(filePath: string, size: number, mtimeMs: number): LocalLibraryFileIdentity {
  return { filePath, size, mtimeMs, metadataVersion: 1 }
}

test('unchanged legacy files backfill dates once while changed files get a normal parse', () => {
  const old = { filePath: 'C:\\music\\old.flac', size: 10, mtimeMs: 20 }
  const current = identity('C:\\music\\current.flac', 11, 21)
  const changed = { ...old, filePath: 'C:\\music\\changed.flac', mtimeMs: 30 }
  const plan = createLocalLibraryScanPlan({
    mode: 'startup',
    identities: [old, current, changed],
    knownIdentities: [old, current, { ...changed, mtimeMs: 29 }],
    knownTrackPaths: [old.filePath, current.filePath, changed.filePath],
    excludedPaths: [],
    completeIdentitySnapshot: true
  })
  assert.deepEqual(plan.releaseDateFilePaths, [old.filePath])
  assert.deepEqual(plan.parseFilePaths, [old.filePath, changed.filePath])
  assert.equal(plan.skippedUnchanged, 1)
})
