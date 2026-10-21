import fs from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
const source = fs.readFileSync(new URL('./appBackground.behavior.test.ts', import.meta.url), 'utf8')
const instrumented = source.replace(
  'const checkImage=(expected,label)=>{',
  `const checkImage=(expected,label)=>{const dbg=JSON.stringify({body:getComputedStyle(document.body).backgroundImage,bodyColor:getComputedStyle(document.body).backgroundColor,local:getComputedStyle(document.documentElement).getPropertyValue('--te-local-bg-image'),app:getComputedStyle(document.documentElement).getPropertyValue('--te-app-bg-image'),glass:getComputedStyle(document.documentElement).getPropertyValue('--te-glass-backdrop-image'),material:document.documentElement.dataset.teSurfaceMaterial});`
).replace(
  `expect(actual.startsWith('url("'+expected+'")'),label+': configured image is not the top layer: '+actual)`,
  `if(!actual.startsWith('url("'+expected+'")')) throw Error(label+': configured image is not the top layer: '+actual+' DBG '+dbg)`
)
const target = new URL('./debugBackground.runtime.test.ts', import.meta.url)
fs.writeFileSync(target, instrumented)
await import(pathToFileURL(fileURLToPath(target)).href)
