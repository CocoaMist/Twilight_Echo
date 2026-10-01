import assert from 'node:assert/strict'
import test from 'node:test'

import { useAppNoticeStore } from './useAppNoticeStore.ts'

const { notices, pushNotice, dismissNotice, releaseNoticeDedupe, clearNotices } =
  useAppNoticeStore()

test('four visible notices retain a separate history and important failures persist', () => {
  clearNotices()
  for (let index = 0; index < 6; index++) pushNotice({ message: `通知 ${index}`, kind: 'error' })
  assert.equal(notices.value.length, 4)
  assert.equal(useAppNoticeStore().noticeHistory.value.length, 6)
  assert.equal(
    notices.value.every((notice) => notice.sticky),
    true
  )
  dismissNotice(notices.value[0].id)
  assert.equal(useAppNoticeStore().noticeHistory.value.length, 6)
  clearNotices()
})

test('hover and keyboard pauses survive repeated updates and resume only after both leave', (t) => {
  clearNotices()
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const store = useAppNoticeStore()
  const id = pushNotice({ message: '更新完成', dedupeKey: 'update' })
  t.mock.timers.tick(1000)
  store.pauseNotice(id, 'pointer')
  store.pauseNotice(id, 'focus')
  pushNotice({ message: '更新完成', dedupeKey: 'update' })
  t.mock.timers.tick(20_000)
  assert.equal(notices.value.length, 1)
  store.resumeNotice(id, 'pointer')
  t.mock.timers.tick(20_000)
  assert.equal(notices.value.length, 1)
  store.resumeNotice(id, 'focus')
  t.mock.timers.tick(7001)
  assert.equal(notices.value.length, 0)
  clearNotices()
})

const DEDUPE_KEY = 'audio-engine-recovery'
const CRASH_MESSAGE = '音频服务无法启动：未加载 twilight_audio_node.node。'

function messages(): string[] {
  return notices.value.map((notice) => notice.message)
}

test('a dismissed deduped notice stays dismissed when the same message repeats', () => {
  clearNotices()

  const first = pushNotice({ message: CRASH_MESSAGE, sticky: true, dedupeKey: DEDUPE_KEY })
  assert.notEqual(first, 0)
  dismissNotice(first)
  assert.deepEqual(messages(), [])

  // The audio service crash reason arrives again on the very next device poll.
  // Re-pushing it must not out-click the user.
  assert.equal(pushNotice({ message: CRASH_MESSAGE, sticky: true, dedupeKey: DEDUPE_KEY }), 0)
  assert.equal(pushNotice({ message: CRASH_MESSAGE, sticky: true, dedupeKey: DEDUPE_KEY }), 0)
  assert.deepEqual(messages(), [])

  clearNotices()
})

test('a changed message is new information and releases the dismissal', () => {
  clearNotices()

  dismissNotice(pushNotice({ message: CRASH_MESSAGE, sticky: true, dedupeKey: DEDUPE_KEY }))
  assert.deepEqual(messages(), [])

  const recovered = pushNotice({ message: '音频服务已恢复。', dedupeKey: DEDUPE_KEY })
  assert.notEqual(recovered, 0)
  assert.deepEqual(messages(), ['音频服务已恢复。'])

  clearNotices()
})

test('repeat pushes on one dedupe key update in place instead of stacking a new id', () => {
  clearNotices()

  const id = pushNotice({
    message: CRASH_MESSAGE,
    kind: 'error',
    sticky: true,
    dedupeKey: DEDUPE_KEY
  })
  const same = pushNotice({
    message: CRASH_MESSAGE,
    kind: 'error',
    sticky: true,
    dedupeKey: DEDUPE_KEY
  })
  assert.equal(same, id)
  assert.equal(notices.value.length, 1)

  const updated = pushNotice({
    message: '音频服务已恢复，播放已停止，可手动继续。',
    kind: 'success',
    dedupeKey: DEDUPE_KEY
  })
  assert.equal(updated, id, 'the toast keeps its identity so it is not visually replaced')
  assert.equal(notices.value.length, 1)
  assert.equal(notices.value[0].kind, 'success')
  assert.equal(notices.value[0].sticky, false)

  clearNotices()
})

test('releaseNoticeDedupe lets an unchanged message notify again', () => {
  clearNotices()

  dismissNotice(pushNotice({ message: CRASH_MESSAGE, sticky: true, dedupeKey: DEDUPE_KEY }))
  assert.equal(pushNotice({ message: CRASH_MESSAGE, sticky: true, dedupeKey: DEDUPE_KEY }), 0)

  // A user-driven retry must be able to report the identical failure again.
  releaseNoticeDedupe(DEDUPE_KEY)
  assert.notEqual(pushNotice({ message: CRASH_MESSAGE, sticky: true, dedupeKey: DEDUPE_KEY }), 0)
  assert.deepEqual(messages(), [CRASH_MESSAGE])

  clearNotices()
})

test('notices without a dedupe key still stack and dismiss independently', () => {
  clearNotices()

  const first = pushNotice({ message: '第一条', sticky: true })
  const second = pushNotice({ message: '第一条', sticky: true })
  assert.notEqual(first, second)
  assert.deepEqual(messages(), ['第一条', '第一条'])

  dismissNotice(first)
  assert.deepEqual(messages(), ['第一条'])
  assert.notEqual(pushNotice({ message: '第一条', sticky: true }), 0)
  assert.equal(notices.value.length, 2)

  clearNotices()
})

test('an in-place update reschedules auto dismissal against the new duration', (t) => {
  clearNotices()
  t.mock.timers.enable({ apis: ['setTimeout'] })

  const id = pushNotice({ message: CRASH_MESSAGE, sticky: true, dedupeKey: DEDUPE_KEY })
  t.mock.timers.tick(60_000)
  assert.deepEqual(messages(), [CRASH_MESSAGE], 'a sticky notice never times out')

  assert.equal(
    pushNotice({ message: '音频服务已恢复。', durationMs: 8000, dedupeKey: DEDUPE_KEY }),
    id
  )
  t.mock.timers.tick(7999)
  assert.deepEqual(messages(), ['音频服务已恢复。'])
  t.mock.timers.tick(2)
  assert.deepEqual(messages(), [])

  clearNotices()
})
