import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { parsePersonalMusicArtwork, PERSONAL_MUSIC_ARTWORK_MAX_BYTES } from './personalMusicArtwork.ts'
import { validEntityMetadataPayload } from './entityMetadata.ts'

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWP4DwQACfsD/c8LaHIAAAAASUVORK5CYII='
test('personal artwork validates actual bitmap MIME, bounded canonical bytes and dimensions, not a URL or SVG', () => {
  assert.deepEqual(parsePersonalMusicArtwork(png), { dataUrl: png, mime: 'image/png', bytes: 68, width: 1, height: 1 })
  for (const invalid of ['https://example.com/image.png', 'file:///secret', 'data:image/svg+xml;base64,PHN2Zy8+',
    'data:image/png;base64,PHN2Zy8+', png.replace('image/png', 'image/jpeg'), png.slice(0, -4), `${png}x`,
    `data:image/png;base64,${Buffer.alloc(PERSONAL_MUSIC_ARTWORK_MAX_BYTES + 1).toString('base64')}`])
    assert.equal(parsePersonalMusicArtwork(invalid), null)
  const oversized = Buffer.from(png.split(',')[1], 'base64'); oversized.writeUInt32BE(8193, 16)
  assert.equal(parsePersonalMusicArtwork(`data:image/png;base64,${oversized.toString('base64')}`), null)
})

test('public personal metadata payloads reject cache handles, unknown fields, extra bytes on clear and invalid providers', () => {
  const base = { entityId: 'artist', revision: 0, language: 'en' }
  assert.equal(validEntityMetadataPayload('metadata.entity.artworkOverride', { ...base, mode: 'value', dataUrl: png }), true)
  assert.equal(validEntityMetadataPayload('metadata.entity.artworkOverride', { ...base, mode: 'clear' }), true)
  assert.equal(validEntityMetadataPayload('metadata.entity.artworkOverride', { ...base, mode: 'clear', dataUrl: png }), false)
  assert.equal(validEntityMetadataPayload('metadata.entity.artworkOverride', { ...base, mode: 'value', dataUrl: 'cover:handle' }), false)
  assert.equal(validEntityMetadataPayload('metadata.entity.sourcePreference', { ...base, provider: null }), true)
  assert.equal(validEntityMetadataPayload('metadata.entity.sourcePreference', { ...base, provider: 'wikipedia' }), true)
  assert.equal(validEntityMetadataPayload('metadata.entity.sourcePreference', { ...base, provider: 'https://provider' }), false)
  assert.equal(validEntityMetadataPayload('metadata.entity.sourcePreference', { ...base, provider: 'ncm', platformContext: 'forged' }), false)
})

test('real repository JPEG and WebP bitmaps pass their actual headers, while mismatched MIME and truncation fail', () => {
  for (const [path, mime] of [['../../resources/sponsor/alipay.jpg', 'image/jpeg'],
    ['../renderer/src/assets/images/default-track-cover-dark.webp', 'image/webp']]) {
    const bytes = readFileSync(new URL(path, import.meta.url))
    const value = parsePersonalMusicArtwork(`data:${mime};base64,${bytes.toString('base64')}`)
    assert.ok(value)
    assert.equal(value.bytes, bytes.length)
    assert.ok(value.width > 1 && value.height > 1)
    assert.equal(parsePersonalMusicArtwork(`data:${mime};base64,${bytes.subarray(0, bytes.length - 12).toString('base64')}`), null)
  }
})
