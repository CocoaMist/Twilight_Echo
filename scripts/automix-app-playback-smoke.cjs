// Complete application / IPC / coordinator / utility-process playback probe.
// Explicit Windows hardware check, excluded from ordinary no-device CI.
const { spawn, spawnSync } = require('node:child_process')
const {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} = require('node:fs')
const { tmpdir } = require('node:os')
const { dirname, join, resolve } = require('node:path')

const args = process.argv.slice(2)
const option = (name, fallback = '') => {
  const index = args.indexOf(name)
  return index < 0 ? fallback : args[index + 1]
}
const root = resolve(__dirname, '..')
const outgoing = resolve(option('--out'))
const incoming = resolve(option('--in'))
const expectedOutgoingEnd = option('--expect-outgoing-end')
const expectedIncomingStart = option('--expect-incoming-start')
for (const value of [expectedOutgoingEnd, expectedIncomingStart])
  if (value && (!Number.isFinite(Number(value)) || Number(value) < 0))
    throw new Error('Invalid expected source boundary')
if (!option('--out') || !option('--in') || !option('--device'))
  throw new Error(
    'Usage: node scripts/automix-app-playback-smoke.cjs --out <file> --in <file> --device <WASAPI endpoint> [--rounded-duration] [--require-style <id>] [--player-bar] [--expect-outgoing-end <seconds>] [--expect-incoming-start <seconds>] [--report <json>]'
  )
const work = mkdtempSync(join(tmpdir(), 'twilight-automix-app-playback-'))
const profile = join(work, 'profile')
const reportFile = resolve(option('--report', join(work, 'report.json')))
const runtimeDirectory = option('--runtime')
  ? resolve(option('--runtime'))
  : join(root, 'resources', 'audio-engine')
const appPath = option('--runtime') ? work : root
if (option('--runtime')) {
  const target = join(work, 'resources', 'audio-engine')
  cpSync(runtimeDirectory, target, { recursive: true })
  if (!existsSync(join(target, 'automix')))
    symlinkSync(
      join(root, 'resources', 'audio-engine', 'automix'),
      join(target, 'automix'),
      'junction'
    )
}
// Embedded artwork may exceed the control RPC's metadata response limit. Only
// duration is needed for the probe; read it outside the application transport.
process.env.PATH = runtimeDirectory + require('node:path').delimiter + process.env.PATH
const native = require(join(runtimeDirectory, 'twilight_audio_node.node'))
const metadata = [outgoing, incoming].map((source) => {
  const raw = native.GetMetadata(source)
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw
  return { duration: Number(value.duration ?? value.durationSeconds) }
})
mkdirSync(profile)
if (option('--feature-cache'))
  cpSync(resolve(option('--feature-cache')), join(profile, 'automix-features'), { recursive: true })
