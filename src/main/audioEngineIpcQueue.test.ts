import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeCueRange } from '../shared/cue.ts'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'
import { resolveAuthorizationBatch } from './security/authorizationBatch.ts'
import { normalizeIpcArray, normalizeIpcString } from './security/ipcValidation.ts'
import type { AudioEngineQueueItem } from '../shared/audioEngineTypes.ts'
import type { NativeQueueCommit, NativeQueueRebind } from '../shared/nativeQueue.ts'

function readPreloadSources(): string {
  const root = new URL('../preload/', import.meta.url)
  return [
    'index.ts',
    'types.ts',
    'index.d.ts',
    'sleepTimerEvents.ts',
    'domains/dataApi.ts',
    'domains/audioEngineApi.ts',
    'domains/desktopLyricsApi.ts',
    'domains/libraryApi.ts',
    'domains/mediaSubscriptionsApi.ts',
    'domains/networkSourcesApi.ts',
    'domains/settingsApi.ts',
    'domains/themesApi.ts',
    'domains/pluginsApi.ts',
    'domains/systemApi.ts',
    'domains/versionedData.ts'
  ]
    .map((rel) => readFileSync(new URL(rel, root), 'utf8'))
    .join('\n')
}

const source = readFileSync(new URL('./audio/engineIpc.ts', import.meta.url), 'utf8')
const preloadSource = readPreloadSources()
const preloadTypes = readFileSync(new URL('../preload/types.ts', import.meta.url), 'utf8')
const preloadDeclaration = readFileSync(new URL('../preload/index.d.ts', import.meta.url), 'utf8')
const deviceHotplugSource = readFileSync(
  new URL('./audio/deviceHotplug.ts', import.meta.url),
  'utf8'
)
const windowSource = readFileSync(new URL('./app/window.ts', import.meta.url), 'utf8')

test('queue occurrence IDs survive IPC normalization without aliases or identity truncation', () => {
  const declaration = (name: string) => {
    const start = source.indexOf(`function ${name}(`)
    return source.slice(start, source.indexOf('\n}', start) + 2)
  }
  const normalize = runInNewContext(
    stripTypeScriptTypes(
      `${declaration('toQueueItem')}\n${declaration('normalizeQueueText')}\ntoQueueItem`
    ),
    {
      normalizeCueRange,
      normalizeIpcString,
      MAX_AUDIO_SOURCE_LENGTH: 8192
    }
  ) as (value: unknown) => AudioEngineQueueItem | null
  const track = { id: 'same', source: 'D:/Music/same.flac' }
  assert.equal(normalize(track)?.logicalQueueEnd, undefined)
  for (const logicalQueueEnd of [true, false])
    assert.equal(normalize({ ...track, logicalQueueEnd })?.logicalQueueEnd, logicalQueueEnd)
  for (const logicalQueueEnd of [null, 0, 1, 'true', {}, []])
    assert.equal(normalize({ ...track, logicalQueueEnd }), null)
  assert.equal(normalize(track)?.queueEntryId, undefined)
  for (const queueEntryId of ['first', 'second', 'x'.repeat(128)])
    assert.equal(normalize({ ...track, queueEntryId })?.queueEntryId, queueEntryId)
  for (const queueEntryId of ['', ' first ', 'x'.repeat(129), 2, null, 'line\nbreak'])
    assert.equal(normalize({ ...track, queueEntryId }), null)
})

