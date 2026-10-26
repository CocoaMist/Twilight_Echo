import assert from 'node:assert/strict'
import test from 'node:test'
import { projectCoreError, projectCorePlayback, projectCoreTrack } from './projections.ts'
import { createDefaultPlaybackInfo } from '../main/audio/audioEngineHelpers.ts'
import { normalizeOutputConfig } from '../shared/audioOutputConfig.ts'
import { projectCoreOutput } from './audio/outputProjection.ts'

test('separate output diagnostics preserve finite output values but omit private DSP extensions', () => {
  const info = createDefaultPlaybackInfo('wasapi', '', false, normalizeOutputConfig()).outputInfo
  const projected = projectCoreOutput({
    ...info,
    deviceName: 'Device',
    diagnostics: { ...info.diagnostics, lastError: 'Failed https://media.test/song?token=private', privatePath: 'private' },
    conversionInfo: { ...info.conversionInfo, secret: 'private' },
    nativeDsp: { plugins: [], private: 'private' }
  } as typeof info)
  assert.equal(projected.deviceName, 'Device')
  assert.deepEqual(projected.conversionInfo, info.conversionInfo)
  assert.equal(projected.diagnostics.lastError, 'Failed <media-url>')
  assert.doesNotMatch(JSON.stringify(projected), /private|secret|nativeDsp|media.test/)
})

test('public metadata allowlists strip source URLs, provider credentials and arbitrary extensions at every depth', () => {
  const range = {
    startSeconds: 10,
    endSeconds: 70,
    pregapSeconds: 2,
    virtualPregapSeconds: 2,
    sourcePregapSeconds: 0
  }
  const track = projectCoreTrack({
    id: 'ncm:7',
    filePath: 'https://source.example/secret?token=private',
    streamUrl: 'https://cdn.example/secret',
    title: 'Seven',
    source: 'ncm',
    queueEntryId: 'occurrence',
    duration: 60,
    cueRange: { ...range, secret: 'private' },
    networkSource: { entry: { credentials: 'private' } },
    metadataMatch: { password: 'private' },
    artists: [{ id: 'artist', name: 'Artist', secret: 'private' }],
    albumId: { secret: 'private' },
    mediaPart: {
      groupId: 'disc',
      groupTitle: 'Album',
      title: 'Part',
      index: 1,
      count: 2,
      secret: 'private'
    },
    lyrics: 'private',
    extension: 'private',
    cover: 'https://cover.example/private?token=private'
  })
  assert.equal(track.queueEntryId, 'occurrence')
  assert.deepEqual(track.cueRange, range)
  assert.deepEqual(track.artists, [{ id: 'artist', name: 'Artist' }])
  assert.equal(track.albumId, undefined)
  assert.doesNotMatch(
    JSON.stringify(track),
    /private|secret|filePath|streamUrl|networkSource|lyrics/
  )
  const info = createDefaultPlaybackInfo('wasapi', '', false, normalizeOutputConfig())
  info.source = 'https://source.example/private?token=private'
  info.upcomingTrack = {
    id: 'next',
    queueEntryId: 'next:occurrence',
    source: info.source,
    title: 'Next',
    cueRange: range
  }
  info.outputInfo.actualDeviceName = 'private diagnostic not in player snapshot'
  const playback = projectCorePlayback(info)
  assert.equal(playback.upcomingTrack?.queueEntryId, 'next:occurrence')
  assert.deepEqual(playback.upcomingTrack?.cueRange, range)
  assert.doesNotMatch(JSON.stringify(playback), /private|source"|outputInfo/)
  playback.upcomingTrack!.cueRange!.endSeconds = 80
  assert.equal(range.endSeconds, 70)
})

test('public failures keep the cause without publishing signed URLs, userinfo or credentials', () => {
  const error = projectCoreError(
    new Error(
      'Decoder failed for https://user:private@media.test/secret?access_token=private MUSIC_U=private; Authorization: Bearer private password=private'
    )
  )
  assert.match(error, /Decoder failed/)
  assert.doesNotMatch(error, /private|media.test|access_token|secret/)
  assert.ok(projectCoreError('x'.repeat(5000)).length <= 4096)
})

test('BPM summaries omit full tempo maps and provider extensions', () => {
  const record = {
    id: 'one',
    title: 'One',
    filePath: 'private.wav',
    bpmAnalysis: {
      bpm: 120,
      confidence: 0.8,
      source: 'analyzed',
      algorithmVersion: 1,
      analyzedAt: '2026-10-23T00:00:00Z',
      bpmRange: [118, 122],
      tempoMap: [{ private: 'private' }],
      extension: 'private'
    }
  }
  const view = projectCoreTrack(record)
  assert.equal(view.bpmAnalysis?.bpm, 120)
  assert.deepEqual(view.bpmAnalysis?.bpmRange, [118, 122])
  assert.doesNotMatch(JSON.stringify(view), /private|tempoMap|extension/)
  assert.equal(
    projectCoreTrack({
      ...record,
      bpmAnalysis: { ...record.bpmAnalysis, analyzedAt: { private: 'private' } }
    }).bpmAnalysis,
    undefined
  )
})

test('AutoMix UI state includes native progress and safe failure reasons without restoring source authority', () => {
  const info = createDefaultPlaybackInfo('wasapi', '', false, normalizeOutputConfig())
  Object.assign(info, {
    autoMixMode: 'dj',
    autoMixState: 'mixing',
    autoMixPlanId: 19,
    autoMixOutputSeconds: 3,
    autoMixNextSourceSeconds: 2,
    autoMixStemEnhanced: true,
    autoMixReason: 'decode https://private.test/audio?token=secret',
    source: 'private.flac'
  })
  const view = projectCorePlayback(info)
  assert.equal(view.autoMixState, 'mixing')
  assert.equal(view.autoMixPlanId, 19)
  assert.equal(view.autoMixOutputSeconds, 3)
  assert.equal(view.autoMixNextSourceSeconds, 2)
  assert.equal(view.autoMixStemEnhanced, true)
  assert.doesNotMatch(JSON.stringify(view), /private|secret/)
})
