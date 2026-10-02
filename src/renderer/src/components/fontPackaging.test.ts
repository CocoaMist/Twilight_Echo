import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { brotliDecompressSync } from 'node:zlib'

function readWoff2SmoothingRanges(bytes: Buffer): { version: number; ranges: [number, number][] } {
  assert.equal(bytes.toString('ascii', 0, 4), 'wOF2')
  let cursor = 48
  let streamOffset = 0
  let gaspOffset = -1
  let gaspLength = 0
  function readBase128(): number {
    let value = 0
    for (let index = 0; index < 5; index++) {
      const byte = bytes[cursor++]
      value = value * 128 + (byte & 0x7f)
      if ((byte & 0x80) === 0) return value
    }
    throw new Error('Invalid WOFF2 table length')
  }
  for (let index = 0; index < bytes.readUInt16BE(12); index++) {
    const flags = bytes[cursor++]
    const tagIndex = flags & 0x3f
    let isGasp = tagIndex === 17
    if (tagIndex === 63) {
      isGasp = bytes.toString('ascii', cursor, cursor + 4) === 'gasp'
      cursor += 4
    }
    const length = readBase128()
    const version = flags >> 6
    const transformed = tagIndex === 10 || tagIndex === 11 ? version !== 3 : version !== 0
    const streamLength = transformed ? readBase128() : length
    if (isGasp) {
      assert.equal(transformed, false)
      gaspOffset = streamOffset
      gaspLength = length
    }
    streamOffset += streamLength
  }
  assert.ok(gaspOffset >= 0, 'font must declare its smoothing behavior')
  const stream = brotliDecompressSync(bytes.subarray(cursor, cursor + bytes.readUInt32BE(20)))
  const gasp = stream.subarray(gaspOffset, gaspOffset + gaspLength)
  const ranges: [number, number][] = []
  for (let index = 0; index < gasp.readUInt16BE(2); index++) {
    ranges.push([gasp.readUInt16BE(4 + index * 4), gasp.readUInt16BE(6 + index * 4)])
  }
  return { version: gasp.readUInt16BE(0), ranges }
}

test('packaged MiSans keeps multi-axis smoothing enabled at small UI sizes', () => {
  const fontDir = new URL('../../../../resources/font/misans/', import.meta.url)
  for (const filename of readdirSync(fontDir).filter((name) => name.endsWith('.woff2'))) {
    const { version, ranges } = readWoff2SmoothingRanges(readFileSync(new URL(filename, fontDir)))
    assert.equal(version, 1, `${filename}: symmetric smoothing requires gasp version 1`)
    for (const ppem of [9, 12, 13, 14, 16, 20]) {
      const range = ranges.find(([maximum]) => ppem <= maximum)
      assert.ok(range, `${filename}: missing smoothing range for ${ppem}px`)
      assert.ok(range[1] & 0x0008, `${filename}: multi-axis smoothing disabled at ${ppem}px`)
    }
  }
})

test('renderer CSS packages the licensed built-in font style library and excludes legacy families', () => {
  const base = readFileSync(new URL('../assets/base.css', import.meta.url), 'utf8')
  const fonts = readFileSync(new URL('../assets/fonts.css', import.meta.url), 'utf8')
  const indexHtml = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
  const settings = readFileSync(new URL('./SettingsPage.vue', import.meta.url), 'utf8')
  const settingsCss = readFileSync(
    new URL('./settings-page/SettingsPage.css', import.meta.url),
    'utf8'
  )
  const combined = `${base}\n${fonts}\n${indexHtml}\n${settings}\n${settingsCss}`

  assert.match(fonts, /font-family: 'Inter'/)
  assert.match(fonts, /font-family: 'Plus Jakarta Sans'/)
  assert.match(fonts, /font-family: 'Lora'/)
  assert.match(fonts, /font-family: 'JetBrains Mono'/)
  assert.match(fonts, /font-family: 'Space Grotesk'/)
  assert.match(fonts, /url\(['"]?\/font\/Inter/)
  assert.match(fonts, /url\(['"]?\/font\/PlusJakartaSans/)
  assert.match(base, /--te-font-sans:[\s\S]*Inter/)
  assert.match(base, /--te-font-sans:[\s\S]*MiSans/)
  assert.match(base, /--te-font-display:[\s\S]*Plus Jakarta Sans/)
  assert.match(base, /--te-font-display:[\s\S]*MiSans/)
  assert.match(indexHtml, /<link rel="stylesheet" href="\/font\/misans\/misans\.css"/)
  assert.doesNotMatch(indexHtml, /misans\/full\/misans-full\.css/)

  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
  const fontDir = join(repoRoot, 'resources/font')
  const misansDir = join(fontDir, 'misans')
  assert.equal(existsSync(join(fontDir, 'Inter-latin-wght-normal.woff2')), true)
  assert.equal(existsSync(join(fontDir, 'PlusJakartaSans-latin-wght-normal.woff2')), true)
  assert.equal(existsSync(join(fontDir, 'Lora-latin-wght-normal.woff2')), true)
  assert.equal(existsSync(join(fontDir, 'JetBrainsMono-latin-wght-normal.woff2')), true)
  assert.equal(existsSync(join(fontDir, 'SpaceGrotesk-latin-wght-normal.woff2')), true)
  assert.equal(existsSync(join(fontDir, 'OFL-Lora.txt')), true)
  assert.equal(existsSync(join(fontDir, 'OFL-JetBrainsMono.txt')), true)
  assert.equal(existsSync(join(fontDir, 'OFL-SpaceGrotesk.txt')), true)
  assert.equal(existsSync(join(misansDir, 'misans.css')), true)
  assert.equal(existsSync(join(misansDir, 'LICENSE')), true)
  const misansCss = readFileSync(join(misansDir, 'misans.css'), 'utf8')
  assert.match(misansCss, /font-family:\s*MiSans/)
  assert.match(misansCss, /url\(['"]?\.\//)
  assert.doesNotMatch(base, /MiSans Full/)
  const woff2 = readdirSync(misansDir).filter((n) => n.endsWith('.woff2'))
  assert.ok(woff2.length >= 100, `expected MiSans subset files, got ${woff2.length}`)

  // Historical / rejected families must stay out of renderer CSS.
  assert.doesNotMatch(combined, /Outfit|Noto Sans SC|Nunito/)
})
