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
  const exports = loadCoverCache(root)
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

test('main cover maintenance joins normalization writes and gates new work without stale memoization', async (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'cover-maintenance-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  let releaseRead!: () => void,
    reads = 0
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve
  })
  const cache = loadCoverCache(root, {
    'fs/promises': {
      ...fsPromises,
      readFile: async (file: string) => {
        reads++
        await readGate
        return fsPromises.readFile(file)
      }
    },
    electron: {
      app: { getPath: () => root },
      nativeImage: {
        createFromBuffer: () => ({
          isEmpty: () => false,
          getSize: () => ({ width: 1000 }),
          resize: () => ({ toJPEG: () => Buffer.from('small-jpeg') })
        })
      }
    }
  })
  const directory = cache.ensureCoverCacheDir()
  fs.writeFileSync(path.join(directory, 'original.png'), 'large')
  const first = cache.normalizeCachedCoverHandle('cover://original.png')
  let entered = false,
    releaseClear!: () => void
  const clearing = cache.maintainCoverCache(async () => {
    entered = true
    const handle = await first
    assert.ok(fs.existsSync(path.join(directory, handle.slice('cover://'.length))))
    await fsPromises.rm(directory, { recursive: true, force: true })
    await fsPromises.mkdir(directory)
    await new Promise<void>((resolve) => {
      releaseClear = resolve
    })
  })
  const next = cache.normalizeCachedCoverHandle('cover://original.png')
  assert.equal(cache.cacheCoverFromBuffer(Buffer.from('during-maintenance')), null)
  await Promise.resolve()
  assert.equal(entered, false)
  assert.equal(reads, 1)
  releaseRead()
  while (!releaseClear) await new Promise((resolve) => setImmediate(resolve))
  releaseClear()
  await clearing
  assert.equal(await next, 'cover://original.png')
  assert.notEqual(await first, await next)
  await assert.rejects(
    cache.maintainCoverCache(async () => {
      throw new Error('clear failed')
    }),
    /clear failed/
  )
  assert.equal(await cache.normalizeCachedCoverHandle('cover://missing.png'), 'cover://missing.png')
})

function loadCoverCache(root: string, overrides: Record<string, unknown> = {}) {
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
    '../cache/backgroundDisplayCache.ts': backgroundDisplay,
    ...overrides
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
  return exports
}
