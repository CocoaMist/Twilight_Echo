import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  PersistentDataRevisionConflictError,
  createPersistentDataRevisionConflictResponse,
  isPersistentDataRevisionConflictResponse,
  persistentDataRevisionConflictFromResponse
} from '../../shared/versionedPersistence.ts'
import { VersionedDataStore } from './versionedDataStore.ts'

function createWorkspace(): { directory: string; filePath: string } {
  const directory = mkdtempSync(join(tmpdir(), 'twilight-versioned-store-'))
  return { directory, filePath: join(directory, 'state.json') }
}

function createStringStore(filePath: string, now = () => '2026-07-17T00:00:00.000Z') {
  return new VersionedDataStore<string>({
    filePath,
    label: 'test state',
    maxBytes: 4096,
    isData: (value): value is string => typeof value === 'string',
    isLegacy: (value): value is string => typeof value === 'string',
    now
  })
}

test('migrates legacy v1 session and legacy playlist-array payloads into v2 envelopes', async () => {
  const session = createWorkspace()
  const playlists = createWorkspace()
  const legacySession = {
    version: 1,
    savedAt: '2026-07-01T12:00:00.000Z',
    mode: 'track',
    track: { id: 'local:one' },
    position: 0
  }
  try {
    writeFileSync(session.filePath, JSON.stringify(legacySession))
    const sessionStore = new VersionedDataStore<typeof legacySession>({
      filePath: session.filePath,
      label: 'session',
      maxBytes: 4096,
      isData: isLegacySession,
      isLegacy: isLegacySession,
      now: () => '2026-07-17T00:00:00.000Z'
    })
    const loadedSession = await sessionStore.load()
    assert.deepEqual(loadedSession, {
      version: 2,
      revision: 0,
      savedAt: legacySession.savedAt,
      data: legacySession
    })

    writeFileSync(playlists.filePath, JSON.stringify([{ id: 'favorites' }]))
    const playlistStore = new VersionedDataStore<unknown[]>({
      filePath: playlists.filePath,
      label: 'playlists',
      maxBytes: 4096,
      isData: Array.isArray,
      isLegacy: Array.isArray,
      now: () => '2026-07-17T00:00:00.000Z'
    })
    assert.deepEqual(await playlistStore.load(), {
      version: 2,
      revision: 0,
      savedAt: '2026-07-17T00:00:00.000Z',
      data: [{ id: 'favorites' }]
    })
    assert.equal(JSON.parse(readFileSync(playlists.filePath, 'utf-8')).version, 2)
  } finally {
    rmSync(session.directory, { recursive: true, force: true })
    rmSync(playlists.directory, { recursive: true, force: true })
  }
})

test('uses expected revisions to reject stale writers without losing the authoritative snapshot', async () => {
  const { directory, filePath } = createWorkspace()
  try {
    const first = createStringStore(filePath)
    const stale = createStringStore(filePath)
    assert.equal((await first.save('first', 0)).revision, 1)

    await assert.rejects(
      () => stale.save('stale', 0),
      (error: unknown) => {
        assert.ok(error instanceof PersistentDataRevisionConflictError)
        assert.equal(error.current?.revision, 1)
        assert.equal(error.current?.data, 'first')
        return true
      }
    )

    assert.deepEqual(await stale.load(), {
      version: 2,
      revision: 1,
      savedAt: '2026-07-17T00:00:00.000Z',
      data: 'first'
    })
    assert.equal((await stale.save('replayed', 1)).revision, 2)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('shares one write queue between stores for the same file and returns the current envelope', async () => {
  const { directory, filePath } = createWorkspace()
  try {
    const firstRenderer = createStringStore(filePath)
    const secondRenderer = createStringStore(filePath)
    const first = firstRenderer.save('first', 0)
    const stale = secondRenderer.save('stale', 0)

    assert.equal((await first).revision, 1)
    await assert.rejects(stale, (error: unknown) => {
      assert.ok(error instanceof PersistentDataRevisionConflictError)
      assert.deepEqual(error.current, {
        version: 2,
        revision: 1,
        savedAt: '2026-07-17T00:00:00.000Z',
        data: 'first'
      })
      return true
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('serializes a revision conflict for IPC and restores its current envelope at preload', () => {
  const current = {
    version: 2 as const,
    revision: 4,
    savedAt: '2026-07-17T00:00:00.000Z',
    data: 'authoritative'
  }
  const response = createPersistentDataRevisionConflictResponse(
    new PersistentDataRevisionConflictError(current, 3)
  )

  assert.equal(
    isPersistentDataRevisionConflictResponse(
      response,
      (value): value is string => typeof value === 'string'
    ),
    true
  )
  const restored = persistentDataRevisionConflictFromResponse(response)
  assert.equal(restored.expectedRevision, 3)
  assert.deepEqual(restored.current, current)
})

test('serializes a domain while allowing the queue to continue after a failed write', async () => {
  const { directory, filePath } = createWorkspace()
  try {
    const store = new VersionedDataStore<string | unknown[]>({
      filePath,
      label: 'small state',
      maxBytes: 4096,
      isData: (value): value is string | unknown[] =>
        typeof value === 'string' || Array.isArray(value),
      isLegacy: (value): value is string => typeof value === 'string'
    })
    await assert.rejects(store.save(42 as unknown as string, 0), /invalid structure/)
    await assert.rejects(
      store.save(JSON.parse('['.repeat(65) + '0' + ']'.repeat(65)), 0),
      /too deeply nested/
    )
    const failed = store.save('x'.repeat(5000), 0)
    const committed = store.save('after-failure', 0)
    await assert.rejects(failed, /too large/)
    assert.deepEqual(await committed, {
      version: 2,
      revision: 1,
      savedAt: (await committed).savedAt,
      data: 'after-failure'
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('recovers a corrupted primary from the atomic backup before returning a snapshot', async () => {
  const { directory, filePath } = createWorkspace()
  try {
    const recovered: string[] = []
    const store = new VersionedDataStore<string>({
      filePath,
      label: 'recoverable state',
      maxBytes: 4096,
      isData: (value): value is string => typeof value === 'string',
      isLegacy: (value): value is string => typeof value === 'string',
      onRecovery: () => recovered.push('recovered')
    })
    await store.save('first', 0)
    await store.save('second', 1)
    writeFileSync(filePath, '{broken')

    assert.deepEqual(await store.load(), {
      version: 2,
      revision: 1,
      savedAt: (await store.load())?.savedAt,
      data: 'first'
    })
    assert.deepEqual(recovered, ['recovered'])
    assert.equal(existsSync(`${filePath}.bak`), true)
    assert.equal(JSON.parse(readFileSync(filePath, 'utf-8')).data, 'first')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

function isLegacySession(value: unknown): value is {
  version: 1
  savedAt: string
  mode: string
  track: { id: string }
  position: number
} {
  return !!value && typeof value === 'object' && (value as { version?: unknown }).version === 1
}
