import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readMp4AlacFormat } from './mp4AlacFormat.ts'

function box(type: string, ...parts: Buffer[]): Buffer {
  const size = 8 + parts.reduce((total, part) => total + part.length, 0)
  const header = Buffer.alloc(8)
  header.writeUInt32BE(size, 0)
  header.write(type, 4, 'latin1')
  return Buffer.concat([header, ...parts])
}

function track(codec: string, config?: Buffer): Buffer {
  const description = Buffer.alloc(28)
  description.writeUInt16BE(2, 16)
  description.writeUInt16BE(16, 18)
  description.writeUInt32BE(1 << 16, 24)
  const entry = box(codec, description, ...(config ? [box('alac', config)] : []))
  const count = Buffer.alloc(8)
  count.writeUInt32BE(1, 4)
  return box('trak', box('mdia', box('minf', box('stbl', box('stsd', count, entry)))))
}

test('reads the ALAC magic cookie when the MP4 sample entry reports 1 Hz and 16 bit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'twilight-alac-format-'))
  const path = join(root, 'nonstandard.m4a')
  const config = Buffer.alloc(28)
  config.writeUInt8(24, 9)
  config.writeUInt32BE(96_000, 24)
  await writeFile(
    path,
    Buffer.concat([box('ftyp'), box('mdat'), box('moov', track('mp4a'), track('alac', config))])
  )
  try {
    assert.deepEqual(await readMp4AlacFormat(path), { sampleRate: 96_000, bitDepth: 24 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
