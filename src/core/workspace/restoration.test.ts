import assert from 'node:assert/strict'
import test from 'node:test'
import { captureQueueSession } from './tracks.ts'
import { resolveQueueSession } from './restoration.ts'
import { isSavedQueueTrack } from '../../shared/queueWorkspace.ts'
import type { TrackData } from '../../shared/track.ts'

test('saving and restoring local/provider array sessions retains occurrence-specific explicit source selection', async () => {
  const local: TrackData = {
    id: 'local',
    queueEntryId: 'local-occurrence',
    source: 'local',
    sourceSelection: 'explicit',
    title: 'Local',
    artist: '',
    album: '',
    filePath: 'D:/music/a.flac',
    fileName: 'a.flac',
    size: 0,
    duration: 60,
    cover: null,
    lyrics: null
  }
  const online: TrackData = {
    ...local,
    id: 'ncm:7',
    source: 'ncm',
    ncmSongId: 7,
    queueEntryId: 'online-occurrence',
    filePath: ''
  }
  const session = captureQueueSession(
    { now: () => 1000, newId: () => 'session' },
    'Explicit sources',
    [local, online],
    [local, online],
    local,
    0,
    'sequential'
  )
  assert.equal(
    session.entries.every((entry) => entry.sourceSelection === 'explicit'),
    true
  )
  assert.equal(session.entries.every(isSavedQueueTrack), true)
  assert.equal(isSavedQueueTrack({ ...session.entries[0], sourceSelection: 'anything' }), false)
  const result = await resolveQueueSession(JSON.parse(JSON.stringify(session)), {
    localTracks: new Map([['local', { ...local, sourceSelection: undefined }]]),
    savedStreams: new Map(),
    availableProviders: new Set(['ncm']),
    networkProfiles: new Set(),
    authorizeFiles: async (paths) => paths.map(() => true),
    isCurrent: () => true
  })
  assert.deepEqual(
    result.queue.map((track) => track.sourceSelection),
    ['explicit', 'explicit']
  )
  assert.deepEqual(
    result.queue.map((track) => track.queueEntryId),
    ['local-occurrence', 'online-occurrence']
  )
})
