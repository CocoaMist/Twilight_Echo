import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProviderDownloadTaskSnapshot } from '../../../shared/providerDownloads.ts'
import { useDownloadTasks } from './useDownloadTasks.ts'
import { useAppNoticeStore } from './useAppNoticeStore.ts'

test('shared download subscription records outcomes quietly and ignores stale list and released events', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let changed!: (tasks: ProviderDownloadTaskSnapshot[]) => void
  let resolveList!: (tasks: ProviderDownloadTaskSnapshot[]) => void
  let subscriptions = 0
  let disconnected = 0
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        providerDownloads: {
          list: () =>
            new Promise<ProviderDownloadTaskSnapshot[]>((resolve) => {
              resolveList = resolve
            }),
          onChanged: (callback: typeof changed) => {
            changed = callback
            subscriptions++
            return () => {
              disconnected++
            }
          }
        }
      }
    }
  })
  const notices = useAppNoticeStore(),
    downloads = useDownloadTasks()
  notices.clearNotices()
  const first = downloads.connect(),
    second = downloads.connect()
  try {
    assert.equal(subscriptions, 1)
    const task = (
      status: ProviderDownloadTaskSnapshot['status']
    ): ProviderDownloadTaskSnapshot => ({
      id: 'test-download',
      providerId: 'fixture',
      providerJobId: 'job',
      track: { id: 'track', title: '旋律', artist: '艺人' },
      requestedQuality: 'aac',
      actualQuality: null,
      status,
      progress: status === 'completed' ? 1 : 0.2,
      queuePosition: null,
      targetPath: null,
      fileSize: null,
      error: status === 'failed' ? '连接中断' : null,
      createdAt: '2026-10-06',
      updatedAt: '2026-10-06'
    })
    changed([task('downloading')])
    changed([task('completed')])
    changed([task('completed')])
    assert.equal(notices.noticeHistory.value.length, 1)
    assert.match(notices.noticeHistory.value[0].message, /下载完成/)
    assert.equal(notices.notices.value.length, 0)
    resolveList([task('downloading')])
    await Promise.resolve()
    assert.equal(downloads.tasks.value[0].status, 'completed')
    changed([task('downloading')])
    changed([task('failed')])
    assert.equal(notices.noticeHistory.value.length, 1)
    assert.match(notices.noticeHistory.value[0].message, /下载失败.*连接中断/)
    assert.equal(notices.notices.value.length, 0)
    changed([task('failed'), { ...task('completed'), id: 'instant-result' }])
    assert.equal(
      notices.noticeHistory.value.length,
      2,
      'an instant completion event must not be lost'
    )
    first()
    assert.equal(disconnected, 0)
    second()
    assert.equal(disconnected, 1)
    changed([task('completed')])
    assert.equal(downloads.tasks.value[0].status, 'failed')
  } finally {
    first()
    second()
    notices.clearNotices()
    if (original) Object.defineProperty(globalThis, 'window', original)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
