import { createApp, h, nextTick, ref } from 'vue'
import { createPinia, defineStore } from 'pinia'
import OnboardingWizard from './OnboardingWizard.vue'
import TitleBar from '../TitleBar.vue'
import { pushBackHandler } from '../../app/useBackStack.ts'
import { useSettingsStore as realSettingsStore } from '../../stores/useSettingsStore.ts'
import '../../assets/base.css'
import '../../assets/icon-fonts.ts'

const actual = realSettingsStore()
const settings = actual.settings
settings.value.motionPreference = 'off'
document.documentElement.dataset.teMotion = 'off'
settings.value.theme = 'pureWhite'
settings.value.libraryFolders = [
  'D:\\Music\\收藏与高解析音乐\\夜色渐深',
  'E:\\音乐\\原声与现场录音'
]
settings.value.watchLibrary = false
settings.value.ncmPlaybackQuality = 'hires'
settings.value.playbackResumeMode = 'trackAndPosition'
settings.value.closeWindowBehavior = 'tray'
const seed = JSON.parse(JSON.stringify(settings.value))
const noop = async () => undefined
const volume = ref(0.35)
export const useSettingsStore = () => ({
  ...actual,
  updateSettings: async (patch) => {
    settings.value = { ...settings.value, ...patch }
    return settings.value
  },
  importBackgroundImage: async () => null,
  addLibraryFolder: async () => {
    settings.value.libraryFolders.push('F:\\Music\\新文件夹')
  },
  removeLibraryFolder: async (folder) => {
    settings.value.libraryFolders = settings.value.libraryFolders.filter(
      (value) => value !== folder
    )
  }
})
export const useMusicStore = () => ({
  tracks: ref([]),
  libraryTrackCount: ref(300_000),
  libraryScanProgress: ref(null)
})
export const usePlayerStore = () => ({
  volume,
  setVolume: (value) => {
    volume.value = value
  }
})
export const useNcmStore = () => ({ isLoggedIn: ref(false), profile: ref(null) })
export const useProviderStore = () => ({
  providers: ref([{ id: 'ncm', name: '网易云音乐', capabilities: ['login'] }])
})
export const useAudioOutputDspStore = defineStore('onboarding-audio', () => {
  const audioDevice = ref('auto'),
    audioOutput = ref('wasapi')
  const audioOutputDeviceOptions = ref([
    { id: 'auto', label: '系统默认输出', isDefault: true },
    {
      id: 'usb-dac',
      label: 'USB DAC · 耳机输出',
      channels: 2,
      sampleRates: [44100, 96000, 192000],
      bitDepths: [24, 32],
      supportsExclusive: true
    }
  ])
  const audioProcessing = ref({ volumeNormalization: 'off' })
  return {
    audioDevice,
    audioOutput,
    audioOutputDeviceOptions,
    audioProcessing,
    audioOutputOptions: ref([{ id: 'wasapi', supportsExclusive: true }]),
    setAudioDevice: async (id) => {
      audioDevice.value = id
    },
    refreshAudioOutputState: noop,
    setReplayGainMode: async (mode) => {
      audioProcessing.value.volumeNormalization = mode
    }
  }
})

let pendingTone,
  rejectTone = false,
  toneCalls = 0,
  stopCalls = 0
