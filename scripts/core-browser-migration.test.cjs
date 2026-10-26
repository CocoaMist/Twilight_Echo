'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { mkdtemp, readFile, rm, access } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve, dirname, basename } = require('node:path')
const { promisify } = require('node:util')
const { createRequire } = require('node:module')
const test = require('node:test')
const { buildSync } = createRequire(require.resolve('vite/package.json'))('esbuild')

test(
  'real Chromium history migration resumes after a lost stage reply and leaves browser originals intact',
  { timeout: 90_000 },
  async () => {
    const root = resolve(__dirname, '..')
    await access(join(root, 'out/main/musicCore.js'))
    const directory = await mkdtemp(join(tmpdir(), 'twilight-core-browser-migration-'))
    try {
      for (const [file, contents, platform] of [
        ['runner.cjs', main, 'node'],
        ['preload.cjs', preload, 'node'],
        ['migration.js', renderer, 'browser']
      ]) {
        buildSync({
          stdin: { contents, resolveDir: root },
          bundle: true,
          platform,
          format: file.endsWith('.js') ? 'iife' : 'cjs',
          external: ['electron'],
          define: {
            'import.meta.url': JSON.stringify(
              require('node:url').pathToFileURL(join(root, 'package.json')).href
            )
          },
          outfile: join(directory, file)
        })
      }
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      await promisify(execFile)(require('electron'), [join(directory, 'runner.cjs'), root], {
        env,
        windowsHide: true,
        timeout: 80_000,
        maxBuffer: 2 * 1024 * 1024
      })
      const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'))
      assert.deepEqual(result, {
        tracks: 201,
        days: 2,
        versions: 3,
        retryValidated: true,
        browserIntact: true,
        windowsAfterImport: 0,
        servicesAfterShutdown: 0
      })
    } finally {
      assert.equal(dirname(directory), resolve(tmpdir()))
      assert.ok(basename(directory).startsWith('twilight-core-browser-migration-'))
      await rm(directory, { recursive: true, force: true })
    }
  }
)

const preload = String.raw`
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('migrationFixture', { request: (name, payload) => ipcRenderer.invoke('fixture:core-migration', name, payload) })
`

