import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CoreLyricsService, type CoreLyricsOptions } from './service.ts'
import { VersionedDataStore } from '../persistence/versionedDataStore.ts'
import { createLocalLyricsLoader } from './localLoader.ts'
import { importLyricDraft, exportLyricDraft } from './files.ts'
import {
  DEFAULT_LYRICS_MANAGEMENT,
  isLyricsManagementDocument,
  type LyricsManagementDocument
} from '../../shared/lyricsManagement.ts'
import type { TrackData } from '../../shared/track.ts'
import type { MediaProviderLyrics } from '../../shared/providerLyrics.ts'

const empty = (): MediaProviderLyrics => ({ lyrics: null, translatedLyrics: null })
const track = (id = 'fixture:one'): TrackData => ({
  id,
  source: 'fixture',
  queueEntryId: 'first',
  title: 'One',
  artist: 'Artist',
  album: 'Album',
  filePath: '',
  fileName: '',
  duration: 180,
  size: 0,
  lyrics: null,
  cover: null
})
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
async function until(ready: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (ready()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  assert.ok(ready(), 'lyrics work should settle')
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function fixture(
  t: test.TestContext,
  settings: {
    legacy?: LyricsManagementDocument
    sources?: Partial<CoreLyricsOptions['sources']>
    timers?: CoreLyricsOptions['timers']
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'twilight-core-lyrics-'))
  const file = join(root, 'lyrics-management.json')
  if (settings.legacy) await writeFile(file, JSON.stringify(settings.legacy))
  const repository = new VersionedDataStore<LyricsManagementDocument>({
    filePath: file,
    label: 'lyrics',
    maxBytes: 8 * 1024 * 1024,
    isData: isLyricsManagementDocument,
    isLegacy: isLyricsManagementDocument
  })
  const failures: unknown[] = []
  let writes = 0
  const service = new CoreLyricsService({
    repository: {
      load: () => repository.load(),
      save: (document, revision) => {
        writes++
        return repository.save(document, revision)
      }
    },
    now: () => Date.parse('2026-10-22T00:00:00Z'),
    changed() {},
    failed: (error) => failures.push(error),
    timers: settings.timers ?? {
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout)
    },
    sources: {
      getAppSettings: () => ({ value: { onlineLyricsFallback: false } }),
      loadLocalLyrics: async () => null,
      resolveProviderLyrics: async () => empty(),
      loadAmlTtml: async () => null,
      loadOnlineLyrics: async () => null,
      ...settings.sources
    },
    search: async (track) => ({
      query: { title: track.title, artist: track.artist },
      candidates: [],
      best: null
    }),
    importDraft: async () => null,
    exportDraft: async () => null
  })
  t.after(async () => {
    await service.shutdown()
    await rm(root, { recursive: true, force: true })
  })
  await service.initialize()
  return { root, file, repository, service, failures, writes: () => writes }
}

test('legacy manual layers, preferences and offsets attach without changing automatic content or playback', async (t) => {
  const legacy: LyricsManagementDocument = {
    ...DEFAULT_LYRICS_MANAGEMENT,
    globalOffsetMs: 125,
    showRomanization: true,
    tracks: {
      'fixture:one': {
        offsetMs: -25,
        source: 'manual',
        original: '[00:01]Manual',
        translation: 'Translation',
        romanization: 'Romanization',
        updatedAt: '2024-01-01'
      }
    }
  }
  const f = await fixture(t, { legacy })
  f.service.observe({ ...track(), lyrics: '[00:01]Embedded', lyricsSource: 'embedded' })
  f.service.activate()
  await until(() => f.service.state().loadState.status === 'empty')
  const result = f.service.content()
  assert.equal(result.automatic!.original, '[00:01]Embedded')
  assert.equal(result.effective!.original, '[00:01]Manual')
  assert.equal(result.effective!.translation, 'Translation')
  assert.equal(result.offsetSeconds, 0.1)
  assert.equal(f.service.state().preferences.showRomanization, true)
  assert.deepEqual((await f.repository.load())!.data, legacy)
  assert.equal(f.writes(), 0)
  f.service.observe({ ...track(), queueEntryId: 'second' })
  assert.equal(f.service.content().current!.occurrenceId, 'second')
  assert.equal(f.service.content().automatic!.original, '[00:01]Embedded')
  assert.doesNotMatch(JSON.stringify(result), /filePath|streamUrl|cueRange/)
})

test('local sidecars load from authorized audio paths without a renderer-derived directory; embedded originals retain priority', async (t) => {
  const f = await fixture(t)
  const audio = join(f.root, 'disc.flac')
  await writeFile(join(f.root, 'disc.lrc'), '[00:01]Sidecar')
  await writeFile(join(f.root, 'disc_trans.lrc'), '[00:01]Translation')
  await writeFile(join(f.root, 'disc_roma.lrc'), '[00:01]Romanization')
  const calls: string[] = []
  const load = createLocalLyricsLoader({
    audioFile: async (path) => {
      calls.push(path)
      assert.equal(path, audio)
      return path
    },
    directory: async () => {
      throw Error('Must derive from authorized audio file')
    }
  })
  const second = await fixture(t, { sources: { loadLocalLyrics: load } })
  second.service.observe({
    ...track('local'),
    source: 'local',
    filePath: audio,
    fileName: 'disc.flac',
    lyrics: '[00:01]Embedded',
    lyricsSource: 'embedded'
  })
  second.service.activate()
  await until(() => second.service.content().effective!.translation != null)
  assert.equal(second.service.content().effective!.original, '[00:01]Embedded')
  assert.equal(second.service.content().effective!.translation, '[00:01]Translation')
  assert.equal(second.service.content().effective!.romanization, '[00:01]Romanization')
  assert.equal(calls.length, 2)
  await second.service.edit({
    revision: 0,
    edit: { kind: 'track', trackId: 'local', patch: { source: 'local' } }
  })
  await until(() => second.service.content().automatic!.original === '[00:01]Sidecar')
  assert.equal(second.service.content().effective!.originalSource, 'local')
})

