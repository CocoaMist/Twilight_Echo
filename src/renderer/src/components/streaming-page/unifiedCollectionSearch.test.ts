import assert from 'node:assert/strict'
import test from 'node:test'
import { searchUnifiedCollections } from './unifiedCollectionSearch.ts'

test('all-source collection search retains source identities and reports partial failures', async () => {
  const warnings: string[] = []
  const result = await searchUnifiedCollections({
    local: { items: ['local'], total: 1 },
    searchLocal: async () => ({ items: ['local'], total: 1 }),
    limit: 30,
    offset: 0,
    providers: [
      { id: 'good', name: 'Good' },
      { id: 'bad', name: 'Bad' }
    ],
    search: async (id) => {
      if (id === 'bad') throw new Error('offline')
      return { items: ['good'], total: 1 }
    },
    reportError: (message) => warnings.push(message)
  })
  assert.deepEqual(result, { items: ['local', 'good'], total: 2 })
  assert.deepEqual(warnings, ['Bad：offline'])
})

test('total provider failure remains an error and local-only search requires no provider', async () => {
  await assert.rejects(
    searchUnifiedCollections({
      local: { items: [], total: 0 },
      searchLocal: async () => ({ items: [], total: 0 }),
      limit: 30,
      offset: 0,
      providers: [{ id: 'bad', name: 'Bad' }],
      search: async () => {
        throw new Error('offline')
      },
      reportError: () => {}
    }),
    /Bad：offline/
  )
  assert.deepEqual(
    await searchUnifiedCollections({
      local: { items: ['local'], total: 1 },
      searchLocal: async () => ({ items: ['local'], total: 1 }),
      limit: 30,
      offset: 0,
      providers: [],
      search: async () => {
        throw new Error('unexpected request')
      },
      reportError: () => {}
    }),
    { items: ['local'], total: 1 }
  )
})

test('global pages cross source boundaries without duplicate items, gaps or oversized requests', async () => {
  const local = ['local:0', 'local:1']
  const sourceItems = { a: ['a:0', 'a:1', 'a:2', 'a:3', 'a:4'], b: ['b:0', 'b:1', 'b:2'] }
  const searchLocal = async (limit: number, offset: number) => ({
    items: local.slice(offset, offset + limit),
    total: local.length
  })
  const pages: string[][] = []
  for (const offset of [0, 3, 6, 9, 12]) {
    const result = await searchUnifiedCollections({
      local: await searchLocal(3, 0),
      searchLocal,
      providers: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' }
      ],
      limit: 3,
      offset,
      search: async (id, limit, start) => {
        assert.ok(limit <= 3)
        const tracks = sourceItems[id as keyof typeof sourceItems]
        return { items: tracks.slice(start, start + limit), total: tracks.length }
      },
      reportError: (message) => assert.fail(message)
    })
    assert.equal(result.total, 10)
    assert.ok(result.items.length <= 3)
    pages.push(result.items)
  }
  assert.deepEqual(pages, [
    ['local:0', 'local:1', 'a:0'],
    ['a:1', 'a:2', 'a:3'],
    ['a:4', 'b:0', 'b:1'],
    ['b:2'],
    []
  ])
})
