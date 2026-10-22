import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { build } from 'vite'

const require = createRequire(import.meta.url)

test('workshop decorations scan added subtrees and release observers in both documents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-decoration-dom-'))
  try {
    await build({
      configFile: false,
      logLevel: 'error',
      build: {
        outDir: join(directory, 'bundle'),
        lib: {
          entry: fileURLToPath(new URL('./workshopDecorations.ts', import.meta.url)),
          name: 'Decorations',
          formats: ['iife'],
          fileName: () => 'runtime.js'
        }
      }
    })
    await writeFile(
      join(directory, 'index.html'),
      '<!doctype html><body><div class="app-shell"><div class="song-list"></div></div><iframe></iframe><script src="bundle/runtime.js"></script>'
    )
    await writeFile(join(directory, 'runner.cjs'), runner)
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs')],
      {
        windowsHide: true,
        timeout: 30_000
      }
    )
    const counters = JSON.parse(result.stdout.match(/DECORATION_DOM (.+)/)![1])
    assert.equal(counters.fullPageScans, 0)
    assert.equal(counters.batches, 100)
    assert.equal(counters.initialRows, 5000)
    assert.equal(counters.documents, 2)
    console.info('Decoration Chromium workload:', JSON.stringify(counters))
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

const runner = `
const {app,BrowserWindow}=require('electron'),path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));
app.whenReady().then(async()=>{try{
 const win=new BrowserWindow({show:false,webPreferences:{contextIsolation:false,offscreen:true,backgroundThrottling:false}});
 win.webContents.on('console-message',event=>console.error(event.message));
 await win.loadFile(path.join(__dirname,'index.html'));
 const result=await win.webContents.executeJavaScript(${JSON.stringify(`(${checkDom.toString()})()`)});
 console.log('DECORATION_DOM',JSON.stringify(result));app.exit(0);
}catch(error){console.error(error.stack);app.exit(1)}});
`

async function checkDom(): Promise<Record<string, number>> {
  const api = (
    window as unknown as {
      Decorations: { mountWorkshopDecorations: (doc: Document) => () => void }
    }
  ).Decorations
  const expect = (condition: unknown, message: string): void => {
    if (!condition) throw Error(message)
  }
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 4; i++) await Promise.resolve()
  }
  const list = document.querySelector('.song-list')!
  for (let i = 0; i < 5000; i++) list.append(document.createElement('span'))
  const dispose = api.mountWorkshopDecorations(document)
  expect(
    list.querySelectorAll(':scope > .workshop-decoration').length === 1,
    'initial surface is missing'
  )
  let fullPageScans = 0
  const originalDocumentQuery = Document.prototype.querySelectorAll
  const originalElementQuery = Element.prototype.querySelectorAll
  Document.prototype.querySelectorAll = function (...args: [selectors: string]) {
    fullPageScans++
    return originalDocumentQuery.apply(this, args)
  }
  Element.prototype.querySelectorAll = function (...args: [selectors: string]) {
    if (this === document.body || this === document.documentElement) fullPageScans++
    return originalElementQuery.apply(this, args)
  }
  const start = performance.now()
  for (let i = 0; i < 100; i++) {
    list.append(document.createElement('span'))
    await settle()
  }
  const elapsedMs = performance.now() - start
  expect(fullPageScans === 0, 'list insertions repeatedly scan the full document')
  Document.prototype.querySelectorAll = originalDocumentQuery
  Element.prototype.querySelectorAll = originalElementQuery
  const wrapper = document.createElement('section')
  document.body.append(wrapper)
  const host = document.createElement('div')
  host.className = 'player-bar'
  host.style.cssText = 'height:10px;overflow:auto'
  wrapper.append(host)
  const nested = document.createElement('div')
  nested.className = 'song-list'
  nested.style.height = '100px'
  host.append(nested)
  await settle()
  expect(
    host.querySelectorAll(':scope > .workshop-decoration').length === 1,
    'new root host is missing'
  )
  expect(
    nested.querySelectorAll(':scope > .workshop-decoration').length === 1,
    'nested surface is missing'
  )
  wrapper.append(host)
  await settle()
  expect(
    host.querySelectorAll(':scope > .workshop-decoration').length === 1,
    'reparenting duplicates a decoration'
  )
  const removed = document.createElement('div')
  removed.className = 'song-list'
  wrapper.append(removed)
  removed.remove()
  await settle()
  expect(
    !removed.querySelector('.workshop-decoration'),
    'detached subtrees still receive decorations'
  )
  host.scrollTop = 31
  host.dispatchEvent(new Event('scroll'))
  expect(
    host
      .querySelector<HTMLElement>(':scope > .workshop-decoration')!
      .style.getPropertyValue('--te-workshop-scroll-y') === '31px',
    'scroll state is not synchronized'
  )
  const frameDoc = document.querySelector('iframe')!.contentDocument!
  frameDoc.body.innerHTML = '<main class="app-shell"></main>'
  const disposeFrame = api.mountWorkshopDecorations(frameDoc)
  frameDoc.body.append(Object.assign(frameDoc.createElement('div'), { className: 'song-list' }))
  await settle()
  expect(
    frameDoc.querySelectorAll('.workshop-decoration').length === 2,
    'cross-document observer misses a surface'
  )
  disposeFrame()
  expect(
    frameDoc.querySelectorAll('.workshop-decoration').length === 0,
    'cross-document cleanup leaves layers'
  )
  wrapper.append(Object.assign(document.createElement('div'), { className: 'song-list' }))
  dispose()
  await settle()
  expect(
    document.querySelectorAll('.workshop-decoration').length === 0,
    'pending work recreates disposed layers'
  )
  return { fullPageScans, batches: 100, initialRows: 5000, documents: 2, elapsedMs }
}
