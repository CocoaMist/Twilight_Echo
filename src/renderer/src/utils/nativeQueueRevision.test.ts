import assert from 'node:assert/strict'
import test from 'node:test'
import { NativeQueueRevisionFence, synchronizeLatestNativeQueue } from './nativeQueueRevision.ts'
import { NativeQueueLoader } from './nativeQueueLoader.ts'
import type { Track } from '../types/music'
import { prepareNativeQueue } from './nativeQueuePreparation.ts'

test('background queue edits wait for authorization, queue commit and play of the active load', async () => {
  const fence = new NativeQueueRevisionFence(),
    loader = new NativeQueueLoader()
  const track = { id: 'one', filePath: 'D:/Music/one.flac', source: 'local' } as Track
  const edited = (await prepareNativeQueue({
    queue: [track],
    currentTrack: track,
    currentTarget: track.filePath,
    currentIndex: 0,
    isAudioFileAuthorized: async () => true
  }))!
  let authorize!: () => void
  const started = new Promise<void>((resolve) => {
    authorize = resolve
  })
  const calls: string[] = []
  const load = fence.serialize(async () => {
    const prepared = await loader.prepareAndLoad(
      {
        queue: [track],
        currentTrack: track,
        currentTarget: track.filePath,
        currentIndex: 0,
        isCurrent: () => true
      },
      {
        isAudioFileAuthorized: async () => {
          await started
          return true
        }
      },
      {
        loadQueue: async () => {
          calls.push('load')
          return { queueToken: 'active' }
        }
      }
    )
    assert.ok(prepared, 'a background edit is not a target-unavailable playback failure')
    calls.push('play')
    return prepared
  })
  const resync = fence.serialize(async () => {
    await loader.loadPrepared(
      edited,
      {
        loadQueue: async () => {
          calls.push('resync')
          return { queueToken: 'edited' }
        }
      },
      [track]
    )
  })
  await Promise.resolve()
  assert.deepEqual(calls, [])
  authorize()
  await Promise.all([load, resync])
  assert.deepEqual(calls, ['load', 'play', 'resync'])
  assert.equal(loader.findLogicalIndex({ queueIndex: 0, queueToken: 'edited' }, [track]), 0)
})

test('serialized native failures release the lane and superseded revisions skip queued work', async () => {
  const fence = new NativeQueueRevisionFence()
  const old = fence.next()
  let staleRan = false
  const failed = fence.serialize(async () => {
    throw new Error('output failed')
  })
  const stale = fence.serialize(() =>
    fence.runLatest(old, async () => {
      staleRan = true
    })
  )
  fence.next()
  await assert.rejects(failed, /output failed/)
  assert.deepEqual(await stale, { applied: false })
  assert.equal(staleRan, false)
  assert.equal(await fence.serialize(async () => 'next load'), 'next load')
})

test('native queue revision fence rejects a stale asynchronous queue request', () => {
  const fence = new NativeQueueRevisionFence()
  const first = fence.next()
  const second = fence.next()

  assert.equal(fence.isCurrent(first), false)
  assert.equal(fence.isCurrent(second), true)
  assert.equal(fence.current, second)
})

test('a stale native queue operation cannot commit after a newer revision is queued', async () => {
  const fence = new NativeQueueRevisionFence()
  const staleRevision = fence.next()
  let release: (() => void) | undefined
  const pending = fence.runLatest(
    staleRevision,
    () =>
      new Promise<string>((resolve) => {
        release = () => resolve('stale queue loaded')
      })
  )

  const latestRevision = fence.next()
  release?.()

  assert.deepEqual(await pending, { applied: false })
  assert.deepEqual(await fence.runLatest(latestRevision, async () => 'latest queue loaded'), {
    applied: true,
    value: 'latest queue loaded'
  })
})

test('out-of-order native queue sync never runs stale loadQueue or setPlayMode', async () => {
  const fence = new NativeQueueRevisionFence()
  const calls: string[] = []
  let releaseOldPrepare: (() => void) | undefined
  const oldRevision = fence.next()
  const oldSync = synchronizeLatestNativeQueue(fence, oldRevision, {
    prepare: () =>
      new Promise<{ id: string }>((resolve) => {
        releaseOldPrepare = () => resolve({ id: 'old' })
      }),
    loadQueue: async (prepared) => {
      calls.push(`load:${prepared.id}`)
    },
    setPlayMode: async () => {
      calls.push('mode:old')
    }
  })

  await new Promise<void>((resolve) => queueMicrotask(resolve))
  const newestRevision = fence.next()
  const newestSync = synchronizeLatestNativeQueue(fence, newestRevision, {
    prepare: async () => ({ id: 'new' }),
    loadQueue: async (prepared) => {
      calls.push(`load:${prepared.id}`)
    },
    setPlayMode: async () => {
      calls.push('mode:new')
    }
  })

  releaseOldPrepare?.()
  assert.deepEqual(await oldSync, { applied: false, prepared: null })
  assert.deepEqual(await newestSync, { applied: true, prepared: { id: 'new' } })
  assert.deepEqual(calls, ['load:new', 'mode:new'])
})

test('a rejected loadQueue reports the reason instead of rejecting the sync', async () => {
  const fence = new NativeQueueRevisionFence()
  const revision = fence.next()
  const failure = new Error('Audio queue is invalid or too large')
  let setPlayModeCalled = false

  // Resynchronization is fire-and-forget, so a rejection here would surface only
  // as an unhandled rejection while the caller still believed it was delegated.
  const result = await synchronizeLatestNativeQueue(fence, revision, {
    prepare: async () => ({ id: 'oversized' }),
    loadQueue: async () => {
      throw failure
    },
    setPlayMode: async () => {
      setPlayModeCalled = true
    }
  })

  assert.deepEqual(result, { applied: true, prepared: null, loadQueueError: failure })
  assert.equal(setPlayModeCalled, false, 'a queue that never loaded must not commit a play mode')
  assert.equal(fence.isCurrent(revision), true, 'the failure does not invalidate the revision')
})