const windowCalls = { close: 0, minimize: 0, maximize: 0 }
window.api = {
  window: {
    close: () => windowCalls.close++,
    minimize: () => windowCalls.minimize++,
    toggleMaximize: () => windowCalls.maximize++,
    getState: async () => ({ maximized: false })
  },
  audioEngine: {
    testOutput: async () => {
      toneCalls++
      if (rejectTone) {
        rejectTone = false
        throw new Error('测试设备连接失败，请重试')
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingTone = null
          resolve({ cancelled: false })
        }, 150)
        pendingTone = () => {
          clearTimeout(timer)
          pendingTone = null
          resolve({ cancelled: true })
        }
      })
    },
    stopOutputTest: async () => {
      stopCalls++
      pendingTone?.()
    }
  },
  desktopLyrics: { setEnabled: async (enabled) => enabled }
}
const ipc = window.onboardingTestIpc
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const tick = async () => {
  await nextTick()
  await pause(20)
  await nextTick()
}
const expect = (value, message) => {
  if (!value) throw new Error(message)
}
const until = async (predicate, message) => {
  for (let i = 0; i < 100; i++) {
    await tick()
    if (predicate()) return
  }
  throw new Error(message)
}
const stage = () => document.querySelector('.onb-stage')
const capture = async (label) => {
  await pause(100)
  await ipc.invoke('onboarding-capture', label)
}
const findButton = (text, root = document) =>
  [...root.querySelectorAll('button')].find((button) => button.textContent.trim().includes(text))
const settled = () =>
  until(
    () =>
      !document.querySelector(
        '.onb-fwd-leave-active,.onb-back-leave-active,.onb-fwd-enter-active,.onb-back-enter-active'
      ),
    'scene did not settle'
  )
const click = async (text, root) => {
  await until(() => findButton(text, root), 'missing button: ' + text)
  const button = findButton(text, root)
  button.click()
  await tick()
  await settled()
}
const advance = async () => {
  document.querySelector('.onb-btn-primary').click()
  await tick()
  await settled()
}
const go = async (title) => {
  const button = document.querySelector('.onb-dot[title="' + title + '"]')
  expect(button && !button.disabled, 'unreachable step ' + title)
  button.click()
  await tick()
  await settled()
}
let app,
  results = [],
  saving = ref(false),
  saveError = ref(''),
  wizardVisible = ref(true)
