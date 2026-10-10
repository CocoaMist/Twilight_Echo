const { createRequire } = require('node:module')
// Resolve the bundler through the declared Vite dependency under strict pnpm layouts.
const { buildSync } = createRequire(require.resolve('vite/package.json'))('esbuild')
const { mkdtempSync, writeFileSync, readFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { resolve, join } = require('node:path')
const { spawnSync } = require('node:child_process')

// A fresh Chromium profile measures actual localStorage without reading or
// writing the user's listening history. The fixture intentionally includes a
// compact track snapshot and one day per track, matching the audit workload.
const root = resolve(__dirname, '..')
const work = mkdtempSync(join(tmpdir(), 'twilight-listening-stats-benchmark-'))
const bundle = buildSync({
  stdin: {
    contents: `export { ListeningStatsPersistence } from './src/renderer/src/stores/listeningStatsPersistence.ts';
      export { compactListeningStatsForPersistence } from './src/renderer/src/stores/useListeningStatsStore.ts';`,
    resolveDir: root
  },
  alias: { '@renderer': join(root, 'src/renderer/src') },
  bundle: true,
  format: 'iife',
  globalName: 'statsBenchmark',
  write: false,
  platform: 'browser'
}).outputFiles[0].text
const probe = `(() => {
  const { ListeningStatsPersistence, compactListeningStatsForPersistence } = statsBenchmark;
  const day = new Date().toISOString().slice(0, 10), now = Date.now();
  return [1000, 10000].map((count) => {
    const stats = { days: { [day]: count * 180 }, tracks: {} };
    for (let i = 0; i < count; ++i) {
      const id = 'local:' + i;
      stats.tracks[id] = {
        seconds: 180, plays: 1, skips: 0, completions: 1, lastPlayed: now,
        title: 'Track ' + i, artist: 'Artist', cover: 'cover://art.jpg',
        daily: { [day]: { seconds: 180, plays: 1, skips: 0, completions: 1, lastPlayed: now } },
        track: { id, title: 'Track ' + i, artist: 'Artist', album: 'Album',
          filePath: 'E:/Music/' + i + '.flac', fileName: i + '.flac', duration: 180,
          size: 10000000, cover: 'cover://art.jpg', lyrics: null, source: 'local' }
      };
    }
    const attempts = [];
    let status, writeMs = 0, characters = 0;
    const key = 'twilight-listening-stats-benchmark';
    const persistence = new ListeningStatsPersistence({
      key, storage: { getItem: (k) => localStorage.getItem(k), setItem: (k, value) => {
        characters = value.length; const start = performance.now();
        try { localStorage.setItem(k, value); } finally { writeMs = performance.now() - start; }
      } },
      getSnapshot: () => stats, beforePersist: () => compactListeningStatsForPersistence(stats),
      onStatus: (next) => { status = next; }, flushDelayMs: 30000, retryDelayMs: 60000
    });
    for (let attempt = 0; attempt < 5; ++attempt) {
      persistence.markDirty(); const start = performance.now(); const successful = persistence.flush();
      attempts.push({ successful, totalMs: performance.now() - start, writeMs, characters,
        measurement: status.lastFlush ?? null, error: status.lastError });
      localStorage.removeItem(key);
    }
    persistence.dispose();
    return { tracks: count, attempts };
  });
})()`
writeFileSync(join(work, 'probe.html'), '<!doctype html><title>Listening stats benchmark</title>')
writeFileSync(join(work, 'probe.js'), `${bundle}\n${probe}`)
writeFileSync(
  join(work, 'runner.cjs'),
  `
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'); const path = require('node:path');
app.setPath('userData', path.join(__dirname, 'profile'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await window.loadFile(path.join(__dirname, 'probe.html'));
  const scenarios = await window.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, 'probe.js'), 'utf8'));
  fs.writeFileSync(path.join(__dirname, 'result.json'), JSON.stringify({ chromium: process.versions.chrome, scenarios }, null, 2));
  window.destroy(); app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
`
)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const run = spawnSync(require('electron'), [join(work, 'runner.cjs')], {
  env,
  windowsHide: true,
  timeout: 45000,
  encoding: 'utf8'
})
if (run.status !== 0) {
  console.error(run.error ?? run.stderr, `Benchmark artifacts: ${work}`)
  process.exit(1)
}
console.log(readFileSync(join(work, 'result.json'), 'utf8'))
