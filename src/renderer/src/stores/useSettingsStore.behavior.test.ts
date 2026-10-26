import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { createSSRApp, isReadonly } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createDefaultSettings } from '../../../core/settings/normalization.ts'
import type { AppSettings, SettingsSnapshot } from '../../../shared/appSettings.ts'
import type { CoreBridgeApi } from '../../../shared/coreBridge.ts'
import type { CoreRequestEnvelope } from '../../../shared/coreProtocol.ts'
import { coreSnapshot } from './coreTestFixtures.ts'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './useThemeStore.ts' && context.parentURL?.endsWith('/useSettingsStore.ts'))
      return {
        url: 'data:text/javascript,export function syncThemeSettingsAppearance() {}',
        shortCircuit: true
      }
    if (
      specifier === '../stores/useSettingsStore' &&
      context.parentURL?.endsWith('/useLyricsAppearanceEditor.ts')
    )
      return next(new URL('./useSettingsStore.ts', import.meta.url).href, context)
    return next(specifier, context)
  }
})

test('settings remain a confirmed projection while appearance and lyric preset edits are drafts', async () => {
  let backend = createDefaultSettings('win32')
  const snapshot = (): SettingsSnapshot => ({
    ...structuredClone(backend),
    settings: structuredClone(backend),
    defaults: { cachePath: '' },
    paths: {} as SettingsSnapshot['paths'],
    appVersion: 'test',
    platform: 'win32',
    windowTransparencySupported: false,
    restartRequired: false,
    restartReasons: []
  })
  let changed!: (value: SettingsSnapshot) => void
  let release!: () => void
  let fail = false
  const patches: Partial<AppSettings>[] = []
  let applyPatch = async (patch: Partial<AppSettings>): Promise<SettingsSnapshot> => {
    patches.push(patch)
    await new Promise<void>((resolve) => {
      release = resolve
    })
    backend = { ...backend, ...patch }
    changed(snapshot())
    return snapshot()
  }
  const timers = new Map<number, () => Promise<void>>()
  const coreRequests: CoreRequestEnvelope[] = []
  const sizes = { bpm: 2048, loudness: 4096 }
  let cacheFailure = false
  const core: CoreBridgeApi = {
    connect: async () => ({
      ok: true,
      value: { connectionId: 'settings', snapshot: coreSnapshot() }
    }),
    onMessage: () => () => {},
    onStatus: () => () => {},
    cancel: async () => ({ ok: true, value: undefined }),
    disconnect: async () => ({ ok: true, value: undefined }),
    request: async (_id, request) => {
      coreRequests.push(request)
      if (request.name !== 'analysis.cache.size' && request.name !== 'analysis.cache.clear')
        throw new Error(`Unexpected Core request: ${request.name}`)
      if (cacheFailure) return { ok: false, error: { code: 'FAILED', message: 'cache busy' } }
      if (request.name === 'analysis.cache.clear') sizes[request.payload.kind] = 0
      return { ok: true, value: sizes[request.payload.kind] }
    }
  }
  let timerId = 0
  Object.defineProperty(globalThis, 'navigator', {
    value: { platform: 'Win32' },
    configurable: true
  })
  Object.assign(globalThis, {
    document: {
      readyState: 'loading',
      addEventListener() {},
      documentElement: { dataset: {}, style: { removeProperty() {}, setProperty() {} } },
      body: { classList: { toggle() {} } }
    },
    window: {
      setTimeout(callback: () => Promise<void>) {
        timers.set(++timerId, callback)
        return timerId
      },
      clearTimeout(id: number) {
        timers.delete(id)
      },
      api: {
        core,
        settings: {
          get: async () => {
            if (fail) throw new Error('offline')
            return snapshot()
          },
          onChanged(callback: typeof changed) {
            changed = callback
          },
          update: (patch: Partial<AppSettings>) => applyPatch(patch)
        }
      }
    }
  })
  const { useSettingsStore } = await import('./useSettingsStore.ts')
  const store = useSettingsStore()
  await store.loadSettings()
  assert.equal(isReadonly(store.settings), true)
  assert.equal(isReadonly(store.settings.value), true)

  const first = store.updateSettings({ softwareVolume: 0.2 })
  const second = store.updateSettings({ playerBar: { ...backend.playerBar, mode: 'mini' } })
  assert.equal(store.settings.value.softwareVolume, backend.softwareVolume)
  assert.equal(store.settings.value.playerBar.mode, 'mini')
  backend = { ...backend, softwareVolume: 0.4 }
  changed(snapshot())
  assert.equal(store.settings.value.softwareVolume, 0.4)
  assert.equal(store.settings.value.playerBar.mode, 'mini')
  await Promise.resolve()
  assert.equal(patches.length, 1)
  release()
  await first
  await Promise.resolve()
  assert.equal(patches.length, 2)
  release()
  await second
  assert.equal(store.settings.value.softwareVolume, 0.2)

  fail = true
  applyPatch = async () => {
    throw new Error('offline')
  }
  const failed = store.updateSettings({ playerBar: { ...backend.playerBar, mode: 'compact' } })
  assert.equal(store.settings.value.playerBar.mode, 'compact')
  await assert.rejects(failed, /offline/)
  assert.equal(store.settings.value.playerBar.mode, 'mini')
  assert.equal(store.saving.value, false)

  fail = false
  applyPatch = async (patch) => {
    patches.push(patch)
    backend = { ...backend, ...patch }
    changed(snapshot())
    return snapshot()
  }
  const { useLyricsAppearanceEditor } = await import('../composables/useLyricsAppearanceEditor.ts')
  let editor!: ReturnType<typeof useLyricsAppearanceEditor>
  await renderToString(
    createSSRApp({
      setup() {
        editor = useLyricsAppearanceEditor()
        return () => null
      }
    })
  )
  editor.savePreset('Evening')
  editor.patchStyle('fontSize', 33)
  assert.equal(editor.presets.value.at(-1)?.name, 'Evening')
  assert.equal(backend.lyricsPresets.custom.length, 0)
  assert.equal(timers.size, 1)
  await [...timers.values()][0]()
  assert.equal(backend.lyricsPresets.custom.at(-1)?.name, 'Evening')
  assert.equal(backend.lyricsAppearance.styles.normal.fontSize, 33)
  assert.equal(editor.saveState.value, 'saved')

  const { useCoreConnection, disposeCoreConnection } = await import('./coreConnection.ts')
  await useCoreConnection().attach()
  await store.refreshBpmAnalysisCacheSize()
  await store.refreshLoudnessAnalysisCacheSize()
  assert.equal(store.bpmAnalysisCacheSize.value, 2048)
  assert.equal(store.loudnessAnalysisCacheSize.value, 4096)
  await store.clearBpmAnalysisCache()
  await store.clearLoudnessAnalysisCache()
  assert.equal(store.bpmAnalysisCacheSize.value, 0)
  assert.equal(store.loudnessAnalysisCacheSize.value, 0)
  assert.deepEqual(
    coreRequests.map(({ name, payload }) => [name, payload]),
    [
      ['analysis.cache.size', { kind: 'bpm' }],
      ['analysis.cache.size', { kind: 'loudness' }],
      ['analysis.cache.clear', { kind: 'bpm' }],
      ['analysis.cache.clear', { kind: 'loudness' }]
    ]
  )
  cacheFailure = true
  await assert.rejects(store.clearBpmAnalysisCache(), /cache busy/)
  await assert.rejects(store.clearLoudnessAnalysisCache(), /cache busy/)
  assert.equal(store.clearingBpmAnalysisCache.value, false)
  assert.equal(store.clearingLoudnessAnalysisCache.value, false)
  disposeCoreConnection()
})