const main = String.raw`
const { app, BrowserWindow, ipcMain, utilityProcess, MessageChannelMain } = require('electron')
const { CoreSupervisor } = require('./src/main/coreProcess/supervisor.ts')
const { createDspCorePlatform } = require('./src/main/dsp/corePlatform.ts')
const { CoreStateDatabase } = require('./src/main/library/coreStateDatabase.ts')
const { writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')
const { once } = require('node:events')
const assert = require('node:assert/strict')
const root = process.argv[2], profile = join(__dirname, 'profile')
mkdirSync(profile, { recursive: true }); app.setPath('userData', profile); app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
const alive = new Set()
let window, supervisor, serial = 0, droppedReply = false
async function run() {
  await app.whenReady()
  const library = join(profile, 'music-library.json')
  writeFileSync(library, JSON.stringify({ version: 2, revision: 0, folders: [], exclusions: [], tracks: [] }))
  supervisor = new CoreSupervisor({
    configuration: { root: profile, libraryFilePath: library, coverCacheDir: join(profile, 'covers'), libraryStorage: 'sqlite', resumeMode: 'off' },
    entries: Object.fromEntries(Object.entries({ core: 'musicCore', audio: 'audioEngineService', 'audio-test': 'audioEngineService', database: 'libraryDatabaseService', scan: 'libraryScanService', analysis: 'audioAnalysisService' }).map(([name, file]) => [name, join(root, 'out/main', file + '.js')])),
    readyTimeoutMs: 30_000, requestTimeoutMs: 15_000, stopTimeoutMs: 5_000,
    platform: { ...createDspCorePlatform(), 'downloads.authorizedRoots': async ({libraryFolders}) => ({libraryRoots:libraryFolders,downloadRoot:null}) },
    fork(entry, args, serviceName) {
      const child = utilityProcess.fork(entry, args, { serviceName, stdio: 'pipe' })
      alive.add(child); child.once('exit', () => alive.delete(child))
      child.stderr?.on('data', data => process.stderr.write(data))
      return child
    }, channel: () => new MessageChannelMain()
  })
  const identity = { id: 'desktop:migration', role: 'desktop', permissions: ['playback:read', 'migration:write'] }
  supervisor.connect(identity)
  const initialized = once(supervisor, 'initialized'), started = supervisor.start(); void started.catch(() => {})
  await initialized
  ipcMain.handle('fixture:core-migration', async (event, name, payload = {}) => {
    assert.equal(event.sender.id, window.webContents.id)
    assert.equal(event.senderFrame, window.webContents.mainFrame)
    assert.ok(['migration.status', 'migration.begin', 'migration.stage', 'migration.commit'].includes(name))
    const result = await supervisor.request(identity.id, { kind: name === 'migration.status' ? 'query' : 'command', name, payload, epoch: supervisor.getStatus().epoch, requestId: 'migration:' + ++serial })
    if (name === 'migration.stage' && !droppedReply) { droppedReply = true; throw Error('Injected loss after durable migration stage') }
    return result
  })
  const html = join(__dirname, 'migration.html')
  writeFileSync(html, '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src &#39;self&#39;; script-src &#39;self&#39;"><script src="migration.js"></script>')
  window = new BrowserWindow({ show: false, webPreferences: { preload: join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } })
  await window.loadFile(html)
  const browser = await window.webContents.executeJavaScript('globalThis.runMigrationFixture()')
  assert.deepEqual(browser, { retryValidated: true, browserIntact: true })
  await started
  window.destroy(); supervisor.disconnect(identity.id)
  const windowsAfterImport = BrowserWindow.getAllWindows().length
  await supervisor.shutdown()
  for (const child of alive) await Promise.race([once(child, 'exit'), new Promise((_, reject) => setTimeout(() => reject(Error('Owned process did not exit')), 5000))])
  const database = new CoreStateDatabase(join(profile, 'core-state.sqlite'))
  const rows = domain => { const result = []; let after; do { const page = database.read(domain, after); result.push(...page.rows); after = page.next ?? undefined } while (after); return result }
  try {
    assert.equal(database.status().complete, true)
    const tracks = rows('statistics-tracks')
    for (let i = 0; i < tracks.length; i++) {
      assert.equal(tracks[i].key, 'cue:disc:' + String(i).padStart(3, '0'))
      assert.deepEqual(tracks[i].value, { title: 'Track ' + i, artist: 'Artist', seconds: i + 0.25, plays: i % 3, skips: i % 2, completions: i % 4, lastPlayed: 1234 + i, addedAt: 50 })
    }
    assert.deepEqual(rows('statistics-days'), [{ key: '2026-10-20', value: 42 }, { key: '2026-10-21', value: 123 }])
    assert.deepEqual(rows('inbox'), [{ key: '["track","tags"]', value: { fingerprint: 'original:v1', status: 'ignored', order: 1 } }])
    assert.deepEqual(rows('podcast-preferences'), [{ key: 'defaultPlaybackRate', value: 1.5 }])
    assert.deepEqual(rows('eq-preferences'), [{ key: 'autoPreamp', value: true }, { key: 'manualPreamp', value: -2 }])
    const versions = rows('versions')
    assert.deepEqual(versions.find(row => row.key === 'tracks:families:family').value, { id: 'family', versions: ['cue', 'remote'], preferredVersion: 'cue' })
    writeFileSync(join(__dirname, 'result.json'), JSON.stringify({ tracks: tracks.length, days: rows('statistics-days').length, versions: versions.length, ...browser, windowsAfterImport, servicesAfterShutdown: alive.size }))
  } finally { database.close() }
  app.quit()
}
run().catch(async error => { console.error(error); await supervisor?.shutdown().catch(failure => console.error('[migration] cleanup', failure)); for (const child of alive) child.kill(); window?.destroy(); app.exit(1) })
`

