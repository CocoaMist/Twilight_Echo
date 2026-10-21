import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { streamLibraryJson } from './libraryJsonStream.ts'

async function read(source: string) {
  const root = mkdtempSync(join(tmpdir(), 'library-json-'))
  try {
    const path = join(root, 'library.json')
    writeFileSync(path, source)
    return await Array.fromAsync(streamLibraryJson(path))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('streams legacy arrays and every envelope member without assembling the records array', async () => {
  const tracks = [
    { id: '中文', filePath: 'a', extra: { nested: [1, null, 'x'] } },
    { id: 'b', filePath: 'b' }
  ]
  for (const source of [
    JSON.stringify(tracks),
    JSON.stringify({ version: 2, tracks, folders: [], exclusions: [] })
  ]) {
    const values = await read(source)
    assert.deepEqual(
      values.filter((item) => item.field === 'tracks').map((item) => item.value),
      tracks
    )
    assert.ok(values.filter((item) => item.field === 'tracks').every((item) => item.arrayItem))
  }
})

test('empty arrays retain their schema signal and scalar headers stay scalar', async () => {
  const values = await read('{"entries":[],"libraryRevision":5,"version":1}')
  assert.deepEqual(values, [
    { field: 'libraryRevision', value: 5, arrayItem: false },
    { field: 'version', value: 1, arrayItem: false },
    { field: '$arrays', value: ['entries'] }
  ])
})

test('rejects malformed envelopes, duplicate keys, truncation and deeply nested metadata', async () => {
  for (const source of [
    'null',
    '{}',
    '{"tracks":{}}',
    '{"tracks":[],"tracks":[]}',
    '{"tracks":[1,',
    '{"tracks":[],"version":[2]}',
    '{"tracks":[],"folders":"x"}',
    '[{"x":' + '['.repeat(64) + '0' + ']'.repeat(64) + '}]'
  ]) {
    await assert.rejects(read(source), source)
  }
})

test('source read errors reject instead of hanging', async () => {
  await assert.rejects(
    Array.fromAsync(streamLibraryJson(join(tmpdir(), 'missing-library-parent', 'none.json'))),
    /ENOENT/
  )
})

test('production CJS bundling preserves the ESM parser and assembler exports', async () => {
  const root = mkdtempSync(join(tmpdir(), 'library-json-cjs-'))
  const require = createRequire(import.meta.url)
  try {
    const { build } = await import('vite')
    await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        ssr: fileURLToPath(new URL('./libraryJsonStream.ts', import.meta.url)),
        outDir: root,
        emptyOutDir: false,
        rollupOptions: {
          external: (id) => id.startsWith('stream-json/'),
          output: {
            format: 'cjs',
            entryFileNames: 'library-json.cjs',
            paths: (id) => (id.startsWith('stream-json/') ? require.resolve(id) : id)
          }
        }
      }
    })
    const bundled = require(join(root, 'library-json.cjs')) as {
      streamLibraryJson: typeof streamLibraryJson
    }
    const path = join(root, 'library.json')
    const track = { id: '中文', filePath: 'a', extra: { nested: [1, null, 'x'] } }
    for (const document of [
      [track],
      { version: 2, tracks: [track], folders: [], exclusions: [] }
    ]) {
      writeFileSync(path, JSON.stringify(document))
      const values = await Array.fromAsync(bundled.streamLibraryJson(path))
      assert.deepEqual(
        values.filter((item) => item.field === 'tracks').map((item) => item.value),
        [track]
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
