'use strict'
const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { mkdtemp, readFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve, dirname, basename } = require('node:path')
const { promisify } = require('node:util')
const { createRequire } = require('node:module')
const test = require('node:test')
const { buildSync } = createRequire(require.resolve('vite/package.json'))('esbuild')

test(
  'real Core completes provider downloads, tags, lyrics and queued indexing with zero renderer clients',
  { timeout: 90_000 },
  async () => {
    const root = resolve(__dirname, '..')
    const directory = await mkdtemp(join(tmpdir(), 'twilight-core-downloads-'))
    try {
      const runner = join(directory, 'runner.cjs')
      buildSync({
        stdin: { contents: fixture, resolveDir: root },
        bundle: true,
        platform: 'node',
        format: 'cjs',
        external: ['electron'],
          define: { 'import.meta.url': JSON.stringify(require('node:url').pathToFileURL(join(root, 'package.json')).href) },
        outfile: runner
      })
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const execution = promisify(execFile)(require('electron'), [runner, root], {
        env,
        windowsHide: true,
        timeout: 80_000,
        maxBuffer: 2 * 1024 * 1024
      })
      execution.child.stderr?.on('data', (data) => process.stderr.write(data))
      execution.child.stdout?.on('data', (data) => process.stdout.write(data))
      await execution
      assert.deepEqual(JSON.parse(await readFile(join(directory, 'result.json'), 'utf8')), {
        windows: 0,
        noReplay: true,
        tags: true,
        lyrics: true,
        indexed: true,
        cancel: true,
        hostsAfterShutdown: 0
      })
    } finally {
      assert.equal(dirname(directory), resolve(tmpdir()))
      assert.ok(basename(directory).startsWith('twilight-core-downloads-'))
      await rm(directory, { recursive: true, force: true })
    }
  }
)

