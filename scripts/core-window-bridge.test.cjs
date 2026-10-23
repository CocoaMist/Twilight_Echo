'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { mkdtemp, mkdir, readFile, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { promisify } = require('node:util')
const { createRequire } = require('node:module')
const test = require('node:test')
const { buildSync } = createRequire(require.resolve('vite/package.json'))('esbuild')

test(
  'real sandboxed windows attach to the finite Core bridge without owning or restarting music',
  { timeout: 60000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'twilight-core-window-'))
    const root = resolve(__dirname, '..')
    try {
      await mkdir(join(directory, 'renderer'))
      await writeFile(
        join(directory, 'renderer', 'index.html'),
        '<!doctype html><html><body><script src="./renderer.js"></script></body></html>'
      )
      const build = (contents, outfile, platform) =>
        buildSync({
          stdin: { contents, resolveDir: root },
          bundle: true,
          platform,
          format: platform === 'browser' ? 'iife' : 'cjs',
          define: { 'import.meta.hot': 'undefined' },
          external: ['electron'],
          outfile
        })
      build(
        `const {contextBridge}=require('electron'); const {coreApi}=require('./src/preload/domains/coreApi.ts'); contextBridge.exposeInMainWorld('api',{core:coreApi})`,
        join(directory, 'preload.cjs'),
        'node'
      )
      build(
        `import {createCoreConnectionStore} from './src/renderer/src/stores/coreConnection.ts'; window.store=createCoreConnectionStore(window.api.core)`,
        join(directory, 'renderer', 'renderer.js'),
        'browser'
      )
      build(fixture, join(directory, 'runner.cjs'), 'node')
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      await promisify(execFile)(require('electron'), [join(directory, 'runner.cjs')], {
        env,
        windowsHide: true,
        timeout: 50000,
        maxBuffer: 2 * 1024 * 1024
      })
      const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'))
      assert.deepEqual(result, {
        isolated: true,
        frameRejected: true,
        helperRestricted: true,
        errorCode: 'STALE_REVISION',
        cancelled: 1,
        commands: 1,
        reattached: true,
        badUrlRejected: true,
        windows: 0
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)

const fixture = String.raw`
const {app, BrowserWindow, ipcMain}=require('electron');
const {EventEmitter}=require('node:events');
const {join}=require('node:path');
const {writeFile}=require('node:fs/promises');
const assert=require('node:assert/strict');
const {CoreWindowBridge,CORE_WINDOW_POLICIES}=require('./src/main/coreProcess/windowBridge.ts');
const {isTrustedIpcSenderUrl}=require('./src/main/security/electronSecurity.ts');
app.setPath('userData',join(__dirname,'profile'));
app.on('window-all-closed',()=>{});
const state=()=>({protocolVersion:1,epoch:'fixture-epoch',sequence:0,phase:'ready',track:{id:'same-track'},queue:{occurrenceId:'same-occurrence'},playback:{position:12}});
class Supervisor extends EventEmitter {
 constructor(){super();this.identities=new Map();this.commands=0;this.cancelled=0;this.hold=false}
 getStatus(){return {phase:'ready',epoch:'fixture-epoch'}}
 connect(identity){this.identities.set(identity.id,identity);this.emit('client-message',identity.id,{kind:'state',epoch:'fixture-epoch',sequence:0,snapshot:state()})}
 disconnect(id){this.identities.delete(id)}
 async request(id,request,signal){
  assert(this.identities.has(id));
  if(request.name==='state.snapshot')return state();
  if(request.name==='queue.page')throw Object.assign(new Error('stale revision'),{code:'STALE_REVISION'});
  if(request.kind==='command')this.commands++;
  if(this.hold)return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{this.cancelled++;reject(Object.assign(new Error('write outcome unknown'),{code:'OUTCOME_UNKNOWN'}))},{once:true}));
  return null;
 }
}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
app.whenReady().then(async()=>{
 const supervisor=new Supervisor();
 const bridge=new CoreWindowBridge({supervisor,ipc:ipcMain,trustedUrl:isTrustedIpcSenderUrl});
 const open=async(policy,query='')=>{
  const window=new BrowserWindow({show:false,webPreferences:{preload:join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false,nodeIntegrationInSubFrames:true}});
  bridge.register(window.webContents,policy);
  await window.loadFile(join(__dirname,'renderer','index.html'),{query:{window:query}});
  return window;
 };
 const main=await open(CORE_WINDOW_POLICIES.desktop);
 const first=await main.webContents.executeJavaScript('window.store.attach().then(()=>window.store.state.value.queue.occurrenceId)');
 assert.equal(first,'same-occurrence');
 const firstId=[...supervisor.identities.keys()][0];
 const isolated=await main.webContents.executeJavaScript('typeof require==="undefined" && typeof window.api.core.request==="function"');
 const errorCode=await main.webContents.executeJavaScript('window.store.query("queue.page",{id:"q",revision:2,offset:0}).catch(error=>error.code)');
 await main.webContents.executeJavaScript('new Promise(resolve=>{const f=document.createElement("iframe");f.src="./index.html?frame=child";f.onload=resolve;document.body.appendChild(f)})');
 const subframe=main.webContents.mainFrame.frames[0];
 const frameReply=await subframe.executeJavaScript('window.api.core.connect()');
 const helper=await open(undefined,'desktop');
 await helper.webContents.executeJavaScript('window.store.attach()');
 const helperCode=await helper.webContents.executeJavaScript('window.store.command("library.reset",{revision:0}).catch(error=>error.code)');
 supervisor.hold=true;
 await main.webContents.executeJavaScript('void window.store.command("playback.pause",{}).catch(()=>{}); true');
 for(let i=0;i<100&&supervisor.commands!==1;i++)await wait(5);
 const loaded=new Promise(resolve=>main.webContents.once('did-finish-load',resolve));
 main.reload();
 await loaded;
 supervisor.hold=false;
 await main.webContents.executeJavaScript('window.store.attach()');
 const after=await main.webContents.executeJavaScript('({occurrence:window.store.state.value.queue.occurrenceId,position:window.store.state.value.playback.position})');
 assert.deepEqual(after,{occurrence:'same-occurrence',position:12});
 const reattached=!supervisor.identities.has(firstId);
 await helper.loadURL('data:text/html,<h1>untrusted</h1>');
 const rejected=await helper.webContents.executeJavaScript('window.api.core.connect()');
 main.destroy();helper.destroy();bridge.dispose();
 const result={isolated,frameRejected:!frameReply.ok&&frameReply.error.code==='FORBIDDEN',helperRestricted:helperCode==='FORBIDDEN',errorCode,cancelled:supervisor.cancelled,commands:supervisor.commands,reattached,badUrlRejected:!rejected.ok&&rejected.error.code==='FORBIDDEN',windows:BrowserWindow.getAllWindows().length};
 await writeFile(join(__dirname,'result.json'),JSON.stringify(result));
 app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});
`