writeFileSync(
  join(profile, 'settings.json'),
  JSON.stringify({
    onboardingCompleted: true,
    autoCheckLogin: false,
    playbackResumeMode: 'off',
    libraryFolders: [...new Set([dirname(outgoing), dirname(incoming)])],
    audioOutput: 'wasapi',
    audioDevice: option('--device'),
    audioExclusiveMode: false,
    playMode: 'list',
    volume: 0,
    audioProcessing: {
      dspEnabled: true,
      gapless: true,
      directMode: false,
      autoMix: { enabled: true, allowIntelligentSkip: true, maxTransitionSeconds: 12 }
    }
  })
)
const runner = String.raw`
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = ${JSON.stringify(root)}
const reportFile = ${JSON.stringify(reportFile)}
const outgoing = ${JSON.stringify(outgoing)}, incoming = ${JSON.stringify(incoming)}
const report = {format:1, passed:false, kind:'complete-app-automix-playback',
  isolatedProfile:${JSON.stringify(profile)}, volume:0, listeningQuality:'not-rated',
  expectedOutgoingEnd:${expectedOutgoingEnd ? Number(expectedOutgoingEnd) : 'null'},
  expectedIncomingStart:${expectedIncomingStart ? Number(expectedIncomingStart) : 'null'},
  roundedQueueDuration:${args.includes('--rounded-duration')}, observations:[]}
app.setAppPath(${JSON.stringify(appPath)})
app.setPath('userData', report.isolatedProfile)
app.disableHardwareAcceleration()
app.on('browser-window-created', (_event, window) => {
  window.show = () => {}
  window.showInactive = () => {}
})
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const watchdog = setTimeout(() => {
  report.error = 'Playback probe watchdog expired'
  fs.writeFileSync(reportFile, JSON.stringify(report,null,2)+'\n')
  app.exit(1)
}, 70000)
require(path.join(root,'out/main/index.js'))
app.whenReady().then(async () => {
  let evaluate
  try {
    let window
    for (let i=0;i<200;i++) {
      window = BrowserWindow.getAllWindows().find(w => process.env.ELECTRON_RENDERER_URL
        ? w.webContents.getURL().startsWith(process.env.ELECTRON_RENDERER_URL)
        : w.webContents.getURL().includes('/renderer/index.html'))
      if (window && await window.webContents.executeJavaScript('Boolean(window.api?.audioEngine)')) break
      await pause(100)
    }
    assert.ok(window, 'Main renderer unavailable')
    evaluate = code => window.webContents.executeJavaScript(code)
    await evaluate('window.api.audioEngine.setVolume(0)')
    report.metadata = ${JSON.stringify(metadata)}
    const duration = m => Number(m.duration ?? m.durationSeconds)
    assert.ok(report.metadata.every(m=>duration(m)>40), 'Known track durations required')
    const queue = [outgoing,incoming].map((source,i)=>({id:'app-probe-'+i, source,
      duration:report.roundedQueueDuration ? Math.round(duration(report.metadata[i])) : duration(report.metadata[i])}))
    report.queue = queue
    report.playerBar = ${args.includes('--player-bar')}
    if (report.playerBar) {
      const tracks = queue.map((item,i)=>({...item,source:'local',filePath:item.source,
        fileName:path.basename(item.source),title:path.basename(item.source),artist:'',album:'',size:1,
        cover:null,lyrics:null}))
      await evaluate('(async()=>{const {usePlayerStore}=await import("/src/stores/usePlayerStore.ts");'+
        'window.__autoMixProbePlayer=usePlayerStore();window.__autoMixProbePlayer.playTrackFromPosition('+
        JSON.stringify(tracks[0])+','+(duration(report.metadata[0])-30)+','+JSON.stringify(tracks)+');})()')
      for(let i=0;i<100;i++) {
        const info=await evaluate('window.api.audioEngine.getPlaybackInfo()')
        if(info.source===outgoing&&info.state==='playing')break
        await pause(100)
      }
      report.playResult={nativeStarted:true}
    } else {
      await evaluate('window.api.audioEngine.loadQueue('+JSON.stringify(queue)+',0)')
      report.playResult = await evaluate('window.api.audioEngine.play('+JSON.stringify(outgoing)+','+(duration(report.metadata[0])-30)+')')
    }
    report.processing = await evaluate('window.api.audioEngine.getAudioProcessing()')
    assert.equal(report.playResult.nativeStarted,true)
    if (${args.includes('--settings-status')}) {
      await evaluate('document.querySelector(\'button[aria-label="设置"]\').click()')
      for(let i=0;i<100;i++) {
        if(await evaluate('Boolean(document.querySelector(".preview-nav-item"))'))break
        await pause(100)
      }
      await evaluate('Array.from(document.querySelectorAll(".preview-nav-item")).find(b=>["播放","播放与音效"].includes(b.textContent.trim())).click()')
      for(let i=0;i<100;i++) {
        if(await evaluate('Boolean(document.querySelector(\'button[aria-label="AutoMix"]\'))'))break
        await pause(100)
      }
    }
    let mixed=false, promoted=false, switches=0, previousIndex=0
    let overlapSeconds=0, incomingObservedAt=0
    const deadline=Date.now()+42000
    while(Date.now()<deadline) {
      const info = await evaluate('window.api.audioEngine.getPlaybackInfo()')
      const settingsText=${args.includes('--settings-status')} ? await evaluate('document.querySelector(\'button[aria-label="AutoMix"]\')?.closest(".setting-item")?.textContent ?? ""') : undefined
      const playerBar=report.playerBar ? await evaluate('(()=>{const p=window.__autoMixProbePlayer;'+
        'const bar=document.querySelector(".progress-area"),slider=bar?.querySelector(".progress-slider");'+
        'return JSON.parse(JSON.stringify({trackId:p.currentTrack.value?.id,queueIndex:p.queueIndex.value,position:p.currentTime.value,'+
        'clock:p.playbackClockSnapshot.value,domTrackId:bar?.dataset.trackId,'+
        'domPosition:slider?Number(slider.getAttribute("aria-valuenow")):null,'+
        'labels:bar?[...bar.querySelectorAll(".time-label")].map(e=>e.textContent):[]}));})()') : undefined
      report.observations.push({position:info.position,queueIndex:info.queueIndex,source:info.source,playerBar,settingsText,
        autoMix:info.autoMix,perfectReasonCode:info.perfectReasonCode,
        preloadReady:info.preloadReady,gaplessActive:info.gaplessActive,gaplessBlockedReason:info.gaplessBlockedReason,
        upcomingTrack:info.upcomingTrack})
      if(info.source===outgoing)report.lastOutgoingPosition=info.position
      if(info.autoMix?.state==='mixing') {
        mixed=true
        overlapSeconds=info.autoMix.incomingResumeSeconds ?? info.autoMix.transitionSeconds
        const required=${JSON.stringify(option('--require-style'))}
        if(required)assert.equal(info.autoMix.styleId,Number(required))
        const requiredKind=${JSON.stringify(option('--require-mix-kind'))}
        if(requiredKind)assert.equal(info.autoMix.mixKind,requiredKind)
        const minimumOverlap=Number(${JSON.stringify(option('--min-audible-overlap','0'))})
        assert.ok((info.autoMix.audibleOverlapSeconds ?? 0)>=minimumOverlap,'Prepared dual-track overlap too short')
        const minimumTempo=Number(${JSON.stringify(option('--min-tempo-adjustment','0'))})
        assert.ok((info.autoMix.tempoAdjustmentPercent ?? 0)>=minimumTempo,'Tempo compensation was not used')
        if(settingsText) {
          const label={beat_mix:'节拍混合',musical_overlap:'音乐交叠',boundary_cleanup:'首尾静音',conservative:'保守淡化'}[info.autoMix.mixKind]
          if(label&&settingsText.includes(label)&&(!['beat_mix','musical_overlap'].includes(info.autoMix.mixKind)||settingsText.includes('双轨交叠')))
            report.settingsStatusVerified=true
        }
        // Settings intentionally hides PlayerBar. Return after checking its
        // AutoMix copy so the later source-clock assertion uses the visible bar.
        if(report.settingsStatusVerified&&report.playerBar&&!report.settingsClosed) {
          await evaluate('document.querySelector(\'button[aria-label="设置"]\').click()')
          report.settingsClosed=true
        }
        if(info.autoMix.progress>.06)assert.equal(info.perfectReasonCode,'automix_active')
      }
      if(info.queueIndex!==previousIndex) {switches++;previousIndex=info.queueIndex}
      if(info.source===incoming) {
        promoted=true
        incomingObservedAt ||= Date.now()
        report.finalPlayback=info
        if(!report.playerBar||playerBar.trackId===queue[1].id) {
          if(report.playerBar) {
            assert.equal(playerBar.domTrackId,queue[1].id,'Playbar retained the outgoing track')
            assert.ok(Math.abs(playerBar.domPosition-info.position)<.6,'Playbar retained the outgoing clock')
            assert.ok(playerBar.domPosition>=overlapSeconds-.1,'Playbar reset the already audible incoming portion')
            report.finalPlayerBar=playerBar
          }
          if(!report.playerBar||Date.now()-incomingObservedAt>=2000)break
        }
      }
      await pause(100)
    }
    assert.ok(mixed,'No native AutoMix overlap observed')
    if(${args.includes('--settings-status')})assert.ok(report.settingsStatusVerified,'Rendered settings did not distinguish the actual musical mix kind')
    assert.ok(promoted,'Incoming track was not promoted')
    if(report.playerBar)assert.ok(report.finalPlayerBar,'Renderer never promoted the incoming track')
    assert.equal(switches,1)
    assert.ok(report.finalPlayback.position>=overlapSeconds-.1,'Incoming audible overlap was replayed')
    if(report.expectedOutgoingEnd!==null) {
      assert.ok(Math.abs(report.lastOutgoingPosition-report.expectedOutgoingEnd)<.6,
        'Handoff did not use the planned outgoing source boundary')
    }
    if(report.expectedIncomingStart!==null) {
      const firstIncoming=report.observations.find(x=>x.source===incoming)
      const continuation=overlapSeconds
      assert.ok(firstIncoming.position>=continuation-.1&&firstIncoming.position<continuation+.6,
        'Incoming handoff did not include both skipped silence and audible overlap')
    }
    report.passed=true
  } catch(error) { report.error=error.stack }
  finally {
    if(evaluate) await evaluate('window.api.audioEngine.stop()').catch(()=>{})
    clearTimeout(watchdog)
    fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n')
    app.exit(report.passed?0:1)
  }
})
`
const entry = join(work, 'runner.cjs')
writeFileSync(entry, runner)
const syntax = spawnSync(process.execPath, ['--check', entry], {
  encoding: 'utf8',
  windowsHide: true
})
if (syntax.status !== 0) throw new Error(syntax.stderr)
const env = { ...process.env }
for (const key of [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_RENDERER_URL',
  'TAE_AUTOMIX_EXPERIMENTAL',
  'TWILIGHT_AUDIO_SERVICE',
  'TWILIGHT_AUDIO_SERVICE_NODE'
])
  delete env[key]
