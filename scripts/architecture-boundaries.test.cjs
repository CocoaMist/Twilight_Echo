'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const { builtinModules } = require('node:module')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')

const ROOT = path.join(__dirname, '..')

test('lyric internals never import the compatibility facade or reverse their dependency layers', () => {
  const utils = path.join(ROOT, 'src', 'renderer', 'src', 'utils')
  const layers = {
    'lyricTypes.ts': 0,
    'lyricParser.ts': 1,
    'embeddedLyricLayers.ts': 1,
    'amllTtml.ts': 1,
    'lyricLineBuilder.ts': 2,
    'lyrics.ts': 3
  }
  for (const [name, layer] of Object.entries(layers)) {
    if (name === 'lyrics.ts') continue
    for (const specifier of collectImports(path.join(utils, name))) {
      const target = resolveImportTarget(path.join(utils, name), specifier)
      if (!target) continue
      const dependency = path.basename(target)
      if (dependency in layers)
        assert.ok(layers[dependency] < layer, `${name} must not depend on ${dependency}`)
    }
  }
})

test('IPC channels are consistently registered in main and exposed through preload', () => {
  const sorted = (values) => [...new Set(values)].sort()
  const mainHandle = []
  const mainOn = []
  const preloadChannels = []
  for (const file of walk(path.join(ROOT, 'src', 'main'))) {
    if (isTestFile(file)) continue
    const source = fs.readFileSync(file, 'utf8')
    for (const m of source.matchAll(/\bipcMain\s*\.\s*handle(?:Once)?\s*\(\s*(['"])([^'"]+)\1/g)) {
      mainHandle.push(m[2])
    }
    for (const m of source.matchAll(/\bipcMain\s*\.\s*on\s*\(\s*(['"])([^'"]+)\1/g)) {
      mainOn.push(m[2])
    }
  }
  for (const file of walk(path.join(ROOT, 'src', 'preload'))) {
    if (isTestFile(file)) continue
    const source = fs.readFileSync(file, 'utf8')
    for (const m of source.matchAll(/[\w:.-]+:/g)) {
      const candidate = m[0].replace(/[\s]+$/, '')
      if (/^[a-zA-Z][\w.-]*:[\w.-]*$/.test(candidate)) preloadChannels.push(candidate)
    }
    for (const m of source.matchAll(/['"]([\w.-]+:[\w.-]+)['"]/g)) {
      preloadChannels.push(m[1])
    }
  }
  const preloadSet = new Set(preloadChannels)
  assert.deepEqual(
    sorted(mainHandle).filter((ch) => !preloadSet.has(ch)),
    []
  )
  assert.deepEqual(
    sorted(mainOn).filter((ch) => !preloadSet.has(ch)),
    []
  )
})

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      out.push(...walk(full))
    } else if (/\.(?:ts|vue|cjs|mjs)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

function rel(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/')
}

function collectImports(file) {
  const source = fs.readFileSync(file, 'utf8')
  const imports = []
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      imports.push(match[1])
    }
  }
  return imports
}

function isTestFile(file) {
  return /\.(?:test|spec)\.[^.]+$/.test(file)
}

function resolveImportTarget(file, specifier) {
  if (specifier.startsWith('@renderer/')) {
    return path.resolve(ROOT, 'src', 'renderer', 'src', specifier.slice('@renderer/'.length))
  }
  if (specifier === '@renderer') return path.resolve(ROOT, 'src', 'renderer', 'src')
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    return path.resolve(path.dirname(file), specifier)
  }
  if (specifier.startsWith('src/')) return path.resolve(ROOT, specifier)
  return null
}

function importLayer(file, specifier) {
  const target = resolveImportTarget(file, specifier)
  if (target === null) return null
  const relative = rel(target)
  for (const layer of ['main', 'preload', 'renderer', 'shared']) {
    if (relative === `src/${layer}` || relative.startsWith(`src/${layer}/`)) return layer
  }
  return null
}

function isNodeBuiltin(specifier) {
  if (specifier.startsWith('node:')) return true
  return builtinModules.includes(specifier) || builtinModules.includes(`node:${specifier}`)
}

function isElectronImport(specifier) {
  return specifier === 'electron' || specifier.startsWith('electron/')
}

function assertNoViolations(violations) {
  assert.deepEqual(violations, [])
}

test('shared contracts never depend on main/preload/renderer', () => {
  const violations = []
  for (const file of walk(path.join(ROOT, 'src', 'shared'))) {
    if (isTestFile(file)) continue
    for (const spec of collectImports(file)) {
      const layer = importLayer(file, spec)
      if (layer !== null && layer !== 'shared') {
        violations.push(rel(file) + ' -> ' + spec)
      }
      if (isNodeBuiltin(spec) || isElectronImport(spec)) violations.push(rel(file) + ' -> ' + spec)
    }
  }
  assertNoViolations(violations)
})

test('preload never depends on main internals or renderer internals', () => {
  const violations = []
  for (const file of walk(path.join(ROOT, 'src', 'preload'))) {
    for (const spec of collectImports(file)) {
      if (isTestFile(file)) continue
      const layer = importLayer(file, spec)
      if (layer === 'main' || layer === 'renderer') violations.push(rel(file) + ' -> ' + spec)
    }
  }
  assertNoViolations(violations)
})

test('main never depends on renderer internals', () => {
  const violations = []
  for (const file of walk(path.join(ROOT, 'src', 'main'))) {
    if (isTestFile(file)) continue
    for (const spec of collectImports(file)) {
      const layer = importLayer(file, spec)
      if (layer === 'renderer') violations.push(rel(file) + ' -> ' + spec)
    }
  }
  assertNoViolations(violations)
})

test('renderer source never imports Electron, Node builtins, or main internals', () => {
  const violations = []
  for (const file of walk(path.join(ROOT, 'src', 'renderer'))) {
    if (file.endsWith('.d.ts') || file.includes('env.d.ts')) continue
    if (isTestFile(file)) continue
    for (const spec of collectImports(file)) {
      if (isElectronImport(spec)) {
        violations.push(rel(file) + ' -> electron')
      }
      if (isNodeBuiltin(spec)) violations.push(rel(file) + ' -> ' + spec)
      const layer = importLayer(file, spec)
      if (layer === 'main') violations.push(rel(file) + ' -> ' + spec)
      const target = resolveImportTarget(file, spec)
      const targetRelative = target === null ? '' : rel(target)
      const isPublicPreloadType =
        layer === 'preload' &&
        /^src\/preload\/(?:types(?:\.ts)?|index\.d\.ts)$/.test(targetRelative)
      if (layer === 'preload' && !isPublicPreloadType) {
        violations.push(rel(file) + ' -> ' + spec)
      }
    }
  }
  assertNoViolations(violations)
})

test('renderer utils never reach across the IPC bridge or preload runtime', () => {
  const violations = []
  for (const file of walk(path.join(ROOT, 'src', 'renderer', 'src', 'utils'))) {
    if (isTestFile(file)) continue
    const source = fs.readFileSync(file, 'utf8')
    if (/\bwindow\.api\b/.test(source)) violations.push(rel(file) + ' touches window.api')
    if (/\bipcRenderer\b/.test(source)) violations.push(rel(file) + ' touches ipcRenderer')
  }
  assertNoViolations(violations)
})

test('main eager runtime imports are acyclic', () => {
  const files = walk(path.join(ROOT, 'src', 'main')).filter(
    (file) => !isTestFile(file) && !file.endsWith('.d.ts')
  )
  const fileSet = new Set(files)
  const graph = new Map(files.map((file) => [file, new Set()]))
  for (const file of files) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest)
    const add = (specifier) => {
      const target = resolveImportTarget(file, specifier)
      if (target === null) return
      const resolved = [target, target + '.ts', path.join(target, 'index.ts')].find((candidate) =>
        fileSet.has(candidate)
      )
      if (resolved) graph.get(file).add(resolved)
    }
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause
        if (clause?.isTypeOnly) continue
        if (
          clause &&
          !clause.name &&
          clause.namedBindings &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.length > 0 &&
          clause.namedBindings.elements.every((element) => element.isTypeOnly)
        )
          continue
        add(statement.moduleSpecifier.text)
      } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
        if (statement.isTypeOnly) continue
        if (
          statement.exportClause &&
          ts.isNamedExports(statement.exportClause) &&
          statement.exportClause.elements.length > 0 &&
          statement.exportClause.elements.every((element) => element.isTypeOnly)
        )
          continue
        add(statement.moduleSpecifier.text)
      }
    }
  }
  // Only eager imports participate: type references erase at build time and
  // deferred import() calls do not cause module-initialization cycles.
  const active = new Set()
  const visited = new Set()
  const chain = []
  const cycles = []
  const visit = (file) => {
    if (active.has(file)) {
      cycles.push([...chain.slice(chain.indexOf(file)), file].map(rel).join(' -> '))
      return
    }
    if (visited.has(file)) return
    active.add(file)
    chain.push(file)
    for (const dependency of graph.get(file)) visit(dependency)
    chain.pop()
    active.delete(file)
    visited.add(file)
  }
  for (const file of files) visit(file)
  assertNoViolations(cycles)
})
