// Browser-only SongList acceptance fixture. Real SQLite queries, synthetic media,
// and an isolated playback boundary; no personal profile or Electron settings.
// node --experimental-strip-types scripts/preview-sqlite-song-list.mjs [count]
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { createServer } from 'vite'
import { LibraryDatabase } from '../src/main/library/libraryDatabase.ts'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const count = Number(process.argv[2] ?? 1205)
if (!Number.isSafeInteger(count) || count < 1 || count > 300_000) throw new Error('count: 1–300000')
const db = new LibraryDatabase(':memory:')
db.replaceDocument({
  version: 2,
  revision: 0,
  folders: [],
  exclusions: [],
  tracks: Array.from({ length: count }, (_, index) => ({
    id: String(index),
    title: `月光 ${String(index).padStart(6, '0')}`,
    artist: `测试艺术家 ${index % 10}`,
    album: `测试专辑 ${Math.floor(index / 20)}`,
    filePath: `D:/SyntheticMusic/${index}.flac`,
    fileName: `${index}.flac`,
    duration: 180 + (index % 60),
    format: 'FLAC',
    sampleRate: 44100,
    bitDepth: 24,
    size: 1,
    source: 'local',
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
    port: 5198,
    strictPort: true,
    watch: { ignored: ['**/tmp/**', '**/out/**'] }
  },
  plugins: [
    {
      name: 'sqlite-song-list-fixture',
      enforce: 'pre',
      resolveId(source) {
        if (/\/stores\/usePlayerStore(?:\.ts)?$/.test(source)) return '\0sqlite-song-list-player'
      },
      load(id) {
        if (id === '\0sqlite-song-list-player')
          return 'export const usePlayerStore = () => window.songListPlayer'
      },
      configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          if (request.url === '/') {
            response.setHeader('Content-Type', 'text/html; charset=utf-8')
            response.end(
              await vite.transformIndexHtml(
                '/',
                `<!doctype html>
            <html data-theme="pureWhite"><head><meta charset="utf-8"><title>SQLite SongList fixture</title></head>
            <body><div id="app"></div><script type="module" src="/scripts/fixtures/sqlite-song-list.mjs"></script></body></html>`
              )
            )
            return
          }
          if (request.url !== '/fixture/query' || request.method !== 'POST') return next()
          try {
            let body = ''
            for await (const chunk of request) {
              body += chunk
              if (body.length > 32_768) throw new Error('Fixture query too large')
            }
            const query = JSON.parse(body)
            if (query.limit > 200) throw new Error('Fixture reads must remain bounded')
            response.setHeader('Content-Type', 'application/json; charset=utf-8')
            response.end(JSON.stringify(db.queryTracks(query)))
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
      vue: require.resolve('vue/dist/vue.esm-bundler.js'),
      pinia: resolve(dirname(require.resolve('pinia/package.json')), 'dist/pinia.mjs')
    }
  },
  define: { 'process.env.NODE_ENV': '"development"', 'process.env': '{}' }
})
await server.listen()
console.log(`SQLite SongList fixture: http://127.0.0.1:5198/ (${count} synthetic tracks)`)
const close = async () => {
  await server.close()
  db.close()
  process.exit(0)
}
process.once('SIGINT', close)
process.once('SIGTERM', close)
