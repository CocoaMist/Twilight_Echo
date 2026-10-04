import { registerHooks } from 'node:module'
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname } from 'node:path'

// Vite switches realpath implementations asynchronously on Windows. Expand
// TEMP aliases before fixtures are created so shared mocks stay single modules.
if (process.platform === 'win32') {
  const temporaryRoot = realpathSync.native(tmpdir())
  process.env.TEMP = temporaryRoot
  process.env.TMP = temporaryRoot
}

const renderer = new URL('../src/renderer/src/', import.meta.url)
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith('@renderer/')) return nextResolve(specifier, context)
    const path = specifier.slice('@renderer/'.length)
    let url = new URL(path, renderer)
    if (!extname(path)) {
      url = new URL(`${path}.ts`, renderer)
      if (!existsSync(url)) url = new URL(`${path}/index.ts`, renderer)
    }
    return nextResolve(url.href, context)
  }
})
