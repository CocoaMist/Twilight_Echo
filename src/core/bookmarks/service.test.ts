import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CoreBookmarksService } from './service.ts'
import { VersionedDataStore } from '../persistence/versionedDataStore.ts'
import {
  DEFAULT_PLAYBACK_BOOKMARKS,
  isPlaybackBookmarksDocument,
  type PlaybackBookmarksDocument
} from '../../shared/playbackBookmarks.ts'
import type { TrackData } from '../../shared/track.ts'

const track = (id = 'long', occurrence = 'first'): TrackData => ({
  id,
  queueEntryId: occurrence,
  source: 'local',
  filePath: 'D:/Music/disc.flac',
  fileName: 'disc.flac',
  title: id,
  artist: 'Artist',
  album: 'Album',
  duration: 2000,
  size: 1000,
  cover: null,
  lyrics: null
})
async function fixture(t: test.TestContext, legacy?: PlaybackBookmarksDocument) {
  const root = await mkdtemp(join(tmpdir(), 'twilight-core-bookmarks-')),
    file = join(root, 'playback-bookmarks.json')
  if (legacy) await writeFile(file, JSON.stringify(legacy))
  const repository = new VersionedDataStore<PlaybackBookmarksDocument>({
    filePath: file,
    label: 'bookmarks',
    maxBytes: 4 * 1024 * 1024,
    isData: isPlaybackBookmarksDocument,
    isLegacy: isPlaybackBookmarksDocument
  })
  const failures: unknown[] = []
  let writes = 0
  const service = new CoreBookmarksService({
    repository: {
      load: () => repository.load(),
      save: async (doc, revision) => {
        writes++
        return repository.save(doc, revision)
      }
    },
    now: () => 1000,
    newId: () => `bm_${randomUUID()}`,
    changed() {},
    failed: (e) => failures.push(e)
  })
  t.after(async () => {
    await service.shutdown()
    await rm(root, { recursive: true, force: true })
  })
  await service.initialize()
  const page = (scope: 'all' | 'current' = 'all') =>
    service.page({ revision: service.state().revision, scope })
  return { service, repository, failures, file, page, writes: () => writes }
}

test('one native observation stream records pause/departure/shutdown resume points, without duplicate multi-window writes', async (t) => {
  const f = await fixture(t),
    one = track()
  f.service.observe(one, { state: 'playing', position: 40 })
  f.service.observe(one, { state: 'paused', position: 45 })
  f.service.observe(one, { state: 'paused', position: 45 })
  await f.service.flush()
  assert.equal(f.writes(), 1)
  assert.equal(f.page().items[0].positionSeconds, 45)
  f.service.observe(one, { state: 'playing', position: 80 })
  f.service.observe(
    { ...track('other'), filePath: 'D:/Music/other.flac' },
    { state: 'playing', position: 0 }
  )
  await f.service.flush()
  assert.equal(f.page().items.length, 1)
  assert.equal(f.page().items[0].positionSeconds, 80)
  f.service.observe(
    { ...track('other'), filePath: 'D:/Music/other.flac' },
    { state: 'playing', position: 88 }
  )
  await f.service.shutdown()
  const disk = JSON.parse(await readFile(f.file, 'utf8'))
  assert.equal(
    disk.data.bookmarks.find((b: { trackId: string }) => b.trackId === 'other').positionSeconds,
    88
  )
  assert.deepEqual(f.failures, [])
})

test('short tracks, first 15 seconds and final 10 seconds retain the original no-resume rules', async (t) => {
  const f = await fixture(t)
  for (const [duration, position] of [
    [100, 50],
    [2000, 14.9],
    [2000, 1991]
  ]) {
    const one = { ...track(), duration }
    f.service.observe(one, { state: 'playing', position })
    f.service.observe(one, { state: 'paused', position })
  }
  await f.service.flush()
  assert.equal(f.writes(), 0)
  const end = track()
  f.service.observe(end, { state: 'playing', position: 1998 })
  f.service.observe(end, { state: 'stopped', position: 0 })
  await f.service.flush()
  assert.equal(f.writes(), 0)
})

test('natural EOF does not save a stale pre-boundary sample as a resume point', async (t) => {
  const f = await fixture(t)
  const boundary = (trackSerial: number) => ({
    trackSerial,
    queueSerial: 0,
    trackTimeMs: 0,
    queueTimeMs: 0
  })
  f.service.observe(track(), { state: 'playing', position: 1980, naturalBoundaries: boundary(1) })
  f.service.observe(null, { state: 'stopped', position: 0, naturalBoundaries: boundary(2) })
  await f.service.flush()
  assert.equal(f.writes(), 0)
})

