import assert from 'node:assert/strict'
import test from 'node:test'
import { createArtworkProjection } from './artworkProjection.ts'

test('Core artwork projects cache handles and re-grants durable or session images without exposing origins', async () => {
  const sources: string[] = []
  const project = createArtworkProjection({
    normalizeCachedCover: async (handle) => handle,
    migrateBase64Cover: () => 'cover://embedded.jpg',
    grant: (source) => {
      sources.push(source)
      return 'twilight-media://image/granted'
    },
    resolve: () => ({ source: 'https://cdn.test/recovered?token=private' })
  })
  const signal = new AbortController().signal
  assert.deepEqual(await project({ cover: 'cover://local.jpg', coverSource: 'https://cdn.test/other' }, signal), { cover: 'cover://local.jpg', coverSource: null })
  assert.deepEqual(await project({ cover: 'data:image/png;base64,AA==', coverSource: null }, signal), { cover: 'cover://embedded.jpg', coverSource: null })
  for (const input of [
    { cover: 'twilight-media://image/old', coverSource: 'https://cdn.test/art?token=private' },
    { cover: 'https://cdn.test/art?token=private', coverSource: null },
    { cover: 'twilight-media://image/live', coverSource: null }
  ]) {
    const result = await project(input, signal)
    assert.equal(result.cover, 'twilight-media://image/granted')
    assert.doesNotMatch(JSON.stringify(result), /https|token|private/)
  }
  assert.equal(sources.length, 3)
  assert.deepEqual(await project({ cover: 'file:///private.jpg', coverSource: null }, signal), { cover: null, coverSource: null })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(project({ cover: null, coverSource: null }, controller.signal), { name: 'AbortError' })
})