const fixture = String.raw`
const { app, BrowserWindow, utilityProcess, MessageChannelMain } = require('electron')
const { CoreSupervisor } = require('./src/main/coreProcess/supervisor.ts')
const { createDspCorePlatform } = require('./src/main/dsp/corePlatform.ts')
const { CoreStateDatabase } = require('./src/main/library/coreStateDatabase.ts')
const { emptyCoreStateCounts } = require('./src/shared/coreState.ts')
const { createServer } = require('node:http')
const { writeFileSync, readFileSync, mkdirSync, readdirSync } = require('node:fs')
const { join, dirname } = require('node:path')
const assert = require('node:assert/strict')
const root = process.argv[2], profile = join(__dirname, 'profile'), library = join(profile, 'library'), downloads = join(profile, 'downloads')
mkdirSync(library, { recursive: true }); mkdirSync(downloads)
app.disableHardwareAcceleration(); app.setPath('userData', profile)
const alive = new Set(), children = []
let supervisor, server, serial = 0, holdScan = null, releaseFile, fileEntered, dropCreate = true
const entered = new Promise(resolve => { fileEntered = resolve })
const fileGate = new Promise(resolve => { releaseFile = resolve })
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(read, check) { for (let i=0;i<300;i++) { const state=await read(); if(check(state)) return state; await pause(20) } throw Error('Expected Core task state was not reached') }
async function main() {
  const { parseFile } = await import('music-metadata')
  const wave = Buffer.alloc(444)
  wave.write('RIFF'); wave.writeUInt32LE(wave.length-8,4); wave.write('WAVEfmt ',8); wave.writeUInt32LE(16,16); wave.writeUInt16LE(1,20); wave.writeUInt16LE(1,22)
  wave.writeUInt32LE(8000,24); wave.writeUInt32LE(16000,28); wave.writeUInt16LE(2,32); wave.writeUInt16LE(16,34); wave.write('data',36); wave.writeUInt32LE(400,40)
  server=createServer(async(req,res)=> { res.setHeader('content-length',wave.length);res.write(wave.subarray(0,44)); if(req.url==='/audio'){fileEntered();await fileGate}else await pause(5000);if(!res.destroyed)res.end(wave.subarray(44)) })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const url='http://127.0.0.1:'+server.address().port
  const db=new CoreStateDatabase(join(profile,'core-state.sqlite'));await db.begin('upgraded',{version:1,counts:emptyCoreStateCounts()});await db.commit('upgraded');db.close()
  const libraryFile=join(profile,'music-library.json')
  writeFileSync(libraryFile,JSON.stringify({version:2,revision:0,folders:[library],exclusions:[],tracks:[]}))
  const id='com.example.download', pkg=join(profile,'plugins',id,'1.0.0')
  mkdirSync(pkg,{recursive:true})
  writeFileSync(join(profile,'plugin-state.json'),JSON.stringify({[id]:{enabled:true,activeVersion:'1.0.0',source:'directory',installedAt:new Date().toISOString(),updatedAt:new Date().toISOString()}}))
  writeFileSync(join(pkg,'plugin.json'),JSON.stringify({id,name:'Core download fixture',description:'silent',author:'fixture',license:'MIT',version:'1.0.0',main:'index.mjs',type:['provider'],apiVersion:1,engines:{twilightEcho:'*'},permissions:['settings','network']}))
  writeFileSync(join(pkg,'index.mjs'), "export async function activate({twilight,settings}) {\n  await twilight.providers.register({id:'fixture',name:'Downloads',capabilities:['download','lyrics','login'],\n    async createDownload({track,quality}) { await settings.set('creates', ((await settings.get('creates'))??0)+1);return {jobId:track.id,status:'ready',progress:1,requestedQuality:quality} },\n    async getDownloadFile(id) {return {url:DOWNLOAD_URL+(id==='one'?'/audio':'/slow'),fileName:'song.wav',fileSize:444}},\n    async cancelDownload(){return true},\n    async getLyrics(){return {lyrics:'[00:00.00]Background song',translatedLyrics:'[00:00.00]后台歌词'}},\n    async getProfile(){return {creates:await settings.get('creates')}}\n  })\n}".replace('DOWNLOAD_URL',JSON.stringify(url)))
  supervisor=new CoreSupervisor({
    configuration:{root:profile,libraryFilePath:libraryFile,coverCacheDir:join(profile,'covers'),libraryStorage:'sqlite',downloadFolder:downloads,downloadPreferences:{naming:'title',embedMetadata:true,saveLyrics:true},plugins:{appVersion:'1.0.0',hostIdleTimeoutMs:0}},
    entries:Object.fromEntries(Object.entries({core:'musicCore',audio:'audioEngineService','audio-test':'audioEngineService',database:'libraryDatabaseService',scan:'libraryScanService',analysis:'audioAnalysisService',plugin:'pluginHost'}).map(([name,file])=>[name,join(root,'out/main',file+'.js')])),
    readyTimeoutMs:30000,requestTimeoutMs:1500,stopTimeoutMs:10000,
    platform: {
      ...createDspCorePlatform(),
      'downloads.authorizedRoots':async()=>({libraryRoots:[library],downloadRoot:downloads}),
      'downloads.grantResult':async({path})=>{assert.ok(dirname(path)===library||dirname(path)===downloads);return path},
      'paths.authorizeLibraryDirectory':async({path})=>{assert.equal(path,library);if(holdScan)await holdScan;return path},
      'paths.authorizeAudio':async()=>{throw Error('No audible playback is authorized')},
      'media.protectProviderResult':async({value})=>value,
      'overlay.hide':async()=>{}
    },
    fork(entry,args,serviceName){
      const child=utilityProcess.fork(entry,args,{serviceName,stdio:'pipe',env:{...process.env,TWILIGHT_PLUGIN_PROXY_MODE:'off'}})
      alive.add(child);children.push({child,serviceName});child.once('exit',()=>alive.delete(child));child.stderr?.on('data',data=>process.stderr.write(data))
      const emit=child.emit.bind(child);child.emit=(event,...args)=>{const message=args[0];if(dropCreate&&serviceName==='twilight-core'&&event==='message'&&message?.kind==='core:client-message'&&message.message?.requestId==='lost-download')return true;return emit(event,...args)}
      return child
    },channel:()=>new MessageChannelMain()
  })
  const identity={id:'desktop',role:'desktop',permissions:['playback:read','playback:write','library:read','library:write','providers:call','downloads:read','downloads:write']}
  supervisor.connect(identity)
  const request=(kind,name,payload={},requestId='request:'+ ++serial)=>supervisor.request(identity.id,{kind,name,payload,requestId,epoch:supervisor.getStatus().epoch})
  const downloadState=()=>request('query','downloads.state')
  const pages=async()=>{for(let i=0;i<20;i++){const state=await downloadState();try{return await request('query','downloads.page',{revision:state.revision})}catch(error){if(error.code!=='STALE_REVISION')throw error}}throw Error('Download pages kept changing')}
  await supervisor.start();assert.equal(BrowserWindow.getAllWindows().length,0)
  const lost=request('command','downloads.create',{providerId:'fixture',track:{id:'one',title:'Core download',artist:'Artist',album:'Background',privateUrl:'https://private.invalid/audio'},quality:'lossless'},'lost-download')
  const unknown=assert.rejects(lost,error=>error.code==='OUTCOME_UNKNOWN')
  await entered;await unknown;dropCreate=false
  supervisor.disconnect(identity.id);releaseFile();await pause(500)
  supervisor.connect(identity)
  const complete=await waitFor(pages,page=>page.items[0]?.status==='completed')
  assert.equal(complete.total,1);const task=complete.items[0]
  assert.doesNotMatch(JSON.stringify(complete),/providerJobId|targetPath|privateUrl|private.invalid/)
  assert.equal((await request('command','providers.call',{providerId:'fixture',method:'getProfile',args:[]})).creates,1)
  assert.equal(task.actualQuality,'lossless');assert.equal(task.qualityVerified,true)
  const audio=join(downloads,'Core download.wav'), metadata=await parseFile(audio)
  assert.equal(metadata.common.title,'Core download');assert.equal(readFileSync(join(downloads,'Core download.lrc'),'utf8'),'[00:00.00]Background song')
  assert.ok(children.some(child=>child.serviceName==='twilight-analysis'))
  // A new download import must queue behind a slow explicit scan, not return BUSY or lose indexing.
  let unblock;holdScan=new Promise(resolve=>{unblock=resolve})
  const scan=request('command','scan.start',{mode:'full'})
  await pause(50)
  await request('command','downloads.result',{id:task.id,addToLibrary:true})
  assert.deepEqual(JSON.parse(readFileSync(join(profile,'core-index-directories.json'),'utf8')).data,[library])
  const started=Date.now();await request('command','playback.pause');assert.ok(Date.now()-started<1000)
  holdScan=null;unblock();await scan;supervisor.disconnect(identity.id)
  await pause(500);supervisor.connect(identity)
  await waitFor(()=>request('query','library.tracks',{}),page=>page.total===1)
  await waitFor(()=>request('query','scan.status'),status=>status?.state==='completed')
  assert.deepEqual(JSON.parse(readFileSync(join(profile,'core-index-directories.json'),'utf8')).data,[])
  assert.ok(readdirSync(library).some(name=>name.endsWith('.wav')))
  const slow=await request('command','downloads.create',{providerId:'fixture',track:{id:'two',title:'Cancel download',artist:'Artist'},quality:'lossless'})
  await waitFor(pages,page=>page.items.find(item=>item.id===slow.id)?.status==='downloading')
  await request('command','downloads.cancel',{id:slow.id})
  assert.equal((await pages()).items.find(item=>item.id===slow.id).status,'cancelled')
  assert.ok(!readdirSync(downloads).some(name=>name.includes('.part')))
  const third=await request('command','downloads.create',{providerId:'fixture',track:{id:'three',title:'Quit download',artist:'Artist'},quality:'lossless'})
  await waitFor(pages,page=>page.items.find(item=>item.id===third.id)?.status==='downloading')
  supervisor.disconnect(identity.id);await supervisor.shutdown()
  assert.equal(alive.size,0);assert.ok(!readdirSync(downloads).some(name=>name.includes('.part')))
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve))
  writeFileSync(join(__dirname,'result.json'),JSON.stringify({windows:BrowserWindow.getAllWindows().length,noReplay:true,tags:true,lyrics:true,indexed:true,cancel:true,hostsAfterShutdown:alive.size}))
}
app.whenReady().then(main).then(()=>app.exit(0),async error=>{console.error(error);server?.closeAllConnections();server?.close();await supervisor?.shutdown().catch(()=>{});for(const child of alive)child.kill();app.exit(1)})
`