const renderer = String.raw`
import { migrateBrowserMusicData, openBrowserMusicMigrationSource } from './src/renderer/src/app/browserCoreMigration.ts'
const check = (ok, message) => { if (!ok) throw Error(message) }
const request = (name, payload = {}) => window.migrationFixture.request(name, payload)
const idbResult = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
globalThis.runMigrationFixture = async () => {
  const versions = JSON.stringify({ version: 1, tracks: { versions: [{ id: 'cue', label: 'Disc', sources: ['local:disc.flac#cue=1', 'local:disc.flac#cue=2'], preferredSource: 'local:disc.flac#cue=2' }, { id: 'remote', label: 'Online', sources: ['ncm:7'], preferredSource: null }], families: [{ id: 'family', versions: ['cue', 'remote'], preferredVersion: 'cue' }] }, albums: { versions: [], families: [] } })
  localStorage.setItem('twilight.music-versions.v1', versions)
  localStorage.setItem('twilight.library-inbox.v1', JSON.stringify({ version: 1, entries: [['["track","tags"]', { fingerprint: 'original:v1', status: 'ignored' }]] }))
  localStorage.setItem('twilight.podcast.defaultPlaybackRate', '1.5')
  localStorage.setItem('twilight-echo:eq-auto-preamp:v1', '1')
  localStorage.setItem('twilight-echo:eq-manual-preamp:v1', '-2')
  // Stale v1 browser statistics must not replace the authoritative v2 database.
  const stale = JSON.stringify({ days: { stale: 9999 }, tracks: {} })
  localStorage.setItem('twilight-echo:listening-stats:v1', stale)
  const open = indexedDB.open('twilight-echo:listening-stats:v2', 1)
  open.onupgradeneeded = () => { open.result.createObjectStore('tracks'); open.result.createObjectStore('meta') }
  const database = await idbResult(open)
  const transaction = database.transaction(['tracks', 'meta'], 'readwrite')
  for (let i = 0; i < 201; i++) transaction.objectStore('tracks').put({ title: 'Track ' + i, artist: 'Artist', seconds: i + 0.25, plays: i % 3, skips: i % 2, completions: i % 4, lastPlayed: 1234 + i, addedAt: 50 }, 'cue:disc:' + String(i).padStart(3, '0'))
  transaction.objectStore('meta').put({ '2026-10-20': 42, '2026-10-21': 123 }, 'days')
  await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error) })
  database.close()
  let frozen = false, interrupted = false
  const options = {
    api: { coreStateStatus: () => request('migration.status'), coreMigrationBegin: (id, manifest) => request('migration.begin', { id, manifest }), coreMigrationStage: (id, batch, domain, rows) => request('migration.stage', { id, batch, domain, rows }), coreMigrationCommit: id => request('migration.commit', { id }) },
    storage: localStorage, freezeBusinessWrites: () => { frozen = true },
    source: () => { check(frozen, 'Browser writes were not gated before reading'); return openBrowserMusicMigrationSource(localStorage, indexedDB) }, newId: () => 'browser-upgrade'
  }
  try { await migrateBrowserMusicData(options) } catch (error) { interrupted = String(error).includes('Injected loss') }
  check(interrupted, 'Lost reply was not exercised')
  const partial = await request('migration.status')
  check(!partial.complete && partial.nextBatch === 1, 'Interrupted stage was not durable')
  const complete = await migrateBrowserMusicData(options)
  check(complete.complete && complete.counts['statistics-tracks'] === 201, 'Migration publication is incomplete')
  check(localStorage.getItem('twilight.music-versions.v1') === versions && localStorage.getItem('twilight-echo:listening-stats:v1') === stale, 'Original browser values changed')
  const verify = await idbResult(indexedDB.open('twilight-echo:listening-stats:v2', 1))
  const count = await idbResult(verify.transaction('tracks').objectStore('tracks').count())
  verify.close()
  check(count === 201 && localStorage.getItem('twilight.core-migration.complete.v1') === 'browser-upgrade', 'Browser history or completion marker is missing')
  return { retryValidated: true, browserIntact: true }
}
`
