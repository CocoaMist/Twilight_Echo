import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const require = createRequire(import.meta.url)
const { buildSync } = createRequire(require.resolve('vite/package.json'))('esbuild')

test('Chromium persists incremental history, migrates legacy data, rolls back failed restores and flushes before exit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-stats-database-'))
  try {
    const root = resolve(import.meta.dirname, '../../../..')
    const bundle = buildSync({
      stdin: { contents: fixture, resolveDir: root },
      bundle: true,
      alias: { '@renderer': join(root, 'src/renderer/src') },
      format: 'iife',
      write: false,
      platform: 'browser'
    }).outputFiles[0].text
    await writeFile(
      join(directory, 'index.html'),
      '<!doctype html><title>Listening history regression</title>'
    )
    await writeFile(join(directory, 'fixture.js'), bundle)
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}});
await win.loadFile(path.join(__dirname,'index.html'));
await win.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname,'fixture.js'),'utf8'));
const result=await win.webContents.executeJavaScript('window.runStatsDatabaseTests()');
fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify(result));win.destroy();app.quit();
}).catch(error=>{console.error(error);app.exit(1)});`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    await promisify(execFile)(require('electron'), [join(directory, 'runner.cjs')], {
      env,
      windowsHide: true,
      timeout: 60_000
    })
    const results = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'))
    assert.equal(results.rows, 10_000)
    assert.equal(results.deltaRows, 1)
    assert.equal(results.reloadedSeconds, 1_445)
    assert.equal(results.migratedSeconds, 65)
    assert.equal(results.restoreRollbackSeconds, 5)
    console.log('Listening history Chromium measurements:', results)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

const fixture = `import {ListeningStatsDatabase} from './src/renderer/src/stores/listeningStatsDatabase.ts'
const expect=(value,message)=>{if(!value)throw new Error(message)}
window.runStatsDatabaseTests=async()=>{
  const db=new ListeningStatsDatabase(indexedDB,'fixture');await db.load()
  const today=new Date().toISOString().slice(0,10),stats={days:{[today]:14400000},tracks:{}}
  for(let i=0;i<10000;i++){
    const daily={};for(let d=0;d<8;d++)daily[new Date(Date.now()-d*86400000).toISOString().slice(0,10)]={seconds:180,plays:1,skips:0,completions:1,lastPlayed:Date.now()}
    stats.tracks['local:'+i]={seconds:1440,plays:8,skips:0,completions:8,lastPlayed:Date.now(),title:'Track '+i,artist:'Artist',cover:null,daily,
      track:{id:'local:'+i,title:'Track '+i,artist:'Artist',album:'Album',filePath:'D:/Fixtures/'+i+'.flac',duration:180,size:1,cover:null,lyrics:null,source:'local'}}
  }
  const migrationStart=performance.now();await db.save(stats);const migrationMs=performance.now()-migrationStart
  let rows=0,putMs=0,abortNext=false
  const put=IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put=function(value,key){
    const started=performance.now();const request=put.call(this,value,key);putMs+=performance.now()-started
    if(this.name==='tracks')++rows
    if(abortNext){abortNext=false;const transaction=this.transaction;queueMicrotask(()=>transaction.abort())}
    return request
  }
  stats.tracks['local:1']={...stats.tracks['local:1'],seconds:1445};db.markTrack('local:1')
  const start=performance.now();await db.save(stats);const deltaMs=performance.now()-start,deltaRows=rows
  expect(deltaRows===1,'normal playback rewrote the full history')
  const loaded=await db.load();expect(loaded.tracks['local:1'].seconds===1445,'delta was not durable')
  stats.tracks['local:1']={...stats.tracks['local:1'],seconds:1450};db.markTrack('local:1');abortNext=true
  let failed=false;try{await db.save(stats)}catch{failed=true}
  expect(failed,'abort did not propagate');expect((await db.load()).tracks['local:1'].seconds===1445,'failed transaction partially committed')
  await db.save(stats);expect((await db.load()).tracks['local:1'].seconds===1450,'aborted row was lost on retry')
  IDBObjectStore.prototype.put=put
  delete stats.tracks['local:1'];db.invalidate();await db.save(stats)
  expect(!(await db.load()).tracks['local:1'],'range clear failed to delete a stored row')
  await db.close()

  const key='twilight-echo:listening-stats:v1'
  localStorage.setItem(key,JSON.stringify({days:{[today]:60},tracks:{'logic:song::artist':{seconds:60,plays:1,lastPlayed:Date.now(),skips:0,completions:0,title:'Song',artist:'Artist',cover:null}}}))
  const store=await import('./src/renderer/src/stores/useListeningStatsStore.ts')
  await store.waitForListeningStatsReady()
  store.recordListeningForTest({id:'test',title:'Song',artist:'Artist',album:'Album',filePath:'D:/Fixtures/test.wav',duration:180,size:1,cover:null,lyrics:null,source:'local'},5,Date.now())
  await store.flushListeningStatsForExit()
  expect(localStorage.getItem(key)===null,'legacy data was retained after migration')
  const durable=new ListeningStatsDatabase(indexedDB)
  const migrated=await durable.load(),migratedSeconds=migrated.tracks['logic:song::artist'].seconds
  expect(migratedSeconds===65,'migration lost existing history or startup listening')
  await store.clearListeningStats(null)
  expect(Object.keys((await durable.load()).tracks).length===0,'full clear did not persist')
  await durable.close()

  const {applyPersonalRendererRestore}=await import('./src/renderer/src/app/personalRestore.ts')
  let request={id:'one',conflict:'use-backup',data:{statistics:{days:{[today]:5},tracks:{}}}},acknowledged=''
  window.api={data:{readRendererRestore:async()=>request,acknowledgeRendererRestore:async(id)=>{acknowledged=id}}}
  await applyPersonalRendererRestore()
  request={id:'two',conflict:'use-backup',data:{statistics:{days:{[today]:99},tracks:{}},versions:{version:1,tracks:{versions:[],families:[]},albums:{versions:[],families:[]}}}}
  const set=Storage.prototype.setItem;let fail=true;acknowledged=''
  Storage.prototype.setItem=function(key,value){if(fail&&key==='twilight.music-versions.v1'){fail=false;throw new Error('quota')}return set.call(this,key,value)}
  failed=false;try{await applyPersonalRendererRestore()}catch{failed=true}finally{Storage.prototype.setItem=set}
  const restored=new ListeningStatsDatabase(indexedDB),rollback=await restored.load(),restoreRollbackSeconds=rollback.days[today]
  expect(failed&&!acknowledged&&restoreRollbackSeconds===5,'restore did not roll back database after localStorage failed')
  await applyPersonalRendererRestore();expect((await restored.load()).days[today]===99&&acknowledged==='two','restore retry failed')
  await applyPersonalRendererRestore();expect((await restored.load()).days[today]===99,'repeat restore double-counted history')
  await restored.close()
  return {rows:10000,deltaRows,reloadedSeconds:loaded.tracks['local:1'].seconds,migratedSeconds,restoreRollbackSeconds,migrationMs,deltaMs,putMs}
}
`
