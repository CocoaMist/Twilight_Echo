// Packaged app integration: real main/preload/settings UI, ZIP extraction,
// checkpoint verification and CPU/CUDA probe. Only native picker selection and
// window visibility are adapted; no runtime or capabilities are mocked.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function parse(argv) {
  const options = {}
  argv = argv.filter((value) => !value.startsWith('--user-data-dir='))
  for (let i = 0; i < argv.length; i += 2) {
    assert.ok(
      ['--package', '--zip', '--output', '--scratch', '--profile', '--restore'].includes(argv[i])
    )
    assert.ok(argv[i + 1])
    options[argv[i].slice(2)] = argv[i + 1]
  }
  assert.ok(options.package && options.zip && options.output)
  return options
}

async function runElectron(options) {
  const { app, BrowserWindow, dialog } = require('electron')
  const resources = path.resolve(options.package, 'resources'),
    archive = path.join(resources, 'app.asar')
  app.setPath('userData', options.profile)
  app.setAppPath(archive)
  Object.defineProperty(process, 'resourcesPath', { value: resources })
  app.on('browser-window-created', (_event, window) =>
    window.webContents.setBackgroundThrottling(false)
  )
  BrowserWindow.prototype.show = function () {
    /* Keep the real application hidden during the smoke. */
  }
  BrowserWindow.prototype.showInactive = function () {
    /* Keep auxiliary windows hidden as well. */
  }
  let cancelPicker = false
  const report = {
    passed: false,
    startedAt: new Date().toISOString(),
    restore: options.restore === '1',
    scope:
      'Real packaged settings UI and ZIP installer; only picker choice and window visibility adapted',
    pickerCalls: 0,
    statusPhases: [],
    geometry: [],
    profile: options.profile
  }
  const save = () => fs.writeFileSync(options.output, JSON.stringify(report, null, 2))
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const deadline = Date.now() + 12 * 60_000
  const poll = async (read, accepts, description) => {
    let last
    while (Date.now() < deadline) {
      last = await read()
      if (accepts(last)) return last
      await sleep(200)
    }
    throw new Error(`${description}: ${JSON.stringify(last)}`)
  }
  dialog.showOpenDialog = async (...args) => {
    const value = args.at(-1)
    assert.deepEqual(value.properties, ['openFile'])
    assert.deepEqual(value.filters[0].extensions, ['zip'])
    report.pickerCalls++
    save()
    return { canceled: cancelPicker, filePaths: cancelPicker ? [] : [path.resolve(options.zip)] }
  }
  const fatal = setTimeout(
    () => {
      report.error = 'Install smoke deadline exceeded'
      save()
      app.exit(1)
    },
    12 * 60_000 + 5000
  )
  try {
    require(path.join(archive, 'out/main/index.js'))
    const window = await poll(
      () =>
        BrowserWindow.getAllWindows().find((value) =>
          /\/renderer\/index\.html/.test(value.webContents.getURL().replaceAll('\\', '/'))
        ),
      (value) => Boolean(value && !value.webContents.isLoading()),
      'Renderer did not load'
    )
    window.setSize(1280, 900)
    const evaluate = async (code) => {
      const result = await window.webContents.executeJavaScript(
        `(async()=>{try{return {ok:true,value:await (${code})}}catch(error){return {ok:false,error:error.stack || String(error)}}})()`
      )
      if (!result.ok) throw new Error(result.error)
      return result.value
    }
    await poll(
      () =>
        evaluate('Boolean(window.api?.settings && document.querySelector("button.settings-btn"))'),
      Boolean,
      'Settings entry unavailable'
    )
    await evaluate(
      `(()=>{const button=document.querySelector('button.settings-btn');if(button.getAttribute('aria-pressed')!=='true')button.click()})()`
    )
    await poll(
      () => evaluate('Boolean(document.querySelector(".preview-nav-item"))'),
      Boolean,
      'Settings page unavailable'
    )
    await evaluate(
      `Array.from(document.querySelectorAll('.preview-nav-item')).find(button=>button.textContent.includes('播放与音效')).click()`
    )
    await poll(
      () => evaluate('Boolean(document.querySelector("[data-action=install-stem-pack]"))'),
      Boolean,
      'Installer missing from full settings page'
    )
    const initial = await evaluate('window.api.settings.get()')
    const capabilities = await evaluate('window.api.audioEngine.getAutoMixStemCapabilities()')
    report.initialCapabilities = capabilities
    if (report.restore) {
      assert.equal(capabilities.status, 'ready')
      assert.equal(capabilities.cpu, true)
      assert.equal(initial.settings.autoMixStemMode, 'auto')
      assert.equal(initial.settings.autoMixStemDevice, 'auto')
      assert.equal(initial.settings.autoMixMode, 'dj')
      report.persistedPreferences = initial.settings
    } else {
      assert.equal(capabilities.status, 'missing')
      const ui = await evaluate(`({
        devices:Array.from(document.querySelector('[data-setting-id=autoMixStemDevice] select').options).map(value=>value.value),
        disabled:document.querySelector('[data-setting-id=autoMixStemDevice] select').disabled,
        switchPresent:Boolean(document.querySelector('[data-setting-id=autoMixStemMode] [role=switch]'))
      })`)
      assert.deepEqual(ui.devices, ['auto', 'gpu', 'cpu'])
      assert.ok(ui.disabled && ui.switchPresent)
      report.missingPackUi = ui
    }
    const checkCenter = async (selector) => {
      const value =
        await evaluate(`(()=>{const dialog=document.querySelector(${JSON.stringify(selector)}),bounds=dialog.getBoundingClientRect();return {
        open:dialog.open,x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height,
        viewportWidth:document.documentElement.clientWidth,viewportHeight:document.documentElement.clientHeight,
        text:dialog.textContent}})()`)
      assert.ok(value.open)
      assert.ok(
        Math.abs(value.x + value.width / 2 - value.viewportWidth / 2) < 2,
        JSON.stringify(value)
      )
      assert.ok(
        Math.abs(value.y + value.height / 2 - value.viewportHeight / 2) < 2,
        JSON.stringify(value)
      )
      report.geometry.push(value)
      save()
    }
    if (!report.restore) {
      await evaluate(`document.querySelector('[data-action=install-stem-pack]').click()`)
      const installSelector = 'dialog[aria-labelledby=automix-install-title]'
      await checkCenter(installSelector)
      // Check centering after resizing and scrolling the actual settings page.
      window.setSize(900, 680)
      await sleep(100)
      await evaluate(`document.querySelector('.settings-preview-page').scrollTop=600`)
      await checkCenter(installSelector)
      window.setSize(1280, 900)
      await sleep(100)
      const chooseZip = async (enable) =>
        evaluate(
          `(()=>{const dialog=document.querySelector('dialog[aria-labelledby=automix-install-title]'),checkbox=dialog.querySelector('input');checkbox.checked=${enable};checkbox.dispatchEvent(new Event('change',{bubbles:true}));dialog.querySelector('[data-action=choose-stem-zip]').click()})()`
        )
      cancelPicker = true
      await chooseZip(true)
      await poll(
        () => evaluate('window.api.audioEngine.getAutoMixStemInstallStatus()'),
        (value) => value.phase === 'cancelled',
        'Picker cancellation failed'
      )
      assert.equal((await evaluate('window.api.settings.get()')).settings.autoMixStemMode, 'off')
      cancelPicker = false
      await evaluate(`document.querySelector('[data-action=install-stem-pack]').click()`)
      await chooseZip(true)
      const installed = await poll(
        async () => {
          const value = await evaluate('window.api.audioEngine.getAutoMixStemInstallStatus()')
          if (report.statusPhases.at(-1)?.phase !== value.phase) {
            report.statusPhases.push({ phase: value.phase, time: new Date().toISOString() })
            save()
            console.log('Installation phase: ' + value.phase)
          }
          if (value.phase === 'failed' || value.phase === 'cancelled')
            throw new Error(JSON.stringify(value))
          return value
        },
        (value) => value.phase === 'ready',
        'Real ZIP installation failed'
      )
      assert.equal(installed.completedBytes, installed.totalBytes)
      assert.ok(installed.capabilities.cpu)
      report.installed = installed
      report.detected = await evaluate('window.api.audioEngine.getAutoMixStemCapabilities(true)')
      assert.equal(report.detected.status, 'ready')
      assert.equal(report.detected.cpu, true)
      await poll(
        () => evaluate('window.api.settings.get()'),
        (value) => value.settings.autoMixStemMode === 'auto',
        'Install enable choice was not persisted'
      )
      await poll(
        () =>
          evaluate(
            `!document.querySelector('[data-setting-id=autoMixStemDevice] select').disabled`
          ),
        Boolean,
        'Compute device UI stayed disabled'
      )
      report.readyUi =
        await evaluate(`({gpuDisabled:document.querySelector('[data-setting-id=autoMixStemDevice] option[value=gpu]').disabled,
        cpuDisabled:document.querySelector('[data-setting-id=autoMixStemDevice] option[value=cpu]').disabled,
        enabled:document.querySelector('[data-setting-id=autoMixStemMode] [role=switch]').getAttribute('aria-checked'),
        resourceNotice:document.querySelector('[data-setting-id=autoMixStemMode]').textContent.includes('显存')})`)
      assert.equal(report.readyUi.gpuDisabled, !report.detected.gpu)
      assert.equal(report.readyUi.cpuDisabled, false)
      assert.equal(report.readyUi.enabled, 'true')
      assert.ok(report.readyUi.resourceNotice)
      await evaluate(
        `(()=>{const select=document.querySelector('select[aria-label="Twilight AutoMix 模式"]');select.value='dj';select.dispatchEvent(new Event('change',{bubbles:true}))})()`
      )
      await checkCenter('dialog[aria-labelledby=automix-dj-title]')
      assert.equal((await evaluate('window.api.settings.get()')).settings.autoMixMode, 'off')
      await evaluate(`document.querySelector('[data-action=confirm-dj-mode]').click()`)
      await poll(
        () => evaluate('window.api.settings.get()'),
        (value) => value.settings.autoMixMode === 'dj',
        'DJ confirmation did not save mode'
      )
    }
    if (report.restore) {
      await evaluate(`document.querySelector('[data-action=install-stem-pack]').click()`)
      await checkCenter('dialog[aria-labelledby=automix-install-title]')
      await evaluate(
        `document.querySelector('dialog[aria-labelledby=automix-install-title]').close()`
      )
      await evaluate(
        `(()=>{const select=document.querySelector('select[aria-label="Twilight AutoMix 模式"]');select.value='natural';select.dispatchEvent(new Event('change',{bubbles:true}))})()`
      )
      await poll(
        () => evaluate('window.api.settings.get()'),
        (value) => value.settings.autoMixMode === 'natural',
        'Natural selection failed'
      )
      await evaluate(
        `(()=>{const select=document.querySelector('select[aria-label="Twilight AutoMix 模式"]');select.value='dj';select.dispatchEvent(new Event('change',{bubbles:true}))})()`
      )
      await checkCenter('dialog[aria-labelledby=automix-dj-title]')
      await evaluate(`document.querySelector('[data-action=confirm-dj-mode]').click()`)
      await poll(
        () => evaluate('window.api.settings.get()'),
        (value) => value.settings.autoMixMode === 'dj',
        'Restored DJ confirmation failed'
      )
    }
    report.passed = true
    report.completedAt = new Date().toISOString()
    save()
    console.log(
      JSON.stringify({
        passed: true,
        restore: report.restore,
        gpu: capabilities.gpu || report.detected?.gpu
      })
    )
    clearTimeout(fatal)
    app.exit(0)
  } catch (error) {
    report.error = error.stack || String(error)
    save()
    console.error(report.error)
    clearTimeout(fatal)
    app.exit(1)
  }
}

