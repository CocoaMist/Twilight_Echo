import { createApp, nextTick } from 'vue'
import MiniPlayerApp from './MiniPlayerApp.vue'
import '../assets/main.css'
import '../assets/icon-fonts'
document.documentElement.classList.add('mini-player-document')
import {
  DEFAULT_MINI_PLAYER_SETTINGS,
  EMPTY_MINI_PLAYER_STATE,
  MINI_PLAYER_SIZE_PRESETS,
  cloneMiniPlayerSettings
} from '../../../shared/miniPlayer.ts'

const expect = (condition, message) => {
  if (!condition) throw new Error(message)
}
const waitFor = async (condition, message) => {
  const deadline = Date.now() + 4000
  while (!condition()) {
    expect(Date.now() < deadline, message)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
const resize = (width, height) => window.resizeMiniPlayerTest(width, height)
const root = () => document.querySelector('.mini-player-root')
const panel = () => document.querySelector('.mini-customizer')
let saved
let mounted
let settingsListener
let stateListener
const commands = []
const originalInterval = window.setInterval.bind(window)
const originalClearInterval = window.clearInterval.bind(window)
const clockIntervals = new Set()
let clockTicks = 0
let hidden = false
Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
window.setInterval = (callback, delay, ...args) => {
  const id = originalInterval(() => {
    if (delay === 50) clockTicks++
    callback(...args)
  }, delay)
  if (delay === 50) clockIntervals.add(id)
  return id
}
window.clearInterval = (id) => {
  clockIntervals.delete(id)
  originalClearInterval(id)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const current = () => ({
  ...EMPTY_MINI_PLAYER_STATE,
  track: {
    id: 'test-track',
    title: 'NEO · Twilight Echo',
    artist: 'CocoaMist',
    album: 'Playback family',
    albumArtist: '',
    trackNumber: 1,
    cover: null,
    coverSource: null,
    format: 'FLAC',
    sampleRate: 96000,
    bitDepth: 24
  },
  currentTime: 30,
  duration: 180,
  queueIndex: 0,
  queueLength: 3,
  favoriteAvailable: true,
  capturedAtMs: Date.now()
})
const pushState = async (changes = {}) => {
  stateListener({ ...current(), ...changes })
  await nextTick()
}
const setHidden = async (value) => {
  hidden = value
  document.dispatchEvent(new Event('visibilitychange'))
  await nextTick()
}
let failNextSave = false
let activeSaves = 0
let motionPreference = 'off'
const unhandledErrors = []
window.addEventListener('unhandledrejection', (event) => unhandledErrors.push(event.reason))

window.api = {
  miniPlayer: {
    getBootstrap: async () => ({
      settings: cloneMiniPlayerSettings(saved),
      state: { ...EMPTY_MINI_PLAYER_STATE },
      motionPreference
    }),
    updateSettings: async (candidate) => {
      activeSaves++
      try {
        if (failNextSave) {
          failNextSave = false
          throw new Error('undo persistence unavailable')
        }
        saved = cloneMiniPlayerSettings(candidate)
        await resize(saved.windowWidth, saved.windowHeight)
        settingsListener?.(cloneMiniPlayerSettings(saved))
        return cloneMiniPlayerSettings(saved)
      } finally {
        activeSaves--
      }
    },
    command: (command) => {
      commands.push(command)
    },
    onState: (listener) => {
      stateListener = listener
      return () => {
        stateListener = null
      }
    },
    onSettings: (listener) => {
      settingsListener = listener
      return () => {
        settingsListener = null
      }
    },
    onMotionPreference: () => () => {}
  }
}

async function mountPreset(preset) {
  mounted?.unmount()
  saved = cloneMiniPlayerSettings(DEFAULT_MINI_PLAYER_SETTINGS)
  saved.windowWidth = preset.width
  saved.windowHeight = preset.height
  await resize(preset.width, preset.height)
  mounted = createApp(MiniPlayerApp)
  mounted.mount('#app')
  await waitFor(() => root()?.classList.contains('is-ready'), 'mini player did not bootstrap')
}

async function openCustomizer() {
  document.querySelector('.tool-customize').click()
  await waitFor(() => panel() && activeSaves === 0, 'customizer did not open')
  expect(innerWidth >= 520 && innerHeight >= 340, 'customizer needs its expanded window')
}

async function changeTheme() {
  const previous = saved.activeStyleId
  document.querySelector('.customizer-theme-option:not(.active)').click()
  await waitFor(
    () => saved.activeStyleId !== previous && activeSaves === 0,
    'theme change did not persist'
  )
}

function undo() {
  document.querySelector('.mini-customizer-footer button').click()
}

async function expectPlayer(preset, theme) {
  await waitFor(
    () =>
      !panel() &&
      !root().classList.contains('is-customizing') &&
      innerWidth === preset.width &&
      innerHeight === preset.height &&
      activeSaves === 0,
    `${preset.id}: undo left the customizer open or failed to restore the player size`
  )
  expect(saved.activeStyleId === theme, 'wrong persisted theme after closing')
  expect(root().dataset.themeProfile === theme, 'wrong rendered theme after closing')
  expect(
    !document.querySelector('.mini-controls').inert,
    'playback controls stayed inert after closing'
  )
}

window.runMiniPlayerUndoTests = async () => {
  for (motionPreference of ['off', 'full']) {
    for (const preset of MINI_PLAYER_SIZE_PRESETS) {
      await mountPreset(preset)
      const original = cloneMiniPlayerSettings(saved)
      await openCustomizer()
      undo()
      await expectPlayer(preset, original.activeStyleId)

      await openCustomizer()
      await changeTheme()
      undo()
      await expectPlayer(preset, original.activeStyleId)
      expect(
        JSON.stringify(saved) === JSON.stringify(original),
        'undo did not restore the snapshot'
      )

      await openCustomizer()
      await changeTheme()
      const committedTheme = saved.activeStyleId
      document.querySelector('[aria-label="关闭自定义面板"]').click()
      await expectPlayer(preset, committedTheme)

      await openCustomizer()
      await changeTheme()
      undo()
      await expectPlayer(preset, committedTheme)
    }
  }

  const preset = MINI_PLAYER_SIZE_PRESETS[0]
  await mountPreset(preset)
  const originalTheme = saved.activeStyleId
  await openCustomizer()
  await changeTheme()
  const editedTheme = saved.activeStyleId
  failNextSave = true
  undo()
  await waitFor(
    () =>
      panel()
        ?.querySelector('[role="status"]')
        ?.textContent.includes('undo persistence unavailable'),
    'failed undo did not show its persistence error'
  )
  expect(innerWidth >= 520 && innerHeight >= 340, 'failed undo shrank the editor')
  expect(saved.activeStyleId === editedTheme, 'failed undo lost the last confirmed theme')
  undo()
  await expectPlayer(preset, originalTheme)
  expect(unhandledErrors.length === 0, 'undo leaked an unhandled promise rejection')
  mounted.unmount()
  return 'MINI_PLAYER_UNDO_OK: four forms, motion off/full, unchanged/edited/reopened sessions, close, failure and retry'
}

window.prepareMiniPlayerForm = async (index) => {
  const preset = MINI_PLAYER_SIZE_PRESETS[index]
  motionPreference = 'off'
  await mountPreset(preset)
  await pushState()
  await sleep(650)
  expect(
    document.querySelector('.mini-title')?.textContent.includes('NEO'),
    'screenshot waits for current title'
  )
  return preset.id
}

window.runMiniPlayerPlaybackTests = async () => {
  await mountPreset(MINI_PLAYER_SIZE_PRESETS[1])
  expect(clockIntervals.size === 0, 'empty player must not run the interpolation timer')
  await pushState()
  let ticks = clockTicks
  await sleep(230)
  expect(
    clockTicks === ticks && clockIntervals.size === 0,
    'paused player must not wake every 50 ms'
  )
  await pushState({ isPlaying: true })
  await sleep(230)
  expect(
    clockTicks > ticks && clockIntervals.size === 1,
    'visible playback starts exactly one clock'
  )
  await setHidden(true)
  ticks = clockTicks
  await sleep(230)
  expect(
    clockTicks === ticks && clockIntervals.size === 0,
    'hidden playback must have zero clock wakeups'
  )
  const hiddenPosition = Number(document.querySelector('.mini-progress-range').value)
  await setHidden(false)
  expect(clockIntervals.size === 1, 'visible playback resumes its clock immediately')
  expect(
    Number(document.querySelector('.mini-progress-range').value) > hiddenPosition,
    'returning to the player immediately catches up its timeline'
  )
  await pushState({ isLoading: true, isPlaying: true })
  expect(clockIntervals.size === 0, 'buffering playback stops interpolation')
  await pushState({ track: null, isPlaying: true })
  expect(clockIntervals.size === 0, 'an empty track cannot start an interpolation clock')
  await pushState({ currentTime: 180, isPlaying: true })
  expect(clockIntervals.size === 0, 'completed playback does not leave a clock running')
  await pushState()
  const input = () => document.querySelector('.mini-progress-range')
  const bounds = () => {
    const b = input().getBoundingClientRect()
    return {
      x: Math.round(b.left + b.width * 0.25),
      y: Math.round(b.top + b.height / 2),
      left: b.left,
      width: b.width
    }
  }
  commands.length = 0
  let rail = bounds()
  await window.miniPlayerTestPointer('down', rail.x, rail.y)
  for (const fraction of [0.3, 0.4, 0.5, 0.6, 0.7])
    await window.miniPlayerTestPointer(
      'move',
      Math.round(rail.left + rail.width * fraction),
      rail.y
    )
  expect(commands.length === 0, 'dragging must preview without repeated IPC')
  expect(Math.abs(Number(input().value) - 126) < 2, 'drag preview follows the pointer')
  await pushState({ currentTime: 31 })
  expect(
    Math.abs(Number(input().value) - 126) < 2,
    'incoming clock snapshots cannot pull back the drag'
  )
  await window.miniPlayerTestPointer('up', Math.round(rail.left + rail.width * 0.7), rail.y - 40)
  expect(
    commands.filter((x) => x.type === 'seek').length === 1,
    'release outside slider sends exactly one seek'
  )
  const submitted = commands.at(-1).value
  expect(Math.abs(submitted - 126) < 2, 'seek commits final preview')
  commands.length = 0
  input().value = '65'
  input().dispatchEvent(new Event('input', { bubbles: true }))
  expect(commands.length === 0, 'keyboard input previews until change')
  input().dispatchEvent(new Event('change', { bubbles: true }))
  expect(commands.length === 1 && commands[0].value === 65, 'keyboard change commits once')
  for (const changes of [
    { track: { ...current().track, id: 'next-track' } },
    { queueIndex: 1 },
    { duration: 0 },
    'hidden'
  ]) {
    await pushState()
    commands.length = 0
    rail = bounds()
    await window.miniPlayerTestPointer('down', rail.x, rail.y)
    await window.miniPlayerTestPointer('move', Math.round(rail.left + rail.width * 0.6), rail.y)
    if (changes === 'hidden') await setHidden(true)
    else await pushState(changes)
    await window.miniPlayerTestPointer('up', Math.round(rail.left + rail.width * 0.6), rail.y)
    expect(commands.length === 0, 'changed track/occurrence/duration cancels the old seek')
    await setHidden(false)
  }
  await pushState({ duration: 0 })
  expect(input().disabled, 'unknown duration disables seeking')
  await pushState({ track: { ...current().track, format: 'm4a', sampleRate: 96000, bitDepth: 24 } })
  expect(
    !document.querySelector('.mini-quality-badge'),
    'm4a container alone cannot advertise lossless or Hi-Res'
  )
  await pushState({ track: { ...current().track, format: 'ALAC' } })
  expect(
    document.querySelector('.mini-quality-badge')?.textContent.includes('Hi-Res'),
    'known high resolution lossless codec remains labeled'
  )
  let imageErrors = 0
  const countImageError = (event) => {
    if (event.target instanceof HTMLImageElement && event.target.classList.contains('mini-artwork'))
      imageErrors++
  }
  document.addEventListener('error', countImageError, true)
  for (const background of ['solid', 'gradient', 'image']) {
    const candidate = cloneMiniPlayerSettings(saved)
    candidate.profiles[candidate.activeStyleId].background.kind = background
    settingsListener(candidate)
    await nextTick()
    const beforeError = imageErrors
    await pushState({
      track: {
        ...current().track,
        id: `broken-${background}`,
        cover: `data:image/png;base64,broken-${background}`
      }
    })
    await waitFor(
      () =>
        imageErrors > beforeError && document.querySelector('.mini-artwork.default-track-cover'),
      `${background}: invalid artwork should fail and show its fallback`
    )
    const cover = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>')}`
    await pushState({ track: { ...current().track, id: `recovered-${background}`, cover } })
    await waitFor(
      () =>
        [...document.querySelectorAll('.mini-artwork')].some(
          (image) =>
            image.src === cover &&
            image.complete &&
            image.naturalWidth === 8 &&
            !image.classList.contains('default-track-cover')
        ),
      `${background}: new valid artwork must recover after the previous track failed`
    )
  }
  document.removeEventListener('error', countImageError, true)
  commands.length = 0
  const favorite =
    document.querySelector('.mini-favorite') || document.querySelector('[aria-label="收藏"]')
  expect(favorite, 'favorite control must remain available')
  const key = new KeyboardEvent('keydown', {
    key: ' ',
    code: 'Space',
    bubbles: true,
    cancelable: true
  })
  favorite.dispatchEvent(key)
  expect(
    !key.defaultPrevented && commands.length === 0,
    'Space on a focused button keeps native button activation'
  )
  const globalKey = new KeyboardEvent('keydown', {
    key: ' ',
    code: 'Space',
    bubbles: true,
    cancelable: true
  })
  document.body.dispatchEvent(globalKey)
  expect(
    globalKey.defaultPrevented && commands[0]?.type === 'toggle-play',
    'Space on the player surface still toggles playback'
  )
  mounted.unmount()
  expect(clockIntervals.size === 0, 'unmount disposes interpolation')
  return 'MINI_PLAYER_PLAYBACK_OK: drag IPC 5 previews -> 1 commit, paused/hidden/empty clock 20 ticks/s -> 0; occurrence cancellation, keyboard and codec labeling'
}
