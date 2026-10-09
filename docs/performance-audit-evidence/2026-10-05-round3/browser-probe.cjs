const { createRequire } = require('node:module')
const { buildSync } = createRequire(require.resolve('vite/package.json'))('esbuild')
const { mkdtempSync, writeFileSync, readFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { resolve, join } = require('node:path')
const { spawnSync } = require('node:child_process')
const root = resolve(__dirname, '../../..')
const work = mkdtempSync(join(tmpdir(), 'twilight-audit3-browser-'))
const bundle = buildSync({ stdin: { contents: `export { ListeningStatsPersistence } from './src/renderer/src/stores/listeningStatsPersistence.ts';
  export { compactListeningStatsForPersistence } from './src/renderer/src/stores/useListeningStatsStore.ts';`, resolveDir: root },
  alias: { '@renderer': join(root, 'src/renderer/src') }, bundle: true, format: 'iife', globalName: 'audit', write: false,
  platform: 'browser' }).outputFiles[0].text
const probe = `(() => {
  const { ListeningStatsPersistence, compactListeningStatsForPersistence } = audit;
  const now = Date.now(), outcomes = [];
  for (const [count, dayCount] of [[1000,1],[10000,1],[2000,30],[10000,7],[10000,8]]) {
    const dates = Array.from({ length: dayCount }, (_,i) => new Date(now-i*86400000).toISOString().slice(0,10));
    const stats = { days: {}, tracks: {} };
    for (const day of dates) stats.days[day] = count*180;
    for (let i=0;i<count;i++) {
      const daily = {};
      for(const day of dates) daily[day] = { seconds:180, plays:1, skips:0, completions:1, lastPlayed:now };
      const id = 'local:'+i;
      stats.tracks[id] = { seconds:180*dayCount, plays:dayCount, skips:0, completions:dayCount, lastPlayed:now,
        title:'Track '+i, artist:'Artist', cover:'cover://art.jpg', daily,
        track:{ id, title:'Track '+i, artist:'Artist', album:'Album', filePath:'D:/AuditMusic/'+i+'.flac', fileName:i+'.flac',
          duration:180, size:10000000, cover:'cover://art.jpg', lyrics:null, source:'local' } };
    }
    const attempts = []; let status, characters=0, writeMs=0;
    const persistence = new ListeningStatsPersistence({ key:'probe', storage: { getItem:k=>localStorage.getItem(k),
      setItem:(k,v)=>{ characters=v.length; const start=performance.now(); try{localStorage.setItem(k,v)}finally{writeMs=performance.now()-start} } },
      getSnapshot:()=>stats, beforePersist:()=>compactListeningStatsForPersistence(stats), onStatus:s=>{status=s},
      flushDelayMs:30000,retryDelayMs:60000 });
    for(let i=0;i<3;i++) {
      persistence.markDirty(); const start=performance.now(); const success=persistence.flush();
      attempts.push({ success,totalMs:performance.now()-start,writeMs,characters,measurement:status.lastFlush??null,
        failureCount:status.failureCount,error:status.lastError });
      localStorage.removeItem('probe');
    }
    persistence.dispose(); outcomes.push({count,dayCount,retainedTracks:Object.keys(stats.tracks).length,attempts});
  }
  return outcomes;
})()`
writeFileSync(join(work, 'probe.html'), '<!doctype html><title>Isolated performance audit</title>')
writeFileSync(join(work, 'probe.js'), `${bundle}\n${probe}`)
writeFileSync(join(work, 'runner.cjs'), `const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}});
await win.loadFile(path.join(__dirname,'probe.html'));const cases=await win.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname,'probe.js'),'utf8'));
fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({electron:process.versions.electron,chromium:process.versions.chrome,cases},null,2));
win.destroy();app.quit();}).catch(e=>{console.error(e);app.exit(1)});`)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const run = spawnSync(require('electron'), [join(work, 'runner.cjs')], { env, windowsHide:true, timeout:45000, encoding:'utf8' })
if(run.status!==0) { console.error(run.error??run.stderr, work);process.exit(1) }
console.log(readFileSync(join(work, 'result.json'), 'utf8'))
