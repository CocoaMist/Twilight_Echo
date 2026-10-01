import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseWindowsFontFamilies,
  listInstalledFontFamilies,
  createFontFamilyLoader
} from './fontRegistry.ts'

test('font loader shares one pending query and caches the successful catalog', async () => {
  let calls = 0
  let complete!: (fonts: string[]) => void
  const loader = createFontFamilyLoader(() => {
    calls++
    return new Promise((resolve) => {
      complete = resolve
    })
  })
  const first = loader.list()
  const second = loader.list()
  await Promise.resolve()
  assert.equal(calls, 1)
  complete(['宋体', 'Segoe UI'])
  assert.deepEqual(await first, ['宋体', 'Segoe UI'])
  assert.deepEqual(await second, ['宋体', 'Segoe UI'])
  assert.deepEqual(await loader.list(), ['宋体', 'Segoe UI'])
  assert.equal(calls, 1)
})

test('font loader retries a failed or empty query rather than caching absence', async () => {
  let calls = 0
  const loader = createFontFamilyLoader(async () => {
    calls++
    if (calls === 1) throw new Error('cold registry startup timed out')
    return calls === 2 ? [] : ['宋体']
  })
  assert.deepEqual(await loader.list(), [])
  assert.deepEqual(await loader.list(), [])
  assert.deepEqual(await loader.list(), ['宋体'])
  assert.deepEqual(await loader.list(), ['宋体'])
  assert.equal(calls, 3)
})

test('clearing during a font query cannot replace a newer catalog with stale results', async () => {
  const completions: Array<(fonts: string[]) => void> = []
  const loader = createFontFamilyLoader(() => new Promise((resolve) => completions.push(resolve)))
  const first = loader.list()
  await Promise.resolve()
  loader.clear()
  const second = loader.list()
  await Promise.resolve()
  completions[1]!(['Segoe UI'])
  await second
  completions[0]!(['Old font'])
  await first
  assert.deepEqual(await loader.list(), ['Segoe UI'])
})

test(
  'Windows font registry uses Unicode names without replacement characters',
  { skip: process.platform !== 'win32' },
  async () => {
    const fonts = await listInstalledFontFamilies()
    assert.ok(fonts.length > 0)
    assert.ok(fonts.every((font) => !font.includes('\ufffd')))
  }
)

const REGISTRY_SAMPLE = [
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
  '    Arial (TrueType)    REG_SZ    arial.ttf',
  '    Arial Bold (TrueType)    REG_SZ    arialbd.ttf',
  '    Arial Bold Italic (TrueType)    REG_SZ    arialbi.ttf',
  '    Segoe UI Semibold (TrueType)    REG_SZ    segoeuisb.ttf',
  '    宋体 & 新宋体 & 仿宋 (TrueType)    REG_SZ    simsun.ttc',
  // Windows registers the vertical-writing alias alongside the real family.
  '    Microsoft YaHei & Microsoft YaHei UI (TrueType)    REG_SZ    msyh.ttc',
  '    @Microsoft YaHei & @Microsoft YaHei UI (TrueType)    REG_SZ    msyh.ttc',
  '    Cascadia Mono (OpenType)    REG_SZ    CascadiaMono.ttf',
  ''
].join('\r\n')

test('parseWindowsFontFamilies collapses styles into one family entry', () => {
  const families = parseWindowsFontFamilies(REGISTRY_SAMPLE)

  assert.equal(
    families.filter((family) => family === 'Arial').length,
    1,
    'Arial, Arial Bold and Arial Bold Italic are one family'
  )
  assert.ok(families.includes('Segoe UI'), 'Semibold is a weight, not a family')
  assert.ok(families.includes('Cascadia Mono'), 'OpenType tag is stripped like TrueType')
})

test('parseWindowsFontFamilies splits localized aliases and drops vertical variants', () => {
  const families = parseWindowsFontFamilies(REGISTRY_SAMPLE)

  for (const family of ['宋体', '新宋体', '仿宋']) {
    assert.ok(families.includes(family), `${family} is registered under a shared value`)
  }
  assert.ok(
    !families.some((family) => family.startsWith('@')),
    '@-prefixed vertical writing aliases duplicate an existing family'
  )
  assert.ok(families.includes('Microsoft YaHei'), 'the family behind the @ alias still resolves')
})

test('parseWindowsFontFamilies returns a sorted, deduplicated list', () => {
  const families = parseWindowsFontFamilies(
    [
      '    Verdana (TrueType)    REG_SZ    verdana.ttf',
      '    Calibri (TrueType)    REG_SZ    calibri.ttf',
      '    Verdana Italic (TrueType)    REG_SZ    verdanai.ttf'
    ].join('\n')
  )

  assert.deepEqual(families, ['Calibri', 'Verdana'])
})

test('parseWindowsFontFamilies ignores registry chrome and malformed rows', () => {
  const families = parseWindowsFontFamilies(
    [
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
      '',
      'ERROR: The system was unable to find the specified registry key or value.',
      '    (TrueType)    REG_SZ    orphan.ttf',
      '    Tahoma (TrueType)    REG_SZ    tahoma.ttf'
    ].join('\n')
  )

  assert.deepEqual(families, ['Tahoma'])
})

test('parseWindowsFontFamilies keeps a style-only name rather than dropping it', () => {
  // "Bold" as an entire family name must survive: stripping it would leave an
  // empty string and silently lose the font.
  const families = parseWindowsFontFamilies('    Bold (TrueType)    REG_SZ    bold.ttf')

  assert.deepEqual(families, ['Bold'])
})