test('audioEngine loadQueue IPC accepts renderer queue items with source field', () => {
  const start = source.indexOf('function toQueueItem')
  const end = source.indexOf('ipcMain.handle(IPC.audioEngine.loadQueue', start)
  assert.notEqual(start, -1, 'toQueueItem should exist')
  assert.notEqual(end, -1, 'audioEngine:loadQueue handler should exist')
  const toQueueItem = source.slice(start, end)

  assert.match(toQueueItem, /typeof item\.source === 'string'/)
  assert.match(toQueueItem, /source: normalizedSource,\s*\n\s*title:/)
  assert.match(toQueueItem, /normalizeIpcString\(source, 'queue item source'/)
  assert.equal(
    /typeof item\.filePath === 'string'[\s\S]*typeof item\.source === 'string'/.test(toQueueItem),
    false,
    'source must be checked before filePath because renderer queue items no longer include filePath'
  )
})

test('audio engine cold start passes persisted software volume into the manager', () => {
  assert.match(source, /volume: runtime\.appSettings\.softwareVolume/)
})

test('audioEngine IPC normalizes untrusted renderer parameters', () => {
  assert.match(source, /const MAX_AUDIO_QUEUE_ITEMS = MAX_NATIVE_QUEUE_ITEMS/)
  assert.match(
    source,
    /normalizeIpcArray\(items, 'audio queue', MAX_AUDIO_QUEUE_ITEMS, toQueueItem\)/
  )
  assert.match(source, /queue\.length !== items\.length/)
  assert.match(source, /await resolveAuthorizationBatch\(/)
  assert.match(source, /source: sources\.get\(item\.source\)!/)
  assert.match(source, /normalizeIpcString\(source, 'audio source'/)
  assert.match(source, /await resolveAuthorizedPlaybackSource\(/)
  assert.match(source, /normalizeFiniteNumber\(time, 'seek time', 0, 0, Number\.MAX_SAFE_INTEGER\)/)
  assert.match(source, /normalizeFiniteNumber\(volume, 'volume', 1, 0, 1\)/)
  assert.match(source, /normalizeInteger\(points, 'spectrum points', 128, 8, 4096\)/)
  assert.match(
    source,
    /const cueRange = item\.cueRange === undefined \? undefined : normalizeCueRange\(item\.cueRange\)/
  )
  assert.match(source, /if \(cueRange === null\) return null/)
  assert.deepEqual(normalizeCueRange({ startSeconds: 10, endSeconds: 20 }), {
    startSeconds: 10,
    endSeconds: 20,
    pregapSeconds: 0,
    virtualPregapSeconds: 0,
    sourcePregapSeconds: 0
  })
  assert.equal(normalizeCueRange({ startSeconds: 20, endSeconds: 10 }), null)
  assert.equal(normalizeCueRange({ startSeconds: 0, endSeconds: 10, pregapSeconds: -1 }), null)
})

test('loadQueue authorizes duplicate sources once, retains CUE entries, and awaits native completion', async () => {
  const start = source.indexOf('ipcMain.handle(IPC.audioEngine.loadQueue')
  const declaration = source.slice(start, source.indexOf('\n  ipcMain.handle(', start + 1))
  let handler!: (event: unknown, items: unknown[], index: number) => Promise<void>
  let finish!: () => void
  const nativeCompletion = new Promise<void>((resolve) => {
    finish = resolve
  })
  let resolutions = 0
  let received: { id: string; source: string; cueRange: unknown }[] = []
  const diagnostics: string[] = []
  runInNewContext(stripTypeScriptTypes(declaration), {
    IPC: { audioEngine: { loadQueue: 'queue' } },
    ipcMain: {
      handle: (_channel: string, callback: typeof handler) => {
        handler = callback
      }
    },
    assertTrustedIpcSender: () => {},
    MAX_AUDIO_QUEUE_ITEMS: 5000,
    normalizeIpcArray: (items: unknown[]) => items,
    toQueueItem: () => {},
    normalizeInteger: (index: number) => index,
    resolveAuthorizationBatch,
    resolveAuthorizedPlaybackSource: async () => {
      resolutions++
      return 'canonical.flac'
    },
    ensureAudioEngineRuntime: async () => ({
      loadQueue: (items: typeof received) => {
        received = items
        return nativeCompletion
      }
    }),
    audioDiagnosticRecorder: { record: (kind: string) => diagnostics.push(kind) }
  })
  const items = Array.from({ length: 5000 }, (_, index) => ({
    id: String(index),
    source: 'same.flac',
    cueRange: { startSeconds: index }
  }))
  let completed = false
  const pending = handler({}, items, 17).then(() => {
    completed = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(resolutions, 1)
  assert.equal(received.length, 5000)
  assert.equal(received[17].source, 'canonical.flac')
  assert.equal(received[17].id, '17')
  assert.equal(received[17].cueRange, items[17].cueRange)
  assert.equal(completed, false)
  assert.deepEqual(diagnostics, [])
  finish()
  await pending
  assert.deepEqual(diagnostics, ['queue-loaded'])
})

test('the native queue ceiling is one shared constant on both sides of the IPC', () => {
  const sharedSource = readFileSync(new URL('../shared/nativeQueue.ts', import.meta.url), 'utf8')
  const preparationSource = readFileSync(
    new URL('../renderer/src/utils/nativeQueuePreparation.ts', import.meta.url),
    'utf8'
  )

  assert.match(sharedSource, /export const MAX_NATIVE_QUEUE_ITEMS = 5000/)
  assert.match(
    source,
    /import \{ MAX_NATIVE_QUEUE_ITEMS \} from '\.\.\/\.\.\/shared\/nativeQueue\.ts'/
  )
  // The renderer must prepare a bounded native queue rather than issue a
  // request this handler rejects: the rejection happens before audioEngine:play,
  // so playback dies on every backend and every output device.
  assert.match(
    preparationSource,
    /import \{ MAX_NATIVE_QUEUE_ITEMS \} from '\.\.\/\.\.\/\.\.\/shared\/nativeQueue\.ts'/
  )
  assert.match(
    preparationSource,
    /if \(options\.queue\.length > MAX_NATIVE_QUEUE_ITEMS\) \{\s*return prepareNcmWindow\(options, currentItem, currentIndex\)/
  )
})

test('queue cursor IPC freshly authorizes its source before forwarding the main-owned token', async () => {
  const start = source.indexOf('ipcMain.handle(IPC.audioEngine.selectQueueItem')
  const declaration = source.slice(start, source.indexOf('\n  ipcMain.handle(', start + 1))
  let handler!: (event: unknown, selection: unknown) => Promise<boolean>
  let denied = false
  const calls: string[] = []
  const selections: unknown[] = []
  runInNewContext(stripTypeScriptTypes(declaration), {
    IPC: { audioEngine: { selectQueueItem: 'select' } },
    ipcMain: {
      handle: (_channel: string, callback: typeof handler) => {
        handler = callback
      }
    },
    assertTrustedIpcSender: () => calls.push('trusted'),
    MAX_AUDIO_QUEUE_ITEMS: 5000,
    MAX_AUDIO_SOURCE_LENGTH: 8192,
    normalizeIpcString: (value: string) => value,
    normalizeInteger: (value: number) => value,
    resolveAuthorizedPlaybackSource: async () => {
      calls.push('authorize')
      if (denied) throw new Error('denied')
      return 'canonical.flac'
    },
    outputTest: { stop: async () => calls.push('stop-test') },
    ensureAudioEngineRuntime: async () => ({
      selectQueueItem: async (selection: unknown) => {
        calls.push('select')
        selections.push(selection)
        return false // A stale token stays rejected by main.
      }
    })
  })
  const selection = { queueToken: 'stale', index: 3, id: 'cue:3', source: 'alias.flac' }
  assert.equal(await handler({}, selection), false)
  assert.deepEqual(calls, ['trusted', 'authorize', 'stop-test', 'select'])
  assert.equal(
    JSON.stringify(selections[0]),
    JSON.stringify({ ...selection, source: 'canonical.flac' })
  )
  denied = true
  await assert.rejects(handler({}, selection), /denied/)
  assert.equal(selections.length, 1)
  await assert.rejects(handler({}, []), /Invalid queue selection/)
})

test('queue handoff IPC strictly validates identity and authorizes every source before native dispatch', async () => {
  const declaration = (name: string) => {
    const start = source.indexOf(`function ${name}(`)
    return source.slice(start, source.indexOf('\n}', start) + 2)
  }
  const start = source.indexOf('ipcMain.handle(IPC.audioEngine.rebindQueue')
  const handlerSource = source.slice(start, source.indexOf('\n  ipcMain.handle(', start + 1))
  let handler!: (event: unknown, request: unknown) => Promise<NativeQueueCommit | null>
  let trusted = true,
    denied = ''
  const authorized: string[] = [],
    received: NativeQueueRebind[] = []
  let complete!: (value: NativeQueueCommit | null) => void
  const nativeReply = new Promise<NativeQueueCommit | null>((resolve) => {
    complete = resolve
  })
  runInNewContext(
    stripTypeScriptTypes(
      `${declaration('toQueueItem')}\n${declaration('normalizeQueueText')}\n${handlerSource}`
    ),
    {
      IPC: { audioEngine: { rebindQueue: 'rebind' } },
      ipcMain: {
        handle: (_channel: string, callback: typeof handler) => {
          handler = callback
        }
      },
      assertTrustedIpcSender: () => {
        if (!trusted) throw new Error('untrusted')
      },
      MAX_AUDIO_QUEUE_ITEMS: 5000,
      MAX_AUDIO_SOURCE_LENGTH: 8192,
      normalizeIpcString,
      normalizeIpcArray,
      normalizeCueRange,
      resolveAuthorizationBatch,
      resolveAuthorizedPlaybackSource: async (source: string) => {
        authorized.push(source)
        if (source === denied) throw new Error('denied')
        return `canonical:${source}`
      },
      ensureAudioEngineRuntime: async () => ({
        rebindQueue: (request: NativeQueueRebind) => {
          received.push(request)
          return nativeReply
        }
      })
    }
  )
  const request = {
    expected: { queueToken: 'old', index: 299_999, id: 'cue', source: 'disc.flac' },
    items: [
      {
        id: 'cue',
        source: 'disc.flac',
        queueEntryId: 'new-occurrence',
        cueRange: { startSeconds: 10, endSeconds: 20 }
      },
      { id: 'next', source: 'next.flac' }
    ],
    startIndex: 0,
    playMode: 'sequential'
  }
  const invalid = [
    null,
    [],
    { ...request, expected: [] },
    { ...request, expected: { ...request.expected, index: '49' } },
    { ...request, expected: { ...request.expected, index: 0.5 } },
    { ...request, startIndex: -1 },
    { ...request, startIndex: 2 },
    { ...request, startIndex: '0' },
    { ...request, startIndex: 0.5 },
    { ...request, playMode: 'shuffle' },
    { ...request, items: [] },
    { ...request, items: Array(5001).fill(request.items[0]) },
    {
      ...request,
      items: [{ ...request.items[0], cueRange: { startSeconds: 20, endSeconds: 10 } }]
    },
    { ...request, items: [{ ...request.items[0], queueEntryId: ' padded ' }] }
  ]
  for (const bad of invalid) await assert.rejects(handler({}, bad))
  assert.deepEqual(authorized, [])
  assert.equal(received.length, 0)
  trusted = false
  await assert.rejects(handler({}, request), /untrusted/)
  trusted = true
  denied = 'next.flac'
  await assert.rejects(handler({}, request), /denied/)
  assert.equal(received.length, 0)
  denied = ''
  authorized.length = 0
  let settled = false
  const pending = handler({}, request).then((commit) => {
    settled = true
    return commit
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  assert.deepEqual(authorized, ['disc.flac', 'next.flac'])
  assert.equal(received.length, 1)
  assert.equal(received[0].expected.source, 'canonical:disc.flac')
  assert.equal(received[0].expected.index, 299_999)
  assert.equal(received[0].items[0].queueEntryId, 'new-occurrence')
  assert.deepEqual(received[0].items[0].cueRange, normalizeCueRange(request.items[0].cueRange))
  assert.equal(received[0].items[1].source, 'canonical:next.flac')
  const commit = { queueToken: 'new' }
  complete(commit)
  assert.equal(await pending, commit)
})

test('loadQueue outcomes reach the audio diagnostics log', () => {
  assert.match(source, /const requestedItemCount = Array\.isArray\(items\) \? items\.length : -1/)
  assert.match(source, /audioDiagnosticRecorder\?\.record\('queue-loaded', \{/)
  assert.match(source, /audioDiagnosticRecorder\?\.record\(\s*'queue-load-failed',/)
  assert.match(source, /requestedItems: requestedItemCount/)
  assert.match(source, /limit: MAX_AUDIO_QUEUE_ITEMS/)
})

test('config-applied crosses the manager, IPC, and preload boundary', () => {
  assert.match(source, /audioEngineManager\.on\('config-applied'/)
  assert.match(source, /webContents\.send\(IPC\.audioEngine\.configApplied, event\)/)
  assert.match(preloadSource, /ipcRenderer\.on\(IPC\.audioEngine\.configApplied/)
  assert.match(preloadSource, /audioEngineConfigAppliedCallbacks/)
  assert.match(preloadSource, /onConfigApplied:/)

  assert.match(preloadTypes, /export interface AudioEngineConfigAppliedEvent/)
  assert.match(preloadTypes, /requestedConfigRevision: number/)
  assert.match(preloadTypes, /appliedConfigRevision: number/)
  assert.match(
    preloadDeclaration,
    /import type\s*\{[^}]*\bAudioEngineConfigAppliedEvent\b[^}]*\}\s*from '\.\/types\.ts'/
  )
  assert.match(
    preloadDeclaration,
    /onConfigApplied: \(cb: \(event: AudioEngineConfigAppliedEvent\) => void\) => \(\) => void/
  )
})

test('offline analysis is routed away from the playback audio service', () => {
  const managerSource = readFileSync(new URL('./audioEngineManager.ts', import.meta.url), 'utf8')
  const typesSource = readFileSync(new URL('./audio/audioEngineTypes.ts', import.meta.url), 'utf8')
  const serviceClientSource = readFileSync(
    new URL('./audioEngineServiceClient.ts', import.meta.url),
    'utf8'
  )
  const analysisClientSource = readFileSync(
    new URL('./audioAnalysisServiceClient.ts', import.meta.url),
    'utf8'
  )
  const nativeHeaderSource = readFileSync(
    new URL('../../audio-engine/include/twilight_audio_engine.h', import.meta.url),
    'utf8'
  )
  const nativeBridgeSource = readFileSync(
    new URL('../../audio-engine/napi/twilight_audio_node.cpp', import.meta.url),
    'utf8'
  )

  assert.match(typesSource, /AnalyzeBpm\?: \(source: string, optionsJson\?: string\)/)
  assert.match(managerSource, /async analyzeBpm\(/)
  assert.doesNotMatch(managerSource, /audioServiceBinding\.callAsync\?\.\('AnalyzeBpm'/)
  assert.match(serviceClientSource, /must use the isolated audio analysis service/)
  assert.match(analysisClientSource, /class AudioAnalysisServiceClient/)
  assert.match(analysisClientSource, /maxConcurrency/)
  assert.match(analysisClientSource, /maxQueueSize/)
  assert.match(nativeHeaderSource, /TAE_AnalyzeBpm/)
  assert.match(nativeBridgeSource, /define\(env, exports, "AnalyzeBpm", AnalyzeBpm\)/)
})

test('main window installs Windows audio device hotplug watcher', () => {
  assert.match(deviceHotplugSource, /const WM_DEVICECHANGE = 0x0219/)
  assert.match(deviceHotplugSource, /process\.platform !== 'win32'/)
  assert.match(deviceHotplugSource, /win\.hookWindowMessage\(WM_DEVICECHANGE/)
  assert.match(deviceHotplugSource, /AUDIO_DEVICE_CHANGE_DEBOUNCE_MS = 250/)
  assert.match(
    deviceHotplugSource,
    /notifyAudioDeviceOptionsChanged\(\s*'platform-device-change:wm-devicechange'\s*\)/
  )
  assert.match(windowSource, /installAudioDeviceHotplugWatcher\(runtime\.mainWindow\)/)
})

test('audio hotplug watcher listens for ALSA hw device node changes on Linux', () => {
  assert.match(deviceHotplugSource, /const ALSA_DEVICE_DIR = '\/dev\/snd'/)
  assert.match(deviceHotplugSource, /const ALSA_DEVICE_WATCH_RETRY_MS = 5000/)
  assert.match(deviceHotplugSource, /process\.platform === 'linux'/)
  assert.match(deviceHotplugSource, /installAlsaDeviceHotplugWatcher\(\)/)
  assert.match(deviceHotplugSource, /watch\(ALSA_DEVICE_DIR, \{ persistent: false \}/)
  assert.match(deviceHotplugSource, /scheduleAlsaDeviceWatchRetry\(\)/)
  assert.match(deviceHotplugSource, /watcher\.on\('error'/)
  assert.match(deviceHotplugSource, /watcher\.on\('close'/)
  assert.match(deviceHotplugSource, /alsaWatchRetryTimer\.unref\?\.\(\)/)
  assert.match(
    deviceHotplugSource,
    /notifyAudioDeviceOptionsChanged\(\s*'platform-device-change:alsa-dev-snd'\s*\)/
  )
})
