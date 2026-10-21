import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import * as protocolCache from '../cache/protocolAssetCache.ts'
import * as backgroundDisplay from '../cache/backgroundDisplayCache.ts'

test('GIF cache handles are accepted and served with their original bytes and MIME type', async (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'cover-gif-'))
  t.after(() => {
    protocolCache.resetProtocolAssetCacheForTests()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const dependencies: Record<string, unknown> = {
    electron: {
      app: { getPath: () => root },
      nativeImage: {
        createFromBuffer: () => assert.fail('GIF serving must not require nativeImage')
      }
    },
    fs,
    'fs/promises': fsPromises,
    path,
    crypto,
    '../cache/ncmCache.ts': { getMusicCacheRoot: () => path.join(root, 'music-cache') },
    '../cache/protocolAssetCache': protocolCache,
    '../cache/backgroundDisplayCache.ts': backgroundDisplay
  }
  const exports = {} as typeof import('./coverCache.ts')
  runInNewContext(
    ts.transpileModule(fs.readFileSync(new URL('./coverCache.ts', import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText,
    {
      exports,
      Buffer,
      require: (id: string) => {
        assert.ok(id in dependencies, id)
        return dependencies[id]
      }
    }
  )
  const bytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
  for (const [directory, name] of [
    [exports.getCoverCacheDir(), 'current.gif'],
    [exports.getLegacyCoverCacheDir(), 'legacy.GIF']
  ]) {
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, name), bytes)
    assert.equal(exports.isCoverCacheFileName(name), true)
    assert.equal(exports.getCoverCacheContentType(name), 'image/gif')
    assert.deepEqual(await exports.readCoverCacheFileBytes(name), bytes)
    assert.equal(await exports.normalizeCachedCoverHandle(`cover://${name}`), `cover://${name}`)
  }
  assert.equal(exports.isCoverCacheFileName('cover.svg'), false)
  assert.equal(exports.isCoverCacheFileName('cover.html'), false)
})
