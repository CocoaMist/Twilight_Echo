import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { basename, dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { CoreEntityMetadataService } from '../src/core/library/entityMetadataService.ts'
import type { MetadataProvider } from '../src/core/library/entityMetadataProvider.ts'
import {
  LibraryDatabaseServiceClient,
  type DatabaseUtilityProcess
} from '../src/main/library/libraryDatabaseServiceClient.ts'
import type { LibraryDatabaseWorkerRequest } from '../src/main/library/libraryDatabaseProtocol.ts'
import type { ArtistIdentityCandidate, EntityMetadataFact } from '../src/shared/entityMetadata.ts'

const MBID = 'a223958d-5c56-4b2c-a30a-87e357bc121b'
const INTRODUCTION = 'A deterministic fixture introduction for the background playback probe.'
const evidence = {
  provider: 'musicbrainz', externalId: MBID,
  url: `https://musicbrainz.org/artist/${MBID}`, license: 'CC0-1.0',
  licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
  attribution: 'Synthetic benchmark fixture', revision: 'fixture', retrievedAt: 1700000000000
}
const candidate: ArtistIdentityCandidate = {
  mbid: MBID, name: 'Worker probe artist', type: 'Person', disambiguation: 'Synthetic fixture',
  wikidataId: null, evidence
}
const fact: EntityMetadataFact = {
  field: 'introduction', language: 'en', value: INTRODUCTION, attribution: evidence
}

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
async function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Worker probe timed out: ${label}`)), 30_000)
    })])
  } finally { clearTimeout(timer) }
}
async function until(check: () => Promise<boolean>, label: string) {
  const started = performance.now()
  while (!await check()) {
    if (performance.now() - started >= 30_000) throw new Error(`Worker probe timed out: ${label}`)
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
}
function summary(samplesMs: number[]) {
  const ordered = [...samplesMs].sort((a, b) => a - b)
  return {
    samplesMs, p50Ms: ordered[Math.ceil(ordered.length * 0.5) - 1],
    p95Ms: ordered[Math.ceil(ordered.length * 0.95) - 1], maxMs: ordered.at(-1)!
  }
}

/** Real database IPC + Core task owner. The provider is controlled in-process, not HTTP or audio. */
export async function probeMusicLibraryWorker(options: {
  databasePath: string; localTrackId: string; samples?: number; progress?: (phase: string) => void
}) {
  const samples = options.samples ?? 12
  assert.ok(Number.isSafeInteger(samples) && samples >= 1 && samples <= 100)
  // The production worker resolves this fixed filename beside the legacy JSON entry point.
  assert.equal(basename(options.databasePath), 'music-library.sqlite')
  const progress = options.progress ?? (() => {})
  let child: ChildProcess | undefined
  const requestCounts: Record<string, number> = {}
  const client = new LibraryDatabaseServiceClient({
    serviceEntry: fileURLToPath(new URL('../src/main/library/libraryDatabaseService.ts', import.meta.url)),
    libraryFilePath: join(dirname(options.databasePath), 'music-library.json'),
    fork(entry) {
      child = fork(entry, [], { execArgv: ['--experimental-strip-types'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
      // Drain diagnostics without mixing them into the machine-readable benchmark result.
      child.stderr?.resume()
      child.on('message', message => {
        const kind = (message as { kind?: string }).kind
        if (kind === 'ready' || kind === 'opened' || kind === 'open-error') progress(`worker-${kind}`)
      })
      Object.assign(child, { postMessage(request: LibraryDatabaseWorkerRequest) {
        if (request.kind === 'call') requestCounts[request.method] = (requestCounts[request.method] ?? 0) + 1
        child!.send(request)
      } })
      return child as unknown as DatabaseUtilityProcess
    }
  })
  const resolveEntered = gate(), resolveHeld = gate(), enrichEntered = gate(), enrichHeld = gate()
  const providerRequests = { resolve: 0, enrich: 0 }
  let metadataEvents = 0
  const failures: unknown[] = []
  const provider: MetadataProvider = {
    id: 'musicbrainz-wiki',
    capabilities: { entities: ['artist'], fields: ['name', 'description', 'introduction'], explicitIdentity: true },
    async resolve(_id, signal) {
      providerRequests.resolve++; resolveEntered.release(); await resolveHeld.promise
      signal.throwIfAborted(); return candidate
    },
    async enrich(_id, _language, signal) {
      providerRequests.enrich++; enrichEntered.release(); await enrichHeld.promise
      signal.throwIfAborted(); return [fact]
    }
  }
  let metadata: CoreEntityMetadataService | undefined
  try {
    progress('opening')
    const start = performance.now()
    const initial = await client.getMetadata()
    const workerOpenMs = performance.now() - start
    progress('queue-creating')
    const queue = await client.createLibraryQueue({ ids: [options.localTrackId], sort: 'playlist' })
    assert.equal(queue.total, 1)
    const original = await client.readLibraryQueue(queue.id, 0, 1)
    assert.equal(original.items[0]?.track?.id, options.localTrackId)
    const probeReads = async () => {
      const times: number[] = []
      for (let i = 0; i < samples; i++) {
        const began = performance.now()
        const [snapshot, page, tracks] = await Promise.all([
          client.getLibraryQueue(queue.id), client.readLibraryQueue(queue.id, 0, 1),
          client.getTracksByIds([options.localTrackId])
        ])
        times.push(performance.now() - began)
        assert.deepEqual(snapshot, queue)
        assert.deepEqual(page, original)
        assert.equal(tracks.tracks.length, 1)
        assert.equal(tracks.tracks[0].id, options.localTrackId)
      }
      return summary(times)
    }
    progress('idle-reads')
    const idle = await probeReads()
    progress('artist-query')
    const artist = (await client.catalogQuery({ kind: 'artist', scope: 'library', limit: 1 })).items[0]
    assert.ok(artist, 'The mixed fixture must have a real source-bound artist')
    metadata = new CoreEntityMetadataService({
      database: client, provider,
      policy: () => ({ enabled: true, publicServiceApproved: true, wikipediaText: true,
        contact: 'https://example.invalid/synthetic-benchmark' }),
      now: Date.now, changed() { metadataEvents++ }, failed(error) { failures.push(error) }
    })
    metadata.activate()
    progress('resolve-scheduling')
    const resolve = await metadata.resolve({ entityId: artist.id, mbid: MBID, language: 'en', batchId: 'worker-probe' })
    await deadline(resolveEntered.promise, 'provider resolve entry')
    assert.equal((await client.metadataJobs({ jobId: resolve.id })).items[0].state, 'running')
    // All these responses must arrive BEFORE the provider is released.
    progress('resolving-reads')
    const resolving = await probeReads()
    resolveHeld.release()
    await until(async () => (await client.metadataJobs({ jobId: resolve.id })).items[0].state === 'needs_review', 'resolve commit')
    await metadata.decide({ jobId: resolve.id, generation: resolve.generation, decision: 'confirm' })
    progress('enrich-scheduling')
    const enrich = await metadata.enrich({ entityId: artist.id, language: 'en', batchId: 'worker-probe' })
    await deadline(enrichEntered.promise, 'provider enrich entry')
    progress('enriching-reads')
    const enriching = await probeReads()
    enrichHeld.release()
    // Interleave queue reads with the real metadataFinish publication transaction.
    progress('publishing-reads')
    const publishing = await probeReads()
    await until(async () => (await client.metadataJobs({ jobId: enrich.id })).items[0].state === 'completed', 'facts commit')
    assert.equal((await metadata.detail(artist.id, 'en')).introduction?.value, INTRODUCTION)
    assert.deepEqual(await client.getLibraryQueue(queue.id), queue)
    assert.deepEqual(await client.readLibraryQueue(queue.id, 0, 1), original)
    assert.equal((await client.getMetadata()).revision, initial.revision)
    assert.deepEqual(failures, [])
    assert.deepEqual(providerRequests, { resolve: 1, enrich: 1 })
    progress('complete')
    return {
      transport: 'production-database-worker-node-ipc' as const,
      providerMode: 'controlled-fixture-no-http' as const,
      externalNetworkRequests: 0, providerRequests, metadataEvents, requestCounts, workerOpenMs,
      samplesPerPhase: samples, requestsPerSample: 3, maxResponseTracks: 1,
      idle, resolving, enriching, publishing, queueUnchanged: true,
      metadataPublished: true, libraryRevisionUnchanged: true
    }
  } finally {
    resolveHeld.release(); enrichHeld.release()
    try { await metadata?.shutdown() }
    finally {
      const exited = child && child.exitCode === null && child.signalCode === null ? once(child, 'exit') : undefined
      try { await client.close() } finally { client.destroy(); await exited }
    }
  }
}
