import assert from 'node:assert/strict'
import test from 'node:test'
import { CoreDuplicatesService } from './duplicatesService.ts'
import { toDuplicateCandidate } from './duplicateDetection.ts'
import type { DuplicateCandidate } from '../../shared/duplicateDetection.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function candidate(id: string, extra: Record<string, unknown> = {}): DuplicateCandidate {
  return toDuplicateCandidate({
    id,
    filePath: `Music/${id}.wav`,
    title: id,
    artist: 'Artist',
    album: 'Album',
    duration: 10,
    size: 200,
    ...extra
  })
}
function fixture(
  items: DuplicateCandidate[],
  overrides: Partial<ConstructorParameters<typeof CoreDuplicatesService>[0]> = {}
) {
  let serial = 0,
    changed = () => {}
  const reads: number[] = [],
    hashes: string[] = []
  const service = new CoreDuplicatesService({
    readCandidates: async (after, limit, revision) => {
      assert.ok(revision === undefined || revision === 7)
      reads.push(after)
      const page = items.slice(after, after + limit)
      return {
        items: page,
        revision: 7,
        nextCursor: after + page.length < items.length ? after + page.length : null
      }
    },
    authorizeFile: async (path) => path,
    hashContent: async (path) => {
      hashes.push(path)
      return 'a'.repeat(64)
    },
    pathKey: (path) => path.toLowerCase(),
    fileName: (path) => path.split('/').at(-1)!,
    yieldControl: () => new Promise<void>((done) => setImmediate(done)),
    newId: () => `inspection:${++serial}`,
    changed: () => changed(),
    ...overrides
  })
  const finished = () =>
    new Promise<void>((done) => {
      changed = () => {
        if (!['loading', 'inspecting'].includes(service.snapshot()!.state)) done()
      }
      changed()
    })
  return { service, reads, hashes, finished }
}

test('one detached inspection reads revision-fenced SQL pages; large groups and members stay paged and private', async () => {
  const { service, reads, hashes, finished } = fixture(
    Array.from({ length: 431 }, (_, i) => candidate(String(i), { contentHash: 'a'.repeat(64) }))
  )
  const accepted = service.start()
  assert.equal(service.start().id, accepted.id)
  assert.equal(accepted.state, 'loading')
  await finished()
  assert.deepEqual(reads, [0, 200, 400])
  assert.equal(hashes.length, 0)
  assert.deepEqual(service.snapshot(), {
    id: accepted.id,
    revision: 7,
    state: 'completed',
    candidates: 431,
    groups: 1,
    unavailable: 0
  })
  const groups = service.groups({ id: accepted.id })
  assert.deepEqual(groups.items[0], {
    index: 0,
    kind: 'contentHash',
    confidence: 'exact',
    total: 431,
    action: 'mergeSuggestion'
  })
  const page = service.items({ id: accepted.id, group: 0, offset: 200 })
  assert.equal(page.items.length, 200)
  assert.equal(page.total, 431)
  assert.equal(page.items[0].fileName.endsWith('.wav'), true)
  assert.doesNotMatch(
    JSON.stringify({ groups, page }),
    /filePath|Music\/|contentHash":|audioFingerprint|keepId|affectedIds/
  )
  const second = service.start()
  assert.notEqual(second.id, accepted.id)
  assert.throws(() => service.groups({ id: accepted.id }), { code: 'STALE_REVISION' })
  await finished()
  await service.shutdown()
})

test('CUE segments retain identity; exact source matches never merge different subtracks', async () => {
  const { service, finished } = fixture([
    candidate('cue-a', {
      filePath: 'Music/album.wav',
      cueRange: { startSeconds: 0, endSeconds: 10 }
    }),
    candidate('cue-b', {
      filePath: 'music/ALBUM.wav',
      cueRange: { startSeconds: 10, endSeconds: 20 }
    }),
    candidate('cue-copy', {
      filePath: 'music/ALBUM.wav',
      cueRange: { startSeconds: 0, endSeconds: 10 }
    })
  ])
  const { id } = service.start()
  await finished()
  assert.equal(service.groups({ id }).total, 1)
  assert.deepEqual(
    service
      .items({ id, group: 0 })
      .items.map((item) => item.id)
      .sort(),
    ['cue-a', 'cue-copy']
  )
  await service.shutdown()
})

test('missing or revoked hash reads remain review candidates and expose unavailable IDs, not filesystem failures', async () => {
  const { service, finished, hashes } = fixture(
    [candidate('missing', { title: 'Same' }), candidate('existing', { title: 'Same' })],
    {
      authorizeFile: async (path) => {
        if (path.includes('missing')) throw new Error('File unavailable')
        return path
      }
    }
  )
  const { id } = service.start()
  await finished()
  assert.equal(service.snapshot()!.state, 'completed')
  assert.deepEqual(service.unavailable({ id }).items, ['missing'])
  assert.equal(service.groups({ id }).items[0].kind, 'logicalTrack')
  assert.equal(hashes.length, 1)
  await service.shutdown()
})

test('cancel and shutdown join pending work without restarting or retaining partial results', async () => {
  const entered = deferred<void>(),
    released = deferred<void>()
  let active = 0
  const { service, finished } = fixture([candidate('one'), candidate('two')], {
    hashContent: async (_path, signal) => {
      active++
      entered.resolve()
      await released.promise
      active--
      signal.throwIfAborted()
      return 'a'.repeat(64)
    }
  })
  const { id } = service.start()
  await entered.promise
  let cancelled = false
  const cancelling = service.cancel(id).then(() => {
    cancelled = true
  })
  await new Promise<void>((done) => setImmediate(done))
  assert.equal(cancelled, false)
  assert.equal(active, 2)
  released.resolve()
  await cancelling
  assert.equal(active, 0)
  assert.equal(service.snapshot()!.state, 'cancelled')
  assert.throws(() => service.items({ id, group: 0 }), /not complete/)
  service.start()
  await finished()
  await service.shutdown()
  assert.throws(() => service.start(), /shutting down/)
})

test('a changed SQL content revision fails rather than publishing mixed-version results', async () => {
  let reads = 0
  const { service, finished } = fixture([], {
    readCandidates: async () => {
      if (++reads > 1) throw new Error('Library changed during inspection')
      return { revision: 1, items: [candidate('first')], nextCursor: 1 }
    }
  })
  const { id } = service.start()
  await finished()
  assert.equal(service.snapshot()!.state, 'failed')
  assert.match(service.snapshot()!.error!, /Library changed/)
  assert.throws(() => service.groups({ id }), /not complete/)
  await service.shutdown()
})
