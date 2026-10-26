'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')

const ROOT = path.resolve(__dirname, '..')
const rel = (file) => path.relative(ROOT, file).replace(/\\/g, '/')
function files(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? files(path.join(directory, entry.name))
        : /\.(?:ts|vue|mjs|cjs)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name)
          ? [path.join(directory, entry.name)]
          : []
    )
}

test('portable Core imports only its business layer, shared contracts and non-platform Node primitives', () => {
  const violations = []
  for (const file of files(path.join(ROOT, 'src/core'))) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest)
    function visit(node) {
      const specifier =
        ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
          ? node.moduleSpecifier
          : ts.isCallExpression(node) &&
              (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                node.expression.getText(source) === 'require')
            ? node.arguments[0]
            : null
      if (specifier) {
        const spec = ts.isStringLiteral(specifier) ? specifier.text : ''
        const target = spec.startsWith('.') ? rel(path.resolve(path.dirname(file), spec)) : spec
        const portable = /^(?:src\/(?:core|shared)\/|node:events$)/.test(target)
        // The plugin repository owns existing on-disk packages/state. OS UI,
        // credentials, paths and process spawning are injected capabilities.
        const repositoryNode =
          /^src\/core\/(?:plugins|persistence|audio|providers|downloads)\//.test(rel(file)) &&
          /^(?:node:(?:crypto|fs|fs\/promises|path|module|http|stream|stream\/promises|timers\/promises)|extract-zip|yauzl|music-metadata|strtok3)$/.test(
            target
          )
        const pluginVendor = /^src\/core\/plugins\/rhine-vendor\//.test(rel(file)) && target === 'opencc-js'
        const pluginIndexNode =
          /^src\/core\/plugins\/index(?:Service|Trust)\.ts$/.test(rel(file)) && /^(?:node:os|node:url)$/.test(target)
        const importFileNode =
          /^src\/core\/playlists\/(?:fileParser|readFile)\.ts$/.test(rel(file)) &&
          /^(?:node:(?:fs\/promises|path|url)|@xmldom\/xmldom|iconv-lite)$/.test(target)
        const lyricsNode =
          /^src\/core\/lyrics\/(?:loadLyrics|localLoader|amllTtml|importLyrics|saveLyrics|files)\.ts$/.test(
            rel(file)
          ) && /^(?:node:(?:fs\/promises|path|crypto|http)|music-metadata)$/.test(target)
        const streamsNode =
          rel(file) === 'src/core/streams/radioMediaService.ts' &&
          /^(?:node:crypto|node:path)$/.test(target)
        const remoteNode =
          rel(file) === 'src/core/remote/service.ts' && target === 'node:crypto'
        const networkNode =
          /^src\/core\/network\//.test(rel(file)) &&
          /^(?:node:(?:crypto|fs|fs\/promises|path|http|https|net|stream|stream\/promises)|basic-ftp|music-metadata)$/.test(
            target
          )
        const castNode =
          /^src\/core\/cast\//.test(rel(file)) &&
          /^(?:node:(?:crypto|dgram|tls|http|fs|path|stream|stream\/web|stream\/promises))$/.test(
            target
          )
        const taglibNode =
          rel(file) === 'src/core/downloads/taglib.ts' && target === 'node-taglib-sharp'
        const analysisEqualityNode =
          rel(file) === 'src/core/audio/fileAnalysisCache.ts' && target === 'node:util'
        const modelArchiveNode =
          rel(file) === 'src/core/audio/autoMixStemInstaller.ts' && target === 'buffer-crc32'
        const cloudTransferNode =
          /^src\/core\/ncm\/(?:cloudTransferHelpers|cloudTransferIo|cloudTransferService)\.ts$/.test(
            rel(file)
          ) &&
          /^(?:node:(?:crypto|fs|fs\/promises|http|https|path|stream|stream\/promises)|music-metadata)$/.test(
            target
          )
        const watcherNode =
          /^src\/core\/library\/watcher(?:Extensions)?\.ts$/.test(rel(file)) &&
          /^(?:node:fs|node:path)$/.test(target)
        const tagJournalNode =
          /^src\/core\/library\/(?:tagWriteService|playlistRepairService)\.ts$/.test(rel(file)) &&
          /^(?:node:fs|node:fs\/promises|node:path|node:crypto)$/.test(target)
        if (
          !portable &&
          !analysisEqualityNode &&
          !modelArchiveNode &&
          !cloudTransferNode &&
          !taglibNode &&
          !repositoryNode &&
          !pluginIndexNode &&
          !pluginVendor &&
          !importFileNode &&
          !lyricsNode &&
          !streamsNode &&
          !remoteNode &&
          !networkNode &&
          !castNode &&
          !watcherNode &&
          !tagJournalNode
        )
          violations.push(`${rel(file)} -> ${target || 'dynamic import target'}`)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  assert.deepEqual(violations, [])
})

test('Core has no browser storage, DOM or renderer bridge globals', () => {
  const core = files(path.join(ROOT, 'src/core'))
  const program = ts.createProgram(core, {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    skipLibCheck: true,
    allowJs: true,
    noEmit: true
  })
  const checker = program.getTypeChecker(),
    violations = []
  const browser = new Set([
    'window',
    'document',
    'localStorage',
    'sessionStorage',
    'indexedDB',
    'navigator',
    'Audio',
    'HTMLAudioElement',
    'HTMLElement',
    'XMLHttpRequest'
  ])
  for (const file of core) {
    const source = program.getSourceFile(file)
    function visit(node) {
      if (
        ts.isIdentifier(node) &&
        browser.has(node.text) &&
        !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
      ) {
        const symbol = checker.getSymbolAtLocation(node)
        // Queue controllers use a local variable named window. Only local
        // symbols are permitted; ambient/browser globals are not dependencies.
        if (!symbol?.declarations?.some((declaration) => declaration.getSourceFile() === source))
          violations.push(`${rel(file)}: ${node.text}`)
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        ['globalThis', 'self'].includes(node.expression.getText(source)) &&
        browser.has(node.name.text)
      )
        violations.push(`${rel(file)}: ${node.getText(source)}`)
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  assert.deepEqual(violations, [])
})

test('no HTMLAudio playback implementation or environment-variable enablement remains', () => {
  const violations = []
  for (const file of [
    ...files(path.join(ROOT, 'src/renderer')),
    ...files(path.join(ROOT, 'src/main'))
  ]) {
    const source = fs.readFileSync(file, 'utf8')
    if (
      /\bHTMLAudioElement\b|\bnew\s+(?:window\.)?Audio\s*\(|\bcreateElement\(['"]audio['"]\)|\bTWILIGHT_ENABLE_HTMLAUDIO_FALLBACK\b/.test(
        source
      )
    )
      violations.push(rel(file))
  }
  assert.deepEqual(violations, [])
})