;(async () => {
  let server
  try {
    if (args.includes('--player-bar')) {
      const { createServer } = await import('vite')
      const { default: vue } = await import('@vitejs/plugin-vue')
      server = await createServer({
        configFile: false,
        root: join(root, 'src', 'renderer'),
        resolve: { alias: { '@renderer': join(root, 'src', 'renderer', 'src') } },
        publicDir: join(root, 'resources'),
        plugins: [vue()],
        server: { host: '127.0.0.1', port: 0 }
      })
      await server.listen()
      env.ELECTRON_RENDERER_URL = server.resolvedUrls.local[0]
    }
    const run = await new Promise((resolveRun, reject) => {
      const child = spawn(require('electron'), [entry], {
        cwd: appPath,
        env,
        windowsHide: true,
        timeout: 75000
      })
      let stdout = '',
        stderr = ''
      child.stdout.on('data', (data) => (stdout += data))
      child.stderr.on('data', (data) => (stderr += data))
      child.on('error', reject)
      child.on('close', (status) => resolveRun({ status, stdout, stderr }))
    })
    writeFileSync(join(work, 'stdout.log'), run.stdout)
    writeFileSync(join(work, 'stderr.log'), run.stderr)
    let report
    try {
      report = JSON.parse(readFileSync(reportFile, 'utf8'))
    } catch {}
    console.log(
      JSON.stringify(
        {
          passed: run.status === 0 && report?.passed === true,
          report: reportFile,
          work,
          error: report?.error
        },
        null,
        2
      )
    )
    process.exitCode = run.status === 0 && report?.passed === true ? 0 : 1
  } finally {
    await server?.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
