import assert from 'node:assert/strict'
import test from 'node:test'
import { createCoreAudioUi } from './coreAudioUi.ts'
import type { CorePlayerClient } from './corePlayerTypes.ts'

test('DSP draft submits its read revision and does not rebase or replay an unknown write', async () => {
  const requests: Array<{ name: string; payload: unknown }> = []
  let revision = 7
  const core = {
    query: async () => ({ revision, scenes: { scenes: [], pinnedSceneId: null } }),
    command: async (name: string, payload: unknown) => {
      requests.push({ name, payload })
      throw Object.assign(new Error('reply lost'), { code: 'OUTCOME_UNKNOWN' })
    }
  } as unknown as CorePlayerClient
  const audio = createCoreAudioUi(core)
  await audio.getDspSceneState()
  revision = 8
  await assert.rejects(audio.setDspScenes([], null), /reply lost/)
  assert.deepEqual(requests, [{ name: 'audio.dsp.edit', payload: { revision: 7, edit: { kind: 'scenes', scenes: [], pinnedSceneId: null } } }])
})

test('VST3 descriptors remain bounded queries, retaining the catalog revision', async () => {
  const reads: Array<{ name: string; payload: unknown }> = []
  const core = {
    query: async (name: string, payload: { offset: number; limit: number; revision?: number }) => {
      reads.push({ name, payload })
      assert.equal(payload.limit, 200)
      if (name === 'audio.vst3') return { revision: 3, total: 1, enabled: true, searchPaths: [], items: [{ id: 'plugin' }] }
      assert.equal(name, 'audio.vst3.parameters')
      assert.equal(payload.revision, 3)
      return { revision: 3, total: 201, items: Array.from({ length: payload.offset === 0 ? 200 : 1 }, (_, i) => ({ id: payload.offset + i })) }
    }
  } as unknown as CorePlayerClient
  const state = await createCoreAudioUi(core).getVst3Catalog()
  assert.equal(state.entries[0].parameters.length, 201)
  assert.deepEqual(reads.map(read => (read.payload as { offset: number }).offset), [0, 0, 200])
})
