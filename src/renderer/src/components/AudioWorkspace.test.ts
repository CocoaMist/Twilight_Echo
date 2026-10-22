import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { compileScript, parse } from '@vue/compiler-sfc'
import * as Vue from 'vue'
import * as workbench from '../utils/dspWorkbench.ts'
import type { DspWorkspaceTab } from '../utils/dspWorkbench.ts'

const require = createRequire(import.meta.url)
const typescript = require('typescript') as typeof import('typescript')
const source = readFileSync(new URL('./AudioWorkspace.vue', import.meta.url), 'utf8')
const descriptor = parse(source).descriptor
const compiled = typescript.transpileModule(
  compileScript(descriptor, { id: 'audio-workspace-test' }).content,
  {
    compilerOptions: {
      target: typescript.ScriptTarget.ES2022,
      module: typescript.ModuleKind.CommonJS
    }
  }
).outputText

interface ChildPage {
  requestLeave: () => Promise<boolean>
  finishAudition: () => Promise<boolean>
  syncFromEngine: () => Promise<void>
  refreshDiagnostics: () => Promise<void>
}
interface WorkspaceSetup {
  target: Vue.Ref<HTMLElement | null>
  rack: Vue.Ref<ChildPage | null>
  equalizer: Vue.Ref<{ requestLeave: () => Promise<boolean>; busy?: boolean } | null>
  tab: Vue.Ref<DspWorkspaceTab>
  switching: Vue.Ref<boolean>
  masterBusy: Vue.Ref<boolean>
  error: Vue.Ref<string>
  selectTab: (tab: DspWorkspaceTab) => Promise<void>
  toggleMaster: () => Promise<void>
  popout: () => void
  requestLeave: () => Promise<boolean>
}
function createWorkspace(initialTab: DspWorkspaceTab = 'equalizer') {
  const updates: { dspEnabled: boolean }[] = []
  const store = Vue.reactive({
    audioProcessing: { dspEnabled: false },
    audioDevice: 'default',
    audioDeviceOptions: [],
    audioEngineReady: true,
    setAudioProcessing: async (
      patch: { dspEnabled: boolean },
      options: { throwOnError: boolean }
    ) => {
      assert.equal(options.throwOnError, true)
      updates.push({ ...patch })
      store.audioProcessing.dspEnabled = patch.dspEnabled
    }
  })
  const scope = Vue.effectScope()
  const cleanups: Array<() => void> = []
  let exposed!: { requestLeave: () => Promise<boolean> }
  const module = { exports: {} as { default: { setup: (...args: unknown[]) => WorkspaceSetup } } }
  runInNewContext(compiled, {
    module,
    exports: module.exports,
    require: (specifier: string) => {
      if (specifier === 'vue')
        return { ...Vue, onBeforeUnmount: (callback: () => void) => cleanups.push(callback) }
      if (specifier === 'pinia') return { storeToRefs: Vue.toRefs }
      if (specifier.endsWith('/useAudioOutputDspStore'))
        return { useAudioOutputDspStore: () => store }
      if (specifier.endsWith('/dspWorkbench')) return workbench
      if (specifier.endsWith('.vue')) return { default: {} }
      if (specifier.endsWith('/useDspEditorWindow'))
        return {
          dspEditorDocumentVisible: Vue.ref(true),
          useDspEditorWindow: (onChange: (value: boolean) => void) => {
            const target = Vue.shallowRef<HTMLElement | null>(null)
            return {
              target,
              focus: () => {},
              open: () => {
                target.value = {} as HTMLElement
                onChange(true)
              },
              dock: async () => {
                target.value = null
                onChange(false)
              }
            }
          }
        }
      throw Error(`Unexpected setup dependency: ${specifier}`)
    },
    document: {},
    window: {
      addEventListener: () => {},
      removeEventListener: () => {},
      api: { window: { close: () => {} } }
    }
  })
  const state = scope.run(() =>
    module.exports.default.setup(Vue.reactive({ active: true, initialTab }), {
      expose: (api: typeof exposed) => {
        exposed = api
      }
    })
  )!
  state.rack.value = {
    requestLeave: async () => true,
    finishAudition: async () => true,
    syncFromEngine: async () => {},
    refreshDiagnostics: async () => {}
  }
  return {
    state,
    store,
    updates,
    exposed,
    stop: () => {
      cleanups.forEach((callback) => callback())
      scope.stop()
    }
  }
}