test('late superseded loads cannot overwrite a newer reload or manual layer; Core accepts commands during a slow lookup', async (t) => {
  const calls: Array<{
    work: ReturnType<typeof deferred<MediaProviderLyrics>>
    signal: AbortSignal
  }> = []
  const f = await fixture(t, {
    sources: {
      resolveProviderLyrics: (_track, signal) => {
        const work = deferred<MediaProviderLyrics>()
        calls.push({ work, signal })
        return work.promise
      }
    }
  })
  f.service.observe(track())
  f.service.activate()
  await until(() => calls.length === 1)
  const reload = f.service.reload(f.service.state().current!)
  await until(() => calls.length === 2)
  assert.equal(calls[0].signal.aborted, true)
  await f.service.edit({
    revision: 0,
    edit: {
      kind: 'track',
      trackId: 'fixture:one',
      patch: {
        originalSelection: 'manual',
        original: '[00:01]Edited while loading'
      }
    }
  })
  await until(() => calls.length === 3)
  calls[2].work.resolve({ lyrics: '[00:01]Newest', translatedLyrics: null })
  await until(() => f.service.content().automatic!.original === '[00:01]Newest')
  calls[1].work.resolve({ lyrics: '[00:01]Superseded reload', translatedLyrics: null })
  await reload
  calls[0].work.resolve({ lyrics: '[00:01]Old activation', translatedLyrics: null })
  await tick()
  assert.equal(f.service.content().automatic!.original, '[00:01]Newest')
  assert.equal(f.service.content().effective!.original, '[00:01]Edited while loading')
  assert.equal(f.writes(), 1)
})

test('single-writer edits fence revisions, cancel queued writes and publish only disk-acknowledged documents', async (t) => {
  const f = await fixture(t)
  f.service.observe(track())
  const one = f.service.edit({ revision: 0, edit: { kind: 'globalOffset', offsetMs: 300000 } })
  const two = f.service.edit({
    revision: 0,
    edit: { kind: 'visibility', patch: { showOriginal: false } }
  })
  const results = await Promise.allSettled([one, two])
  assert.equal(results[0].status, 'fulfilled')
  assert.equal((results[1] as PromiseRejectedResult).reason.code, 'STALE_REVISION')
  const abort = new AbortController()
  const cancelled = f.service.edit(
    { revision: 1, edit: { kind: 'globalOffset', offsetMs: 0 } },
    abort.signal
  )
  abort.abort()
  await assert.rejects(cancelled)
  assert.equal(f.service.state().preferences.globalOffsetMs, 120000)
  assert.equal(f.writes(), 1)
  const disk = JSON.parse(await readFile(f.file, 'utf8'))
  assert.equal(disk.revision, f.service.getRevision())
  assert.equal(disk.data.globalOffsetMs, 120000)
  assert.throws(
    () => f.service.search({ trackId: 'fixture:other', occurrenceId: 'first' }),
    /selection changed/
  )
})

test('retry scheduling belongs to Core and is released on shutdown, not to a window or client', async (t) => {
  let serial = 0,
    attempts = 0
  const timers = new Map<number, { callback(): void; delay: number }>()
  const f = await fixture(t, {
    timers: {
      setTimeout: (callback, delay) => {
        timers.set(++serial, { callback, delay })
        return serial
      },
      clearTimeout: (handle) => {
        timers.delete(handle as number)
      }
    },
    sources: {
      resolveProviderLyrics: async () => {
        if (++attempts === 1) throw Error('offline')
        return { lyrics: '[00:01]Recovered', translatedLyrics: null }
      }
    }
  })
  f.service.observe(track())
  f.service.activate()
  await until(() => f.service.state().loadState.status === 'failed')
  const retry = [...timers.entries()].find(([, timer]) => timer.delay === 750)!
  assert.ok(retry)
  timers.delete(retry[0])
  retry[1].callback()
  await until(() => f.service.state().loadState.status === 'ready')
  assert.equal(f.service.content().effective!.original, '[00:01]Recovered')
  await f.service.shutdown()
  assert.equal(timers.size, 0)
  assert.equal(attempts, 2)
})

test('lyric file drafts preserve import validation, encoding and recoverable atomic export without accepting client paths', async (t) => {
  const f = await fixture(t)
  const file = join(f.root, 'lyrics.lrc')
  await writeFile(file, '[00:01]Before')
  assert.equal(await importLyricDraft(async () => file), '[00:01]Before')
  assert.equal(await exportLyricDraft(async () => file, '[00:02]After'), file)
  assert.equal(await readFile(file + '.bak', 'utf8'), '[00:01]Before')
  assert.equal(await readFile(file, 'utf8'), '[00:02]After')
  assert.equal(await importLyricDraft(async () => null), null)
  await assert.rejects(
    exportLyricDraft(async () => file, 'not LRC'),
    /timestamp/
  )
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(exportLyricDraft(async () => file, '[00:03]Cancelled', controller.signal))
  assert.equal(await readFile(file, 'utf8'), '[00:02]After')
})
