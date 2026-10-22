// Isolated browser fixture: real SQLite queue, production drawer/dialog and
// playlist transaction owner. Synthetic media only; no personal profile access.
// node --experimental-strip-types scripts/preview-sqlite-queue.mjs
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { createServer } from 'vite'
import { LibraryDatabase } from '../src/main/library/libraryDatabase.ts'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const db = new LibraryDatabase(':memory:')
db.replaceDocument({
  version: 2,
  revision: 0,
  folders: [],
  exclusions: [],
  tracks: Array.from({ length: 605 }, (_, index) => ({
    id: String(index),
    title: `月光 ${String(index).padStart(3, '0')}`,
    artist: '测试艺术家',
    album: '测试专辑',
    filePath: `D:/SyntheticMusic/${index}.flac`,
    duration: 180,
    cover: null,
    lyrics: null
  }))
})
const server = await createServer({
  configFile: false,
  root,
  logLevel: 'warn',
  server: {
    host: '127.0.0.1',
    port: 5199,
    strictPort: true,
    watch: { ignored: ['**/tmp/**', '**/out/**'] }
  },
  plugins: [
    {
      name: 'sqlite-queue-preview',
      configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          if (request.url === '/') {
            response.setHeader('Content-Type', 'text/html; charset=utf-8')
            response.end(
              await vite.transformIndexHtml(
                '/',
                '<!doctype html><html data-theme="pureWhite"><head><meta charset="utf-8"><title>SQLite queue save fixture</title></head><body><div id="app"></div><script type="module" src="/scripts/fixtures/sqlite-queue.mjs"></script></body></html>'
              )
            )
            return
          }
          if (request.url !== '/fixture/queue' || request.method !== 'POST') return next()
          try {
            let body = ''
            for await (const chunk of request) {
              body += chunk
              if (body.length > 32768) throw new Error('request too large')
            }
            const { kind, args } = JSON.parse(body)
            const commands = {
              create: 'createLibraryQueue',
              get: 'getLibraryQueue',
              read: 'readLibraryQueue',
              edit: 'editLibraryQueue',
              delete: 'deleteLibraryQueue'
            }
            if (!Object.hasOwn(commands, kind)) throw new Error('unknown fixture command')
            const value = db[commands[kind]](...args)
            response.setHeader('Content-Type', 'application/json; charset=utf-8')
            response.end(JSON.stringify(value))
          } catch (error) {
            response.statusCode = 400
            response.end(JSON.stringify({ error: String(error) }))
          }
        })
      }
    },
    vue()
  ],
  resolve: {
    alias: {
      '@renderer': resolve(root, 'src/renderer/src'),
      vue: require.resolve('vue/dist/vue.esm-bundler.js')
    }
  },
  define: { 'process.env.NODE_ENV': '"development"', 'process.env': '{}' }
})
await server.listen()
console.log('SQLite queue fixture: http://127.0.0.1:5199/')
const close = async () => {
  await server.close()
  db.close()
  process.exit(0)
}
process.once('SIGINT', close)
process.once('SIGTERM', close)
