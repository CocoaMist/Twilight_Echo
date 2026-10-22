import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'
import { ref } from 'vue'
import { isTrackUnderLibraryRoot, normalizeLibraryPath } from '../stores/library/musicStoreData.ts'

// Exercise the production event handlers. Browser layout/focus/control clicks
// remain separate Electron acceptance, not implied by these VM tests.
const source = stripTypeScriptTypes(
  readFileSync(new URL('./ImportDialog.vue', import.meta.url), 'utf8')
    .split('<script setup lang="ts">')[1]
    .split('</script>')[0]
)
function fixture(mode = 'sqlite') {
  const calls = [],
    closeDisabled = ref(false)
  const unexpected = () => {
    throw new Error('legacy whole-library mutation')
  }
  const context = vm.createContext({
    Error,
    console,
    setTimeout,
    busy: ref(false),
    closeDisabled,
    databaseMode: ref(mode === 'sqlite'),
    databaseRequestPending: ref(false),
    controlPending: ref(false),
    scanError: ref(''),
    isScanning: ref(false),
    scanStatus: ref('idle'),
    progress: ref({}),
    scannedTrackCount: ref(0),
    selectedFolders: ref(new Set(['D:/Music/a'])),
    newlyAddedFolders: ref(['D:/Music/a']),
    choosingFolder: ref(false),
    scannedFolders: ref(['D:/Music/a', 'D:/Music/b']),
    settingsLoaded: ref(true),
    removeLibraryFolder: async (path) => calls.push(['settings-remove', path]),
    isTrackUnderLibraryRoot,
    normalizeLibraryPath,
    excludedTracks: ref([]),
    restoreExcludedTracks: unexpected,
    addFolder: unexpected,
    addTracks: unexpected,
    refreshLibraryIndex: unexpected,
    saveLibrary: unexpected,
    emit: (...args) => calls.push(['emit', ...args]),
    musicStore: {
      scanLibraryDirectories: async (request) => {
        calls.push(['scan', JSON.parse(JSON.stringify(request))])
        return { state: 'completed' }
      },
      removeFolder: unexpected,
      pauseLibraryScan: async () => {
        calls.push(['pause'])
        return true
      },
      resumeLibraryScan: async () => {
        calls.push(['resume'])
        return true
      },
      cancelLibraryScan: async () => {
        calls.push(['cancel'])
        return true
      }
    },
    window: { api: { fs: { scanMusicFiles: unexpected } } }
  })
  for (const name of ['startScan', 'handleRemoveFolder', 'controlScan', 'close']) {
    const start = source.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm')),
      end = source.indexOf('\n}', start)
    assert.ok(start >= 0 && end > start)
    vm.runInContext(source.slice(start, end + 2), context)
  }
  return { context, calls }
}

test('SQLite import submits selected directories to the owner without an array scan/save or global legacy busy flag', async () => {
  const f = fixture()
  let release
  f.context.musicStore.scanLibraryDirectories = (request) => {
    f.calls.push(['scan', JSON.parse(JSON.stringify(request))])
    return new Promise((resolve) => {
      release = resolve
    })
  }
  const pending = f.context.startScan()
  assert.equal(f.context.databaseRequestPending.value, true)
  assert.equal(f.context.isScanning.value, false)
  assert.deepEqual(f.calls, [['scan', { directories: ['D:/Music/a'], reason: 'import' }]])
  f.context.close()
  assert.deepEqual(
    f.calls.at(-1),
    ['emit', 'close'],
    'durable scanning must be allowed in the background'
  )
  release({ state: 'cancelled' })
  await pending
  assert.equal(f.context.databaseRequestPending.value, false)
  assert.equal(
    f.context.scannedTrackCount.value,
    0,
    'do not label the global DB count as newly imported'
  )
})

test('SQLite import failure preserves partial results and allows explicit retry, never replaying a write', async () => {
  const f = fixture()
  let attempts = 0
  f.context.musicStore.scanLibraryDirectories = async () => {
    attempts++
    throw new Error('scanner interrupted')
  }
  await f.context.startScan()
  assert.equal(attempts, 1)
  assert.equal(f.context.databaseRequestPending.value, false)
  assert.match(f.context.scanError.value, /scanner interrupted.*已提交曲目保留/)
  f.context.musicStore.scanLibraryDirectories = async () => {
    attempts++
    return { state: 'completed' }
  }
  await f.context.startScan()
  assert.equal(attempts, 2)
  assert.equal(f.context.scanError.value, '')
})

test('SQLite root removal only revokes settings; pause/resume/cancel use the shared durable owner', async () => {
  const f = fixture()
  await f.context.handleRemoveFolder('D:/Music/a')
  assert.deepEqual(f.calls, [['settings-remove', 'D:/Music/a']])
  assert.equal(f.context.selectedFolders.value.size, 0)
  for (const command of ['pause', 'resume', 'cancel']) await f.context.controlScan(command)
  assert.deepEqual(f.calls.slice(1), [['pause'], ['resume'], ['cancel']])
  f.context.musicStore.resumeLibraryScan = async () => false
  await f.context.controlScan('resume')
  assert.match(f.context.scanError.value, /扫描状态已变化/)
  assert.equal(f.context.controlPending.value, false)
  f.context.settingsLoaded.value = false
  await f.context.handleRemoveFolder('D:/Music/b')
  assert.match(f.context.scanError.value, /设置尚未加载/)
  assert.equal(f.calls.filter((call) => call[0] === 'settings-remove').length, 1)
})

test('JSON importer keeps its whole-result API, exclusions, partial save and close contracts', async () => {
  const f = fixture('json')
  Object.assign(f.context, {
    excludedTracks: ref([
      { filePath: 'D:/Music/a/removed.wav' },
      { filePath: 'D:/Music/b/keep.wav' }
    ]),
    restoreExcludedTracks: async (paths) => f.calls.push(['restore', ...paths]),
    addFolder: (path) => f.calls.push(['folder', path]),
    addTracks: async (tracks) => f.calls.push(['tracks', ...tracks.map((track) => track.id)]),
    refreshLibraryIndex: () => f.calls.push(['rebuild']),
    saveLibrary: async () => f.calls.push(['save'])
  })
  f.context.window.api.fs.scanMusicFiles = async (path) => {
    f.calls.push(['legacy-scan', path])
    return [{ id: 'legacy' }]
  }
  await f.context.startScan()
  assert.deepEqual(f.calls, [
    ['restore', 'D:/Music/a/removed.wav'],
    ['legacy-scan', 'D:/Music/a'],
    ['folder', 'D:/Music/a'],
    ['tracks', 'legacy'],
    ['rebuild'],
    ['save'],
    ['emit', 'close']
  ])
  f.calls.length = 0
  f.context.selectedFolders.value.add('D:/Music/b')
  f.context.window.api.fs.scanMusicFiles = async (path) => {
    if (path.endsWith('/b')) throw new Error('offline')
    return [{ id: 'saved-part' }]
  }
  await f.context.startScan()
  assert.match(f.context.scanError.value, /offline/)
  assert.equal(f.context.isScanning.value, false)
  assert.deepEqual(f.calls.slice(-2), [['rebuild'], ['save']])
})
