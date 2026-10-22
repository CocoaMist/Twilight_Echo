import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { computed, effectScope, nextTick, ref, watch } from 'vue'
import type { DspGraphNode } from '../../../../shared/dspGraph.ts'
import * as logic from '../../utils/equalizerPageLogic.ts'
import * as response from '../../utils/eqResponse.ts'
import { createParametricBand } from '../../utils/parametricEqInteraction.ts'

const source = readFileSync(new URL('./DspDraftEqualizer.vue', import.meta.url), 'utf8')
const script = stripTypeScriptTypes(
  source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]
).replace(/^import[\s\S]*?from ['"][^'"]+['"]\r?\n/gm, '')

function setup() {
  const node = ref<DspGraphNode>({
    id: 'draft',
    type: 'equalizer',
    enabled: false,
    params: { mode: 'parametric', preampDb: 0, bands: [createParametricBand(1000, 3)] }
  })
  const scope = effectScope()
  const unmount: Array<() => void> = []
  let paste = async () => [createParametricBand(200, 2)]
  let commits = 0
  const context: Record<string, any> = {
    ...logic,
    ...response,
    computed,
    ref,
    watch,
    createParametricBand,
    defineModel: () => node,
    defineProps: () => ({ sampleRate: 48000 }),
    defineEmits: () => () => {
      commits++
    },
    onBeforeUnmount: (callback: () => void) => unmount.push(callback),
    window: {
      api: {
        window: { pasteEqBands: () => paste(), copyEqBands: async () => {} },
        audioEngine: new Proxy(
          {},
          {
            get: () => {
              throw Error('draft EQ touched engine')
            }
          }
        )
      }
    }
  }
  const actions = scope.run(() =>
    runInNewContext(
      script +
        '\n({add, remove, preview, changeMode, clipboard, autoPreamp, editorBands, availableFilters})',
      context
    )
  )
  return {
    node,
    actions,
    setPaste: (next: typeof paste) => {
      paste = next
    },
    get commits() {
      return commits
    },
    stop: () => {
      unmount.forEach((fn) => fn())
      scope.stop()
    }
  }
}

test('draft EQ previews and automatic preamp only modify the selected node, never the engine', () => {
  const fixture = setup()
  try {
    fixture.actions.preview([{ index: 0, patch: { gain: 80 } }])
    assert.equal((fixture.node.value.params.bands as any[])[0].gain, 24)
    fixture.actions.autoPreamp()
    assert.ok(Number(fixture.node.value.params.preampDb) < 0)
    assert.equal(fixture.node.value.enabled, false)
    assert.equal(fixture.commits, 1)
  } finally {
    fixture.stop()
  }
})

test('graphic EQ retains ten peak bands; count-changing controls cannot silently change its contract', async () => {
  const fixture = setup()
  try {
    fixture.actions.changeMode({ target: { value: 'graphic' } })
    fixture.actions.add()
    fixture.actions.remove(0)
    await fixture.actions.clipboard(true)
    assert.equal((fixture.node.value.params.bands as any[]).length, 10)
    assert.equal(fixture.actions.availableFilters.value.length, 1)
    fixture.actions.preview([{ index: 0, patch: { gain: 24, filterType: 'highPass' } }])
    const band = (fixture.node.value.params.bands as any[])[0]
    assert.equal(band.gain, 12)
    assert.equal(band.filterType, 'peak')
  } finally {
    fixture.stop()
  }
})

test('a clipboard request cannot write into a different scene or a disposed editor', async () => {
  const fixture = setup()
  let resolve!: (bands: ReturnType<typeof createParametricBand>[]) => void
  fixture.setPaste(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  try {
    const pasting = fixture.actions.clipboard(true)
    fixture.node.value = { id: 'other', type: 'equalizer', enabled: true, params: { bands: [] } }
    await nextTick()
    resolve([createParametricBand(2000, -2)])
    await pasting
    assert.equal((fixture.node.value.params.bands as any[]).length, 0)
    const disposing = fixture.actions.clipboard(true)
    fixture.stop()
    resolve([createParametricBand(3000, -2)])
    await disposing
    assert.equal((fixture.node.value.params.bands as any[]).length, 0)
  } finally {
    fixture.stop()
  }
})