test('workspace tab switches respect EQ refusal and synchronize the rack before entering the chain', async () => {
  const w = createWorkspace()
  let allowed = false,
    attempts = 0,
    synchronized = 0
  w.state.equalizer.value = {
    requestLeave: async () => {
      attempts++
      return allowed
    }
  }
  w.state.rack.value!.syncFromEngine = async () => {
    synchronized++
  }
  await w.state.selectTab('equalizer')
  assert.equal(attempts, 0)
  await w.state.selectTab('chain')
  assert.equal(w.state.tab.value, 'equalizer')
  allowed = true
  await w.state.selectTab('chain')
  assert.equal(attempts, 2)
  assert.equal(synchronized, 1)
  assert.equal(w.state.tab.value, 'chain')
  assert.deepEqual(w.updates, [])
  w.stop()
})

test('pending draft decisions block duplicate switches and external navigation', async () => {
  const w = createWorkspace()
  let release!: (allowed: boolean) => void
  w.state.equalizer.value = {
    requestLeave: () =>
      new Promise((resolve) => {
        release = resolve
      })
  }
  const pending = w.state.selectTab('chain')
  assert.equal(w.state.switching.value, true)
  assert.equal(await w.state.requestLeave(), false)
  await w.state.selectTab('output')
  release(true)
  await pending
  assert.equal(w.state.tab.value, 'chain')
  assert.equal(w.state.switching.value, false)
  w.stop()
})

test('failed draft saves keep the current tab and expose the engine error', async () => {
  const w = createWorkspace()
  w.state.equalizer.value = {
    requestLeave: async () => {
      throw Error('save failed')
    }
  }
  await w.state.selectTab('chain')
  assert.equal(w.state.tab.value, 'equalizer')
  assert.match(w.state.error.value, /save failed/)
  assert.equal(w.state.switching.value, false)
  w.stop()
})

test('master DSP writes follow explicit clicks and refresh the committed rack state', async () => {
  const w = createWorkspace('chain')
  const calls: string[] = []
  w.state.rack.value = {
    requestLeave: async () => {
      calls.push('leave')
      return true
    },
    finishAudition: async () => true,
    syncFromEngine: async () => {
      calls.push('sync')
    },
    refreshDiagnostics: async () => {
      calls.push('diagnostics')
    }
  }
  assert.deepEqual(w.updates, [])
  await w.state.toggleMaster()
  assert.deepEqual(w.updates, [{ dspEnabled: true }])
  assert.deepEqual(calls, ['leave', 'sync', 'diagnostics'])
  await w.state.toggleMaster()
  assert.deepEqual(w.updates, [{ dspEnabled: true }, { dspEnabled: false }])
  w.stop()
})

test('master changes cannot bypass a refused draft or race an engine write', async () => {
  const w = createWorkspace()
  w.state.equalizer.value = { requestLeave: async () => false }
  await w.state.toggleMaster()
  assert.deepEqual(w.updates, [])
  w.state.equalizer.value = { requestLeave: async () => true }
  let reject!: (error: Error) => void
  w.store.setAudioProcessing = () =>
    new Promise((_resolve, fail) => {
      reject = fail
    })
  const pending = w.state.toggleMaster()
  while (!reject) await Vue.nextTick()
  assert.equal(w.state.masterBusy.value, true)
  assert.equal(await w.state.requestLeave(), false)
  await w.state.toggleMaster()
  reject(Error('engine unavailable'))
  await pending
  assert.equal(w.store.audioProcessing.dspEnabled, false)
  assert.match(w.state.error.value, /engine unavailable/)
  assert.equal(w.state.masterBusy.value, false)
  w.stop()
})

test('leaving the detached workbench retains refused drafts and docks only after approval', async () => {
  const w = createWorkspace('chain')
  let allowed = false
  w.state.rack.value!.requestLeave = async () => allowed
  w.state.popout()
  assert.ok(w.state.target.value)
  assert.equal(await w.exposed.requestLeave(), false)
  assert.ok(w.state.target.value)
  allowed = true
  assert.equal(await w.exposed.requestLeave(), true)
  assert.equal(w.state.target.value, null)
  w.stop()
})