function theme(dark) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'pureWhite'
  settings.value.theme = dark ? 'dark' : 'pureWhite'
  document.documentElement.style.setProperty('--te-primary-500', dark ? '#d4b56a' : '#7c4dff')
  document.documentElement.style.setProperty(
    '--te-primary-rgb',
    dark ? '212,181,106' : '124,77,255'
  )
  document.documentElement.style.setProperty('--te-app-bg', dark ? '#131316' : '#f4f4f8')
}
function mount() {
  app?.unmount()
  document.querySelector('#app').innerHTML = ''
  settings.value = JSON.parse(JSON.stringify(seed))
  theme(false)
  results = []
  saving.value = false
  saveError.value = ''
  wizardVisible.value = true
  app = createApp({
    render: () => [
      h(TitleBar, { menuOpen: false, closeOnly: wizardVisible.value }),
      wizardVisible.value &&
        h(OnboardingWizard, {
          saving: saving.value,
          saveError: saveError.value,
          onFinish: (result) => {
            results.push(JSON.parse(JSON.stringify(result)))
            saving.value = true
          }
        })
    ]
  }).use(createPinia())
  app.mount('#app')
}
async function reachPlayer(usage = '两者都要') {
  mount()
  await advance()
  await click(usage)
  await advance()
  while (!stage().querySelector('.onb-player-shape-cards')) await advance()
}
function geometry() {
  const footer = document.querySelector('.onb-footer').getBoundingClientRect()
  expect(footer.bottom <= innerHeight + 1 && footer.top > 0, 'footer clipped')
  for (const element of document.querySelectorAll(
    '.onb-summary, .onb-player-shape-cards, .onb-device-panel'
  )) {
    const box = element.getBoundingClientRect()
    expect(box.left >= -1 && box.right <= innerWidth + 1, 'panel horizontally clipped')
  }
  expect(
    stage().scrollWidth <= stage().clientWidth + 1,
    'stage horizontal overflow: ' +
      innerWidth +
      ' ' +
      stage().scrollWidth +
      '/' +
      stage().clientWidth +
      ' ' +
      [...stage().children]
        .map(
          (e) =>
            e.className +
            ':' +
            Math.round(e.getBoundingClientRect().left) +
            '/' +
            Math.round(e.getBoundingClientRect().right)
        )
        .join(', ')
  )
}
window.runOnboardingTests = async () => {
  mount()
  const disposeBack = pushBackHandler(() => undefined, '返回已有页面')
  await tick()
  const chrome = document.querySelector('.title-bar')
  expect(
    chrome.querySelectorAll('button').length === 1 && chrome.querySelector('.close'),
    'wizard exposed title bar controls other than close'
  )
  expect(!chrome.querySelector('.title-bar-background'), 'wizard retained title bar surface')
  expect(getComputedStyle(chrome).webkitAppRegion === 'drag', 'wizard cannot be dragged')
  const closeButton = chrome.querySelector('.close')
  expect(!closeButton.disabled, 'wizard close control is disabled')
  closeButton.click()
  expect(windowCalls.close === 1, 'wizard close failed to call native window API')
  settings.value.startupHomePage = 'streaming'
  await click('跳过引导')
  expect(
    JSON.stringify(results[0].patch) === '{"onboardingCompleted":true}' &&
      results[0].action === 'streaming',
    'skip overwrote existing settings or destination'
  )
  mount()
  await advance()
  await click('本地音乐')
  await advance()
  await click('保存并开始使用')
  expect(
    results[0].patch.watchLibrary === false &&
      !('audioExclusiveMode' in results[0].patch) &&
      !('playerBar' in results[0].patch),
    'early exit wrote unvisited defaults'
  )
  await reachPlayer()
  expect(!document.querySelector('.onb-player-preview'), 'player illustration was not removed')
  expect(
    document
      .querySelector('.onb-player-shape-cards [aria-checked="true"]')
      .textContent.includes('标准播放栏'),
    'home default is not standard'
  )
  await capture('player-home-light')
  await click('播放页', document.querySelector('[aria-label="设置页面"]'))
  expect(
    document
      .querySelector('.onb-player-shape-cards [aria-checked="true"]')
      .textContent.includes('紧凑模式'),
    'playing page default is not compact'
  )
  await capture('player-playing-light')
  await click('迷你胶囊', document.querySelector('.onb-player-shape-cards'))
  await click('主页', document.querySelector('[aria-label="设置页面"]'))
  expect(
    document
      .querySelector('.onb-player-shape-cards [aria-checked="true"]')
      .textContent.includes('标准播放栏'),
    'playing page edit changed home'
  )
  await click('播放页', document.querySelector('[aria-label="设置页面"]'))
  expect(
    document
      .querySelector('.onb-player-shape-cards [aria-checked="true"]')
      .textContent.includes('迷你胶囊'),
    'playing page edit lost'
  )
  await click('紧凑模式', document.querySelector('.onb-player-shape-cards'))
  await click('主页', document.querySelector('[aria-label="设置页面"]'))
  for (const label of ['标准播放栏', '迷你胶囊', '紧凑模式']) {
    await click(label, document.querySelector('.onb-player-shape-cards'))
    expect(
      document
        .querySelector('.onb-player-shape-cards [aria-checked="true"]')
        .textContent.includes(label),
      'selected card does not reflect shape'
    )
  }
  await click('迷你胶囊', document.querySelector('.onb-player-shape-cards'))
  await click('指针靠近时浮现')
  expect(
    findButton('指针靠近时浮现').getAttribute('aria-checked') === 'true',
    'auto-hide choice lost'
  )
  await click('常显')
  for (const dark of [false, true]) {
    theme(dark)
    await tick()
    geometry()
    await capture('player-' + (dark ? 'dark' : 'light'))
  }
  await click('标准播放栏', document.querySelector('.onb-player-shape-cards'))
  await advance()
  await click('USB DAC')
  rejectTone = true
  await click('试听当前设备')
  expect(
    document.querySelector('[role="alert"]')?.textContent.includes('设备连接失败'),
    'audition failure hidden'
  )
  await click('重试试听')
  await until(() => document.querySelector('.onb-audio-test-ok'), 'audition retry did not complete')
  await click('试听当前设备')
  await click('停止试听')
  expect(!pendingTone, 'stop leaked audition')
  await click('试听当前设备')
  await click('系统默认输出')
  expect(
    !pendingTone && !document.querySelector('.onb-audio-test-ok'),
    'device change left stale audition status'
  )
  await click('USB DAC')
  theme(false)
  await capture('audio-light')
  await click('试听当前设备')
  const stoppedBefore = stopCalls
  await advance()
  expect(stopCalls > stoppedBefore && !pendingTone, 'leaving audio failed to stop audition')
  await advance()
  expect(document.querySelector('.onb-summary'), 'summary missing')
  expect(
    document.querySelector('.onb-scan-status')?.textContent.includes('300000'),
    'SQLite library count was replaced by the empty compatibility array'
  )
  expect(
    document.querySelector('.onb-summary').textContent.includes('USB DAC'),
    'summary device mismatch'
  )
  for (const dark of [false, true]) {
    theme(dark)
    await tick()
    geometry()
    await capture('finish-' + (dark ? 'dark' : 'light'))
    for (const [width, height] of [
      [760, 650],
      [1200, 900]
    ]) {
      await ipc.invoke('onboarding-resize', width, height)
      await tick()
      geometry()
    }
  }
  const playerSummary = [...document.querySelectorAll('.onb-summary-item')].find((item) =>
    item.textContent.includes('播放控制')
  )
  await click('修改', playerSummary)
  await click('紧凑模式', document.querySelector('.onb-player-shape-cards'))
  for (const [width, height] of [
    [760, 560],
    [1200, 900]
  ]) {
    await ipc.invoke('onboarding-resize', width, height)
    await tick()
    geometry()
  }
  await go('完成')
  expect(
    document.querySelector('.onb-summary').textContent.includes('紧凑模式'),
    'summary edit lost choice'
  )
  await go('流媒体')
  await click('完成后立即登录')
  await go('听歌习惯')
  await click('本地音乐')
  await go('完成')
  expect(
    document.querySelector('.onb-btn-primary').textContent.includes('打开本地曲库'),
    'removed streaming branch retained login handoff'
  )
  await advance()
  expect(
    !results.at(-1).openPluginMarket && results.at(-1).action === 'local',
    'wrong finish destination'
  )
  expect(!('ncmPlaybackQuality' in results.at(-1).patch), 'removed source wrote settings')
  await tick()
  expect(document.querySelector('.onb-btn-primary').disabled, 'saving can double submit')
  expect(
    [...document.querySelectorAll('.onb-summary-heading button')].every(
      (button) => button.disabled
    ),
    'saving leaves summary editable'
  )
  saving.value = false
  saveError.value = '保存失败，请重试'
  await tick()
  expect(
    document.querySelector('.onb-save-error').textContent.includes('保存失败'),
    'save failure not visible'
  )
  await advance()
  expect(results.length === 2, 'save retry unavailable')
  expect(
    results.at(-1).patch.playerBar.mode === 'compact' &&
      results.at(-1).patch.playerBar.playingPageMode === 'compact',
    'page-specific styles were not saved'
  )
  expect(toneCalls >= 5, 'audition paths not exercised')
  wizardVisible.value = false
  await tick()
  expect(!document.querySelector('.onboarding-wizard'), 'wizard failed to exit')
  const restoredChrome = document.querySelector('.title-bar')
  for (const selector of [
    '.back-btn',
    '.menu-btn',
    '.login-btn',
    '.plugins-btn',
    '.settings-btn',
    '.notification-btn',
    '.minimize',
    '.maximize',
    '.close',
    '.title-bar-background'
  ]) {
    expect(restoredChrome.querySelector(selector), 'title bar did not restore ' + selector)
  }
  restoredChrome.querySelector('.minimize').click()
  restoredChrome.querySelector('.maximize').click()
  expect(
    windowCalls.minimize === 1 && windowCalls.maximize === 1,
    'restored window controls failed'
  )
  disposeBack()
}
window.previewOnboarding = async () => {
  await reachPlayer()
  theme(false)
}
mount()
