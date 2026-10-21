import assert from 'node:assert/strict'
import test from 'node:test'
import { ref } from 'vue'
import { startPlaylistPersistenceNotifications } from './playlistPersistenceNotifications.ts'
import { useAppNoticeStore } from '../stores/useAppNoticeStore.ts'
import type { PlaylistPersistenceStatus } from '../stores/playlistPersistence.ts'

test('global recovery requires confirmation, keeps cancelled/failed actions available, and clears a resolved conflict', async (t) => {
  const notices = useAppNoticeStore()
  notices.clearNotices()
  const status = ref<PlaylistPersistenceStatus>({
    state: 'idle',
    dirty: false,
    failureCount: 0,
    lastError: null
  })
  let confirmed = false,
    fail = true,
    reads = 0,
    confirmation = ''
  const stop = startPlaylistPersistenceNotifications(
    status,
    async () => {
      reads++
      if (fail) throw new Error('read unavailable')
      status.value = { state: 'idle', dirty: false, failureCount: 0, lastError: null }
    },
    (message) => {
      confirmation = message
      return confirmed
    }
  )
  t.after(() => {
    stop()
    notices.clearNotices()
  })
  status.value = { state: 'error', dirty: true, failureCount: 1, lastError: 'disk' }
  assert.equal(
    notices.notices.value.length,
    0,
    'ordinary I/O still retries without discard guidance'
  )
  status.value = { ...status.value, lastError: 'refreshed', canRetry: false }
  const id = notices.notices.value[0].id
  assert.equal(notices.notices.value[0].action?.label, '重新读取歌单')
  assert.equal(reads, 0)
  await notices.runNoticeAction(id)
  assert.equal(reads, 0)
  assert.match(confirmation, /所有尚未保存的歌单修改/)
  assert.ok(notices.notices.value[0].action, 'cancel preserves recovery action')
  confirmed = true
  await notices.runNoticeAction(id)
  assert.equal(reads, 1)
  assert.match(notices.notices.value[0].message, /read unavailable/)
  assert.ok(notices.notices.value[0].action, 'failed reads preserve recovery action')
  fail = false
  await notices.runNoticeAction(id)
  assert.equal(reads, 2)
  assert.equal(notices.notices.value.length, 0)
  assert.equal(notices.noticeHistory.value.find((notice) => notice.id === id)?.action, undefined)
})

test('recovery is single-flight and stale notice actions cannot discard after their owner stops', async (t) => {
  const notices = useAppNoticeStore()
  notices.clearNotices()
  const status = ref<PlaylistPersistenceStatus>({
    state: 'error',
    dirty: true,
    failureCount: 1,
    lastError: 'refreshed',
    canRetry: false
  })
  let reads = 0,
    release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const stop = startPlaylistPersistenceNotifications(
    status,
    async () => {
      reads++
      await gate
    },
    () => true
  )
  t.after(() => {
    stop()
    notices.clearNotices()
  })
  const notice = notices.notices.value[0],
    action = notice.action!
  const first = notices.runNoticeAction(notice.id)
  assert.equal(await notices.runNoticeAction(notice.id), false)
  await action.run()
  assert.equal(reads, 1)
  release()
  await first
  stop()
  await action.run()
  assert.equal(reads, 1)
})
