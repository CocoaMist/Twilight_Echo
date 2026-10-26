import { createApp, h, nextTick, ref } from 'vue'
import ImportDialog from './ImportDialog.vue'
import '../assets/base.css'
import '../assets/primeicons.css'

const expect = (value, message) => {
  if (!value) throw new Error(message)
}
const settle = async () => {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 60))
}
const button = (text) =>
  [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === text)
const click = async (item) => {
  expect(item && !item.disabled, 'missing or disabled control')
  item.click()
  await settle()
}
const copy = (value) => JSON.parse(JSON.stringify(value))

window.runImportDatabaseTests = async () => {
  const shown = ref(true),
    calls = [],
    scans = [],
    roots = ['D:/Music/a', 'D:/Music/b']
  let failScan = false,
    finishScan,
    app
  const status = ref({
    jobId: null,
    mode: null,
    state: 'idle',
    current: 0,
    total: 0,
    parsedFileCount: 0,
    skippedUnchanged: 0,
    error: ''
  })
  const publish = (state) => {
    status.value = {
      ...status.value,
      jobId: 'durable-import',
      mode: 'watch',
      state,
      databaseProgress: {
        jobId: 'durable-import',
        state,
        phase: state === 'running' ? 'parsing' : 'idle',
        checkedFiles: 1000,
        parsedFiles: 123,
        committedFiles: 800,
        failedFiles: 2,
        trackCount: 300005,
        revision: 8
      }
    }
  }
  const unexpected = () => {
    throw new Error('SQLite used the legacy snapshot scanner/writer')
  }
  window.auditMusic = {
    scannedFolders: ref([...roots]),
    isScanning: ref(false),
    libraryScanStatus: status,
    excludedTracks: ref([]),
    restoreExcludedTracks: unexpected,
    addFolder: unexpected,
    addTracks: unexpected,
    saveLibrary: unexpected,
    refreshLibraryIndex: unexpected,
    removeFolder: unexpected,
    scanLibraryDirectories: (request) => {
      scans.push(copy(request))
      if (failScan) return Promise.reject(new Error('扫描进程中断'))
      publish('running')
      return new Promise((resolve) => {
        finishScan = resolve
      })
    },
    pauseLibraryScan: async () => {
      calls.push('pause')
      publish('paused')
      return true
    },
    resumeLibraryScan: async () => {
      calls.push('resume')
      publish('running')
      return true
    },
    cancelLibraryScan: async () => {
      calls.push('cancel')
      publish('cancelled')
      finishScan?.({ state: 'cancelled' })
      return true
    }
  }
  window.auditSettings = {
    settings: ref({ libraryFolders: [...roots] }),
    loaded: ref(true),
    removeLibraryFolder: async (path) => {
      calls.push('remove:' + path)
      window.auditSettings.settings.value.libraryFolders =
        window.auditSettings.settings.value.libraryFolders.filter((item) => item !== path)
    },
    updateSettings: async () => {}
  }
  window.api = {
    dialog: { openFolder: async () => null }
  }
  const mount = async () => {
    app?.unmount()
    shown.value = true
    app = createApp({
      render: () =>
        h(ImportDialog, {
          show: shown.value,
          onClose: () => {
            shown.value = false
          }
        })
    })
    app.mount('#app')
    await settle()
  }
  await mount()
  expect(
    document.querySelectorAll('.folder-item input').length === 2,
    'settings roots not rendered'
  )
  document.querySelectorAll('.folder-item input')[1].click()
  await click(button('检查并导入所选文件夹'))
  expect(
    scans.length === 1 &&
      scans[0].reason === 'import' &&
      scans[0].directories.join('|') === roots[0],
    'import used wrong scope'
  )
  expect(
    !document.querySelector('progress').hasAttribute('value'),
    'enumeration displayed a fabricated percentage'
  )
  const counters = document.querySelector('.database-counters').textContent
  for (const value of ['检查文件', '解析元数据', '已入库曲目', '失败文件', '300,005'])
    expect(counters.includes(value), 'missing committed counter: ' + value)
  await click(button('暂停'))
  expect(status.value.state === 'paused' && button('继续扫描'), 'pause did not offer resume')
  await click(button('继续扫描'))
  expect(status.value.state === 'running', 'resume not reflected')
  await click(button('取消扫描'))
  expect(
    button('继续扫描') && !button('检查并导入所选文件夹').disabled,
    'cancel removed continuation/new import'
  )
  expect(
    document.querySelector('.progress-section').textContent.includes('已入库曲目保留'),
    'cancel hides committed data semantics'
  )
  await click(document.querySelector('[aria-label="关闭导入窗口"]'))
  shown.value = true
  await settle()
  expect(scans.length === 1 && button('继续扫描'), 'reopening restarted the cancelled scan')
  await click(button('继续扫描'))
  await click(document.querySelector('[aria-label="关闭导入窗口"]'))
  expect(
    !shown.value && status.value.state === 'running',
    'closing cancelled durable background work'
  )
  shown.value = true
  await settle()
  publish('completed')
  await settle()
  failScan = true
  await click(button('检查并导入所选文件夹'))
  expect(
    document.querySelector('[role="alert"]').textContent.includes('扫描进程中断'),
    'admission/worker failure hidden'
  )
  expect(scans.length === 2, 'failed write automatically replayed')
  failScan = false
  await click(button('检查并导入所选文件夹'))
  expect(
    scans.length === 3 && !document.querySelector('[role="alert"]'),
    'explicit retry did not start'
  )
  await click(button('取消扫描'))

  publish('completed')
  window.auditSettings.loaded.value = false
  await mount()
  expect(button('检查并导入所选文件夹').disabled, 'import started before Core settings were ready')
  window.auditSettings.loaded.value = true
  await settle()
  await click(document.querySelector('[aria-label="移除文件夹 D:/Music/b"]'))
  expect(
    calls.includes('remove:D:/Music/b') && document.querySelectorAll('.folder-item').length === 1,
    'folder removal did not use Core settings authority'
  )

  publish('paused')
  await mount()
  const dialog = document.querySelector('[role="dialog"]').getBoundingClientRect()
  expect(
    dialog.top >= 20 && dialog.bottom <= innerHeight - 20,
    'dialog controls overflow the screen'
  )
  expect(
    calls.filter((item) => item === 'resume').length === 2,
    'shared controls were not invoked exactly'
  )
  return {
    scopedRequests: scans.length,
    controls: calls.filter((item) => ['pause', 'resume', 'cancel'].includes(item)),
    rendererScans: calls.filter((item) => item.startsWith('legacy')).length
  }
}