function runNode(options) {
  assert.ok(options.scratch)
  fs.mkdirSync(options.scratch, { recursive: true })
  fs.mkdirSync(path.dirname(options.output), { recursive: true })
  const profile = fs.mkdtempSync(path.join(path.resolve(options.scratch), 'stem-install-profile-'))
  fs.writeFileSync(
    path.join(profile, 'settings.json'),
    JSON.stringify({
      onboardingCompleted: true,
      startupHomePage: 'local',
      autoMixMode: 'off',
      autoMixStemMode: 'off',
      autoMixStemDevice: 'auto',
      softwareVolume: 0,
      audioExclusiveMode: false,
      globalShortcutsEnabled: false,
      windowTransparency: false,
      motionPreference: 'reduced',
      closeWindowBehavior: 'quit',
      libraryFolders: []
    })
  )
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.TWILIGHT_AUTOMIX_STEM_PACK
  const phases = []
  for (const restore of ['0', '1']) {
    const output = options.output + '.' + restore + '.json'
    const result = spawnSync(
      require('electron'),
      [
        __filename,
        `--user-data-dir=${profile}`,
        '--package',
        path.resolve(options.package),
        '--zip',
        path.resolve(options.zip),
        '--output',
        path.resolve(output),
        '--profile',
        profile,
        '--restore',
        restore
      ],
      { cwd: process.cwd(), env, windowsHide: true, encoding: 'utf8', timeout: 13 * 60_000 }
    )
    console.log(result.stdout || '')
    if (result.stderr) console.error(result.stderr)
    assert.ifError(result.error)
    assert.equal(result.status, 0, 'Stem installer packaged smoke failed')
    const report = JSON.parse(fs.readFileSync(output))
    assert.ok(report.passed, report.error)
    phases.push(report)
  }
  fs.writeFileSync(
    options.output,
    JSON.stringify(
      {
        passed: true,
        profile,
        package: path.resolve(options.package),
        zip: path.resolve(options.zip),
        phases
      },
      null,
      2
    )
  )
}
if (require.main === module || process.versions.electron) {
  const options = parse(process.argv.slice(2))
  if (process.versions.electron) void runElectron(options)
  else runNode(options)
}
