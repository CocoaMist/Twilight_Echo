import { open, type FileHandle } from 'node:fs/promises'

type Box = { start: number; end: number; headerSize: number; type: string }
type AlacFormat = { sampleRate: number; bitDepth: number }

async function readBox(file: FileHandle, start: number, parentEnd: number): Promise<Box | null> {
  if (start + 8 > parentEnd) return null
  const header = Buffer.alloc(16)
  await file.read(header, 0, Math.min(header.length, parentEnd - start), start)
  const type = header.toString('latin1', 4, 8)
  const declaredSize = header.readUInt32BE(0)
  const headerSize = declaredSize === 1 ? 16 : 8
  const size =
    declaredSize === 0
      ? parentEnd - start
      : declaredSize === 1
        ? Number(header.readBigUInt64BE(8))
        : declaredSize
  if (!Number.isSafeInteger(size) || size < headerSize || start + size > parentEnd) return null
  return { start, end: start + size, headerSize, type }
}

async function findBox(
  file: FileHandle,
  start: number,
  end: number,
  type: string
): Promise<Box | null> {
  while (start + 8 <= end) {
    const box = await readBox(file, start, end)
    if (!box) return null
    if (box.type === type) return box
    start = box.end
  }
  return null
}

async function readTrackFormat(file: FileHandle, track: Box): Promise<AlacFormat | null> {
  let range = { start: track.start + track.headerSize, end: track.end }
  for (const type of ['mdia', 'minf', 'stbl', 'stsd']) {
    const box = await findBox(file, range.start, range.end, type)
    if (!box) return null
    range = { start: box.start + box.headerSize, end: box.end }
  }
  if (range.start + 8 > range.end) return null
  const stsdHeader = Buffer.alloc(8)
  if ((await file.read(stsdHeader, 0, 8, range.start)).bytesRead !== 8) return null
  const entryCount = stsdHeader.readUInt32BE(4)
  let entryStart = range.start + 8
  for (let index = 0; index < entryCount; index += 1) {
    const entry = await readBox(file, entryStart, range.end)
    if (!entry) return null
    if (entry.type === 'alac' && entry.start + 36 <= entry.end) {
      const version = Buffer.alloc(2)
      await file.read(version, 0, 2, entry.start + 16)
      if (version.readUInt16BE(0) === 0) {
        const config = await findBox(file, entry.start + 36, entry.end, 'alac')
        if (config && config.end - config.start >= config.headerSize + 28) {
          const data = Buffer.alloc(28)
          await file.read(data, 0, data.length, config.start + config.headerSize)
          const bitDepth = data.readUInt8(9)
          const sampleRate = data.readUInt32BE(24)
          if (bitDepth > 0 && sampleRate > 0) return { sampleRate, bitDepth }
        }
      }
    }
    entryStart = entry.end
  }
  return null
}

export async function readMp4AlacFormat(filePath: string): Promise<AlacFormat | null> {
  const file = await open(filePath, 'r')
  try {
    const moov = await findBox(file, 0, (await file.stat()).size, 'moov')
    if (!moov) return null
    let trackStart = moov.start + moov.headerSize
    while (trackStart + 8 <= moov.end) {
      const track = await findBox(file, trackStart, moov.end, 'trak')
      if (!track) return null
      const format = await readTrackFormat(file, track)
      if (format) return format
      trackStart = track.end
    }
    return null
  } finally {
    await file.close()
  }
}
