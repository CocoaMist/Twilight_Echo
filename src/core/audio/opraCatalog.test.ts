import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { OpraCatalog, OPRA_DATABASE_URL } from './opraCatalog.ts'

const catalogText = [
  { type: 'vendor', id: 'vendor', data: { name: 'Vendor' } },
  { type: 'product', id: 'headphone', data: { name: 'Reference', vendor_id: 'vendor' } },
  {
    type: 'eq',
    id: 'profile',
    data: {
      product_id: 'headphone',
      author: 'Author',
      parameters: { gain_db: -4, bands: [{ type: 'peak_dip', frequency: 500, gain_db: 2, q: 0.7 }] }
    }
  }
]
  .map((row) => JSON.stringify(row))
  .join('\n')

test('Core OPRA refresh keeps the existing JSONL cache and concurrent refresh ownership', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'twilight-core-opra-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cachePath = join(root, 'opra', 'database_v1.jsonl')
  let requests = 0
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    requests++
    assert.equal(url, OPRA_DATABASE_URL)
    return new Response(catalogText)
  })
  const catalog = new OpraCatalog(cachePath)
  await Promise.all([catalog.refresh(), catalog.refresh()])
  assert.equal(requests, 1)
  assert.equal(await readFile(cachePath, 'utf8'), catalogText)
  assert.equal(catalog.getStatus().source, 'network')
  const restored = new OpraCatalog(cachePath)
  const result = await restored.search('vendor reference')
  assert.equal(result[0].eqId, 'profile')
  assert.equal(result[0].preampDb, -4)
  assert.equal(restored.getStatus().source, 'cache')
  assert.equal(requests, 1)
})

test('Core OPRA failed refresh retains the loaded profiles and reports its error', async (t) => {
  const catalog = OpraCatalog.fromText(catalogText, 'unchanged.jsonl')
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }))
  const status = await catalog.refresh()
  assert.equal(status.loaded, true)
  assert.equal(status.source, 'cache')
  assert.match(status.lastError, /503/)
  assert.equal((await catalog.getProfile('profile'))?.bands[0].filterType, 'peak')
})
