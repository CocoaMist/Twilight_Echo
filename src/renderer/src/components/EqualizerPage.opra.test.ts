import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'

const page = readFileSync(new URL('./EqualizerPage.vue', import.meta.url), 'utf8')

test('OPRA catalog actions use finite Core queries without a renderer OPRA bridge', async () => {
  const calls: Array<[string, unknown]> = []
  const status = { loaded: true }
  const profile = { eqId: 'profile', applicable: true }
  const context = {
    core: {
      query: async (name: string, payload: unknown) => {
        calls.push([name, payload])
        return name === 'opra.search' ? [profile] : status
      },
      command: async (name: string, payload: unknown) => {
        calls.push([name, payload])
        return status
      }
    },
    window: { api: {} },
    opraStatus: { value: null },
    opraResults: { value: [] },
    opraSearching: { value: false },
    opraRefreshing: { value: false },
    opraQuery: { value: '  headphone  ' },
    opraError: { value: '' }
  }
  const handlers = ['loadOpraStatus', 'searchOpraProfiles', 'refreshOpraCatalog']
    .map((name) =>
      stripTypeScriptTypes(page.match(new RegExp(`async function ${name}\\([\\s\\S]*?\\n\\}`))![0])
    )
    .join('\n')
  await runInNewContext(
    `${handlers}\n(async () => { await loadOpraStatus(); await refreshOpraCatalog() })()`,
    context
  )
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['opra.status', {}],
    ['opra.refresh', {}],
    ['opra.search', { query: 'headphone' }],
    ['opra.status', {}]
  ])
  assert.equal(context.opraStatus.value, status)
  assert.equal(context.opraResults.value[0], profile)
  assert.equal(context.opraError.value, '')
  assert.equal(context.opraRefreshing.value, false)
  assert.doesNotMatch(page, /window\.api\.opra/)
})
