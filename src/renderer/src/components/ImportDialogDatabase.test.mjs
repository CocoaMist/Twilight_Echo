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
    settingsWrites = [],
    settings = ref({
      libraryFolders: [],
      musicIdentification: { newImports: false, history: false, sources: [] }
    }),
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
    settings,
    automaticMetadata: ref(false),
    metadataSources: ref([]),
    updateSettings: async (patch) => {
      settingsWrites.push(JSON.parse(JSON.stringify(patch)))
      Object.assign(settings.value, patch)
    },
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
  return { context, calls, settingsWrites }
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
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(f.calls, [['scan', { directories: ['D:/Music/a'], reason: 'import' }]])
  assert.deepEqual(f.settingsWrites, [
    { musicIdentification: { newImports: false, history: false, sources: [] } }
  ])
  f.context.close()
  assert.deepEqual(
    f.calls.at(-1),
    ['emit', 'close'],
    'durable scanning must be allowed in the background'
  )
  release({ state: 'cancelled' })
  await pending
  assert.equal(f.context.databaseRequestPending.value, false)
  assert.deepEqual(f.settingsWrites.at(-1), { libraryFolders: ['D:/Music/a'] })
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
})

test('the dialog has no renderer scanner, whole-library writer or storage-mode fallback', () => {
  assert.doesNotMatch(
    source,
    /scanMusicFiles|saveLibrary|refreshLibraryIndex|addTracks|addFolder|getStorageMode|onScanProgress/
  )
})