test('CUE/SACD keys and repeated queue occurrences keep their existing identities and selection fences', async (t) => {
  const f = await fixture(t)
  for (const one of [
    { ...track('cue1'), cueRange: { startSeconds: 0, endSeconds: 2000, pregapSeconds: 0 } },
    { ...track('cue2'), cueRange: { startSeconds: 2000, endSeconds: 4000, pregapSeconds: 0 } },
    { ...track('iso1'), subTrack: '#sacd-stereo-1' },
    { ...track('iso2'), subTrack: '#sacd-stereo-2' }
  ]) {
    f.service.observe(one, { state: 'paused', position: 5 })
    await f.service.edit({
      revision: f.service.state().revision,
      edit: { kind: 'addCurrent', current: f.service.state().current!, label: 'Mark' }
    })
  }
  assert.equal(f.page().items.length, 4)
  assert.doesNotMatch(JSON.stringify(f.page()), /trackKey|D:\/Music|filePath|subTrack|cueRange/)
  const old = f.service.state().current!
  f.service.observe(
    { ...track('iso2', 'second'), subTrack: '#sacd-stereo-2' },
    { state: 'paused', position: 40 }
  )
  await assert.rejects(
    f.service.edit({
      revision: f.service.state().revision,
      edit: { kind: 'addCurrent', current: old }
    }),
    (e: { code: string }) => e.code === 'STALE_REVISION'
  )
  const current = f.service.state().current!
  assert.equal(f.page('current').items.length, 1)
  assert.equal(
    f.service.position(f.page('current').items[0].id, f.service.state().revision, current),
    5
  )
  const another = f.page().items.find((b) => b.trackId === 'iso1')!
  assert.throws(
    () => f.service.position(another.id, f.service.state().revision, current),
    /current track/
  )
})

test('concurrent edits reject a stale resource revision and a cancelled queued request does not change disk', async (t) => {
  const f = await fixture(t)
  f.service.observe(track(), { state: 'paused', position: 45 })
  const current = f.service.state().current!,
    revision = f.service.state().revision
  const results = await Promise.allSettled([
    f.service.edit({ revision, edit: { kind: 'addCurrent', current } }),
    f.service.edit({ revision, edit: { kind: 'threshold', seconds: 60 } })
  ])
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[1].status, 'rejected')
  assert.equal((results[1] as PromiseRejectedResult).reason.code, 'STALE_REVISION')
  const controller = new AbortController()
  const work = f.service.edit(
    { revision: f.service.state().revision, edit: { kind: 'remove', id: f.page().items[0].id } },
    controller.signal
  )
  controller.abort()
  await assert.rejects(work)
  assert.equal(f.page().items.length, 1)
  assert.equal(f.writes(), 1)
})

test('legacy documents round-trip intact; resume offers attach to the current occurrence and dismissal never seeks', async (t) => {
  const legacy: PlaybackBookmarksDocument = {
    ...DEFAULT_PLAYBACK_BOOKMARKS,
    longTrackResumeSeconds: 1500,
    bookmarks: [
      {
        id: 'old',
        trackKey: 'local:D:/Music/disc.flac',
        trackId: 'old-id',
        positionSeconds: 123.5,
        label: 'Resume here',
        createdAt: '2024-01-01',
        updatedAt: '2024-02-01',
        kind: 'resume'
      }
    ]
  }
  const f = await fixture(t, legacy)
  assert.equal(f.service.state().longTrackResumeSeconds, 1500)
  f.service.observe(track(), { state: 'paused', position: 0 })
  assert.equal(f.service.state().resumeOffer!.positionSeconds, 123.5)
  await f.service.edit({
    revision: 0,
    edit: { kind: 'dismissOffer', current: f.service.state().current! }
  })
  assert.equal(f.service.state().resumeOffer, null)
  assert.equal(f.writes(), 0)
  assert.deepEqual((await f.repository.load())!.data, legacy)
  await f.service.edit({ revision: 0, edit: { kind: 'rename', id: 'old', label: ' Keep this ' } })
  const saved = (await f.repository.load())!.data
  assert.equal(saved.bookmarks[0].label, 'Keep this')
  assert.equal(saved.bookmarks[0].trackKey, legacy.bookmarks[0].trackKey)
  assert.equal(saved.bookmarks[0].createdAt, '2024-01-01')
})

test('the original per-track/global caps preserve resume entries while replacing the oldest manual marker', async (t) => {
  const legacy = {
    ...DEFAULT_PLAYBACK_BOOKMARKS,
    bookmarks: Array.from({ length: 64 }, (_, i) => ({
      id: `old:${i}`,
      trackKey: 'local:D:/Music/disc.flac',
      trackId: 'long',
      positionSeconds: i,
      label: `${i}`,
      createdAt: new Date(i * 1000).toISOString(),
      updatedAt: new Date(i * 1000).toISOString(),
      kind: i === 0 ? ('resume' as const) : ('manual' as const)
    }))
  }
  const f = await fixture(t, legacy)
  f.service.observe(track(), { state: 'paused', position: 99 })
  await f.service.edit({
    revision: 0,
    edit: { kind: 'addCurrent', current: f.service.state().current! }
  })
  const page = f.page()
  assert.equal(page.items.length, 64)
  assert.ok(page.items.some((b) => b.id === 'old:0'))
  assert.ok(!page.items.some((b) => b.id === 'old:1'))
})
