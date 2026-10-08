import assert from 'node:assert/strict'
import test from 'node:test'
import { createAppUpdateStore } from './useAppUpdateStore.ts'
import { startAppUpdateNotifications } from '../app/useAppUpdateNotifications.ts'
import { useAppNoticeStore } from './useAppNoticeStore.ts'
import {
  createInitialAppUpdateSnapshot,
  type AppUpdateClient,
  type AppUpdateSnapshot,
  type AppUpdateDownloadResult
} from '../../../shared/appUpdate.ts'

function fixture() {
  let snapshot = createInitialAppUpdateSnapshot()
  const listeners = new Set<(s: AppUpdateSnapshot) => void>()
  let downloads = 0,
    cancellations = 0
  let finishDownload: ((result: AppUpdateDownloadResult) => void) | null = null
  const api: AppUpdateClient = {
    getUpdateState: async () => structuredClone(snapshot),
    onUpdateState: (cb) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    checkForUpdates: async () => ({ hasUpdate: false, currentVersion: '1.0.0' }),
    downloadUpdate: () => {
      downloads++
      return new Promise((resolve) => {
        finishDownload = resolve
      })
    },
    cancelUpdateDownload: async () => {
      cancellations++
      finishDownload?.({ ok: false, error: 'cancelled', cancelled: true })
      return true
    },
    installUpdate: async () => ({ ok: true }),
    setUpdatePreferences: async () => snapshot,
    dismissUpdate: async () => snapshot
  }
  const store = createAppUpdateStore(() => api)
  return {
    store,
    api,
    listeners,
    downloads: () => downloads,
    cancellations: () => cancellations,
    publish: (next: AppUpdateSnapshot) => {
      snapshot = structuredClone(next)
      for (const cb of listeners) cb(structuredClone(snapshot))
    }
  }
}
const tick = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

test('a slow initial query cannot overwrite newer download progress', async () => {
  const f = fixture()
  let deliver!: (state: AppUpdateSnapshot) => void
  f.api.getUpdateState = () =>
    new Promise((resolve) => {
      deliver = resolve
    })
  const stop = f.store.connect()
  f.publish({
    ...createInitialAppUpdateSnapshot(),
    revision: 3,
    progress: { phase: 'downloading', percent: 50, receivedBytes: 50, totalBytes: 100 }
  })
  deliver({ ...createInitialAppUpdateSnapshot(), revision: 1 })
  await tick()
  assert.equal(f.store.state.value.progress.percent, 50)
  stop()
  assert.equal(f.listeners.size, 0)
})

test('opening and closing update views shares one listener and restores ready state', async () => {
  const f = fixture()
  const root = f.store.connect(),
    page = f.store.connect()
  assert.equal(f.listeners.size, 1)
  page()
  page()
  f.publish({
    ...createInitialAppUpdateSnapshot(),
    revision: 4,
    readyVersion: '2.0.0',
    progress: { phase: 'ready', percent: 100, receivedBytes: 10, totalBytes: 10 }
  })
  const reopened = f.store.connect()
  assert.equal(f.store.state.value.readyVersion, '2.0.0')
  root()
  assert.equal(f.listeners.size, 1)
  reopened()
  assert.equal(f.listeners.size, 0)
  const reload = f.store.connect()
  await tick()
  assert.equal(f.store.state.value.progress.phase, 'ready')
  reload()
})

test('duplicate clicks are gated but cancellation works while download invoke is pending', async () => {
  const f = fixture(),
    stop = f.store.connect()
  await tick()
  const pending = f.store.download()
  await f.store.download()
  assert.equal(f.downloads(), 1)
  await f.store.cancel()
  await pending
  assert.equal(f.cancellations(), 1)
  assert.equal(f.store.busy.value, false)
  assert.equal(f.store.error.value, '')
  stop()
})

test('failed IPC actions remain retryable and release their busy state', async () => {
  const f = fixture()
  f.api.checkForUpdates = async () => {
    throw new Error('disconnected')
  }
  await f.store.check()
  assert.equal(f.store.error.value, '暂时无法连接更新服务，请稍后重试。')
  assert.equal(f.store.busy.value, false)
  f.api.checkForUpdates = async () => ({ hasUpdate: false, currentVersion: '1.0.0' })
  await f.store.check()
  assert.equal(f.store.error.value, '')
})

test('an older main process gets restart guidance and preserves a successful check', async () => {
  const f = fixture()
  f.api.getUpdateState = async () => {
    throw new Error(
      "Error invoking remote method 'app:getUpdateState': Error: No handler registered for 'app:getUpdateState'"
    )
  }
  const stop = f.store.connect()
  await tick()
  assert.match(f.store.connectionError.value, /完全退出并重新启动/)
  assert.doesNotMatch(f.store.connectionError.value, /No handler|app:getUpdateState/)
  await f.store.check()
  assert.equal(f.store.state.value.check?.hasUpdate, false)
  assert.equal(f.store.state.value.check?.currentVersion, '1.0.0')
  assert.equal(f.store.error.value, '')
  assert.equal(f.store.busy.value, false)
  f.api.getUpdateState = async () => ({ ...f.store.state.value, revision: 1 })
  await f.store.check()
  assert.equal(f.store.connectionError.value, '')
  stop()
})

test('failed actions keep their explanation when snapshot reconciliation also fails', async () => {
  const f = fixture()
  f.api.installUpdate = async () => ({ ok: false, error: '无法保存播放状态，请重试' })
  f.api.getUpdateState = async () => {
    throw new Error('disconnected')
  }
  await f.store.install()
  assert.equal(f.store.error.value, '无法保存播放状态，请重试')
  assert.equal(f.store.busy.value, false)
})

test('a same-version reminder after snooze reappears without leaking notification listeners', async () => {
  const f = fixture()
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { api: { app: f.api } }
  })
  const notices = useAppNoticeStore()
  notices.clearNotices()
  const stop = startAppUpdateNotifications(() => {})
  try {
    await tick()
    const initial = createInitialAppUpdateSnapshot()
    f.publish({
      ...initial,
      revision: 10,
      notice: { id: 'first', kind: 'available', version: '2.0.0' }
    })
    await tick()
    assert.equal(notices.unreadCount.value, 1)
    assert.equal(
      notices.notices.value.length,
      0,
      'available updates stay in the notification center'
    )
    notices.markHistoryRead()
    f.publish({ ...initial, revision: 11, notice: null })
    await tick()
    assert.equal(notices.unreadCount.value, 0)
    f.publish({
      ...initial,
      revision: 12,
      notice: { id: 'tomorrow', kind: 'available', version: '2.0.0' }
    })
    await tick()
    assert.equal(notices.unreadCount.value, 1)
    assert.equal(
      notices.noticeHistory.value.length,
      1,
      'a renewed reminder updates its existing row'
    )
  } finally {
    stop()
    assert.equal(f.listeners.size, 0)
    notices.clearNotices()
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
