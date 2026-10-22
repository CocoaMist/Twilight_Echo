import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const transpile = (source: string) =>
  ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText

test('real Electron quits once with an Afterglow anchor and a stuck diagnostic writer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-quit-'))
  try {
    const source = await readFile(new URL('./lifecycle.ts', import.meta.url), 'utf8')
    const ast = ts.createSourceFile('lifecycle.ts', source, ts.ScriptTarget.Latest, true)
    let beforeQuit = ''
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(ast) === 'app.on' &&
        ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text === 'before-quit'
      )
        beforeQuit = node.getText(ast)
      ts.forEachChild(node, visit)
    }
    visit(ast)
    assert.ok(beforeQuit)
    const quit = await readFile(new URL('../diagnostics/quit.ts', import.meta.url), 'utf8')
    const runner = join(directory, 'runner.cjs')
    await writeFile(
      runner,
      `
      const {app,BaseWindow}=require('electron');
      app.disableHardwareAcceleration();
      app.setPath('userData',${JSON.stringify(join(directory, 'profile'))});
      const runtime={forceQuit:false};
      let anchor,cleaned=false;
      const shutdownAfterglowMode=()=>{if(anchor&&!anchor.isDestroyed())anchor.destroy();cleaned=true};
      const destroyDesktopLyrics=()=>{},destroyDynamicIsland=()=>{};
      ${transpile(beforeQuit)}
      { const exports={}; ${transpile(quit)}
        exports.registerDiagnosticQuit(app,()=>new Promise(()=>{}),50);
      }
      app.on('quit',()=>{
        if(!runtime.forceQuit||!cleaned||!anchor.isDestroyed())process.exitCode=1;
        else console.log('AFTERGLOW_SINGLE_QUIT_OK');
      });
      app.whenReady().then(()=>{
        anchor=new BaseWindow({show:false,closable:false,skipTaskbar:true});
        app.quit();
      });
    `
    )
    const result = await promisify(execFile)(require('electron'), ['--no-sandbox', runner], {
      windowsHide: true,
      timeout: 15000
    })
    assert.match(result.stdout, /AFTERGLOW_SINGLE_QUIT_OK/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})
