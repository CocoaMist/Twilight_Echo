// Real application + utility-process + renderer check. No music is played.
// Requires an already built app and staged experimental Windows x64 runtime.
const { spawnSync } = require('node:child_process')
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

const root = resolve(__dirname, '..')
const work = mkdtempSync(join(tmpdir(), 'twilight-automix-controls-'))
const reportIndex = process.argv.indexOf('--report')
const reportFile =
  reportIndex < 0 ? join(work, 'report.json') : resolve(process.argv[reportIndex + 1])
const rendererIndex = process.argv.indexOf('--renderer-url')
const rendererUrl = rendererIndex < 0 ? '' : process.argv[rendererIndex + 1]
const delayIndex = process.argv.indexOf('--delay-renderer-ms')
const rendererDelay = delayIndex < 0 ? 0 : Number(process.argv[delayIndex + 1])
if (!Number.isFinite(rendererDelay) || rendererDelay < 0 || rendererDelay > 5000)
  throw new Error('Renderer delay must be between 0 and 5000 milliseconds')
if (rendererUrl && !['localhost', '127.0.0.1'].includes(new URL(rendererUrl).hostname))
  throw new Error('The development renderer must be served locally')
const profile = join(work, 'profile')
mkdirSync(profile)
writeFileSync(
  join(profile, 'settings.json'),
  JSON.stringify({
    onboardingCompleted: true,
    autoCheckLogin: false,
    playbackResumeMode: 'off',
    audioProcessing: {
      autoMix: { enabled: false, allowIntelligentSkip: false, maxTransitionSeconds: 4 }
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
const report = { format: 1, passed: false, kind: 'real-app-automix-settings-controls',
  isolatedProfile: ${JSON.stringify(profile)}, playbackStarted: false,
  developmentRenderer: ${JSON.stringify(rendererUrl)},
  rendererDelayMilliseconds: ${JSON.stringify(rendererDelay)},
  experimentalStartupFlag: process.env.TAE_AUTOMIX_EXPERIMENTAL ?? null }
app.setAppPath(root)
app.setPath('userData', report.isolatedProfile)
app.disableHardwareAcceleration()
app.on('browser-window-created', (_event, window) => {
  // This fixture owns these windows and keeps the whole app off the desktop.
  window.show = () => {}
  window.showInactive = () => {}
  if (report.rendererDelayMilliseconds) {
    for (const name of ['loadURL', 'loadFile']) {
      const load = window.webContents[name].bind(window.webContents)
      window.webContents[name] = (...args) => new Promise((resolve, reject) => {
        setTimeout(() => load(...args).then(resolve, reject), report.rendererDelayMilliseconds)
      })
    }
  }
})
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(check, description) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await pause(100)
  }
  throw new Error('Timed out: ' + description)
}
const watchdog = setTimeout(() => {
  report.error = 'Application smoke watchdog expired'
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n')
  app.exit(1)
}, 55000)
require(path.join(root, 'out/main/index.js'))
app.whenReady().then(async () => {
  try {
    assert.equal(report.experimentalStartupFlag, null)
    const window = await waitFor(() => BrowserWindow.getAllWindows().find(window =>
      report.developmentRenderer ? window.webContents.getURL().startsWith(report.developmentRenderer)
        : window.webContents.getURL().includes('/renderer/index.html')), 'main renderer')
    const evaluate = code => window.webContents.executeJavaScript(code)
    await waitFor(() => evaluate('Boolean(window.api?.audioEngine && document.querySelector(\'button[aria-label="设置"]\'))'), 'renderer API and settings button')
    await evaluate('document.querySelector(\'button[aria-label="设置"]\').click()')
    await waitFor(() => evaluate('Boolean(document.querySelector(\'.preview-nav-item\'))'), 'settings sections')
    await evaluate('Array.from(document.querySelectorAll(\'.preview-nav-item\')).find(button => ["播放", "播放与音效"].includes(button.textContent.trim())).click()')
    await waitFor(() => evaluate('Boolean(document.querySelector(\'button[aria-label="AutoMix"]\'))'), 'AutoMix control')
    await evaluate('(() => {const button=document.querySelector(\'button[aria-label="AutoMix"]\').closest(".settings-group")?.querySelector(".settings-group-trigger");if(button?.getAttribute("aria-expanded")==="false")button.click()})()')
    const control = () => evaluate('(() => { const button = document.querySelector(\'button[aria-label="AutoMix"]\'); return {disabled: button.disabled, checked: button.getAttribute("aria-checked"), text: button.closest(".setting-item").textContent} })()')
    report.before = await waitFor(async () => {
      const state = await control()
      return !state.disabled && state
    }, 'AutoMix enabled control before first Play')
    assert.equal(report.before.checked, 'false')
    assert.ok(!report.before.text.includes('当前音频引擎未开放 AutoMix'))
    report.initial = await evaluate('window.api.audioEngine.getPlaybackInfo()')
    assert.equal(report.initial.autoMix?.experimentalAllowed, true)
    assert.equal(report.initial.autoMix.enabled, false)
    assert.equal(report.initial.state, 'stopped')
    report.skipControl = await evaluate('(() => {const input=document.querySelector(\'button[aria-label="AutoMix"]\').closest(".setting-item").querySelector(\'input[type="checkbox"]\');return {disabled:input.disabled,checked:input.checked}})()')
    assert.equal(report.skipControl.disabled, report.initial.autoMix?.intelligentSkipSupported !== true)
    if (!report.skipControl.disabled) {
      await evaluate('document.querySelector(\'button[aria-label="AutoMix"]\').closest(".setting-item").querySelector(\'input[type="checkbox"]\').click()')
      await waitFor(async () => {
        const processing = await evaluate('window.api.audioEngine.getAudioProcessing()')
        return processing.autoMix?.allowIntelligentSkip === true && !(await control()).disabled
      }, 'Intelligent silence skipping setting acknowledgement')
    }
    await evaluate('document.querySelector(\'button[aria-label="AutoMix"]\').click()')
    report.afterEnable = await waitFor(async () => {
      const info = await evaluate('window.api.audioEngine.getPlaybackInfo()')
      const ui = await control()
      return info.autoMix?.enabled === true && ui.checked === 'true' && !ui.disabled && {info, ui}
    }, 'UI and native enable acknowledgement')
    assert.equal(report.afterEnable.info.state, 'stopped')
    await evaluate('document.querySelector(\'button[aria-label="AutoMix"]\').click()')
    report.afterDisable = await waitFor(async () => {
      const info = await evaluate('window.api.audioEngine.getPlaybackInfo()')
      const ui = await control()
      return info.autoMix?.enabled === false && ui.checked === 'false' && !ui.disabled && {info, ui}
    }, 'UI and native disable acknowledgement')
    assert.equal(report.afterDisable.info.state, 'stopped')
    assert.equal(report.afterDisable.info.source, '')
    report.passed = true
  } catch (error) {
    report.error = error.stack
    const window = BrowserWindow.getAllWindows().find(window => !window.isDestroyed())
    if (window) {
      try {
        report.failureNativeStatus = await window.webContents.executeJavaScript('window.api.audioEngine.getPlaybackInfo()')
        report.failureControl = await window.webContents.executeJavaScript('(() => {const b=document.querySelector(\'button[aria-label="AutoMix"]\');return b ? {disabled:b.disabled,text:b.closest(".setting-item").textContent}:null})()')
      } catch {}
    }
  } finally {
    clearTimeout(watchdog)
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n')
    app.exit(report.passed ? 0 : 1)
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
for (const name of [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_RENDERER_URL',
  'TAE_AUTOMIX_EXPERIMENTAL',
  'TWILIGHT_AUDIO_SERVICE',
  'TWILIGHT_AUDIO_SERVICE_NODE'
])
  delete env[name]
if (rendererUrl) env.ELECTRON_RENDERER_URL = rendererUrl
const run = spawnSync(require('electron'), [entry], {
  cwd: root,
  env,
  windowsHide: true,
  timeout: 60000,
  encoding: 'utf8'
})
writeFileSync(join(work, 'stdout.log'), run.stdout ?? '')
writeFileSync(join(work, 'stderr.log'), run.stderr ?? '')
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
      error: report?.error ?? run.error?.message
    },
    null,
    2
  )
)
process.exitCode = run.status === 0 && report?.passed === true ? 0 : 1
