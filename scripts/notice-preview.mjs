// Run with: node scripts/notice-preview.mjs
// Uses the production notice component and store with disposable sample data.
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const server = await createServer({
  configFile: false,
  root,
  plugins: [
    vue(),
    {
      name: 'notice-preview-entry',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url !== '/') return next()
          const html = await server.transformIndexHtml(
            '/',
            `<!doctype html>
          <html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Twilight Echo · 通知栏预览</title></head>
          <body><div id="app"></div><script type="module">
          import { createApp } from 'vue';
          import Preview from '/scripts/notice-preview/NoticePreview.vue';
          import '/node_modules/primeicons/primeicons.css';
          createApp(Preview).mount('#app');
          </script></body></html>`
          )
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.end(html)
        })
      }
    }
  ],
  server: { host: '127.0.0.1', port: 5184, strictPort: true }
})
await server.listen()
server.printUrls()
