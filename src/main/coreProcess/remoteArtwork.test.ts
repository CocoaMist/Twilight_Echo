import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { validCorePlatformPayload, type CorePlatformRequest } from '../../shared/corePlatform.ts'

const source = readFileSync(new URL('./remoteArtwork.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('artwork.ts', source, ts.ScriptTarget.Latest, true)
const body = ast.statements
  .filter((s) => !ts.isImportDeclaration(s))
  .map((s) => s.getText(ast).replace(/^export /, ''))
  .join('\n')
const code = ts.transpileModule(`${body}\nresolveRemoteArtwork`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
}).outputText
test('remote artwork accepts only controlled raster references at the platform boundary', () => {
  const valid = (cover: string | null) =>
    validCorePlatformPayload({
      kind: 'core:platform',
      epoch: 'one',
      requestId: 'artwork',
      name: 'artwork.remotePreview',
      payload: { cover }
    } as CorePlatformRequest)
  assert.equal(valid(null), true)
  assert.equal(valid('cover://fixture.png'), true)
  assert.equal(valid('twilight-media://image/grant'), true)
  assert.equal(valid('https://private-source/cover.jpg?token=secret'), false)
  assert.equal(valid('file:///D:/private.png'), false)
  assert.equal(valid('data:image/svg+xml;base64,PHN2Zz4='), false)
})
test('phone artwork resolves grants to bounded raster bytes and never exports source URLs', async () => {
  const reads: string[] = []
  const resolve = runInNewContext(code, {
    Buffer,
    Request,
    Uint8Array,
    globalThis: { fetch: async () => {} },
    isCoverCacheFileName: (name: string) => name === 'fixture.png',
    readCoverCacheFileBytes: async (name: string) => {
      reads.push(name)
      return new Uint8Array([1, 2, 3])
    },
    getCoverCacheContentType: () => 'image/png',
    resizeCoverImageBytes: () => ({ bytes: new Uint8Array([4]), mime: 'image/jpeg' }),
    createRemoteMediaRequestHandler: () => async () =>
      new Response(new Uint8Array(190_000), { headers: { 'content-type': 'image/png' } })
  }) as (cover: string | null, signal: AbortSignal) => Promise<string | null>
  const signal = new AbortController().signal
  assert.equal(await resolve('cover://fixture.png', signal), 'data:image/png;base64,AQID')
  assert.deepEqual(reads, ['fixture.png'])
  assert.equal(await resolve('cover://../../private.png', signal), null)
  assert.equal(await resolve('twilight-media://image/grant', signal), 'data:image/jpeg;base64,BA==')
  assert.equal(await resolve('https://private-source/cover.png', signal), null)
  assert.equal(await resolve('data:image/png;base64,' + 'A'.repeat(250_000), signal), null)
})
