import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { downloadAutoMixSource, AUTOMIX_SOURCE_MAX_BYTES } from './autoMixSourceDownload.ts'

function pcmWav(): Buffer<ArrayBuffer> {
  const frames = 128
  const data = Buffer.alloc(44 + frames * 4)
  data.write('RIFF', 0)
  data.writeUInt32LE(data.length - 8, 4)
  data.write('WAVEfmt ', 8)
  data.writeUInt32LE(16, 16)
  data.writeUInt16LE(1, 20)
  data.writeUInt16LE(2, 22)
  data.writeUInt32LE(48000, 24)
  data.writeUInt32LE(48000 * 4, 28)
  data.writeUInt16LE(4, 32)
  data.writeUInt16LE(16, 34)
  data.write('data', 36)
  data.writeUInt32LE(frames * 4, 40)
  return data
}

test('online preparation publishes exactly the complete bytes consumed by playback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'twilight-automix-source-'))
  try {
    const data = pcmWav()
    const target = join(dir, '中文歌曲.flac')
    const result = await downloadAutoMixSource('https://music.example/authorized', target, {
      expectedBytes: data.length,
      expiresAt: Date.now() + 60_000,
      fetch: async (_url, init) => {
        assert.ok(init?.signal)
        return new Response(data, { headers: { 'content-length': String(data.length) } })
      }
    })
    assert.deepEqual(await readFile(target), data)
    assert.equal(result.bytes, data.length)
    assert.equal(result.sha256, createHash('sha256').update(data).digest('hex'))
    assert.deepEqual(await readdir(dir), ['中文歌曲.flac'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a complete HTTP 200 error page or unrecognized body never becomes the playback source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'twilight-automix-source-'))
  try {
    for (const body of ['<!doctype html><title>CDN error</title>', '{"code":403}', 'broken audio']) {
      await assert.rejects(
        downloadAutoMixSource('https://music.example/authorized', join(dir, 'song.mp3'), {
          fetch: async () => new Response(body)
        })
      )
      assert.deepEqual(await readdir(dir), [])
    }
    const noAudio = pcmWav()
    noAudio.writeUInt16LE(0, 22)
    await assert.rejects(
      downloadAutoMixSource('https://music.example/authorized', join(dir, 'song.wav'), {
        fetch: async () => new Response(noAudio)
      }),
      /online_source_invalid_audio/
    )
    assert.deepEqual(await readdir(dir), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('partial, mismatched, empty and oversized sources cannot enter the finished cache', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'twilight-automix-source-'))
  try {
    const cases: Array<{
      status: number
      body: string
      headers: Record<string, string>
      expectedBytes?: number
    }> = [
      { status: 206, body: 'part', headers: {} },
      { status: 200, body: '', headers: {} },
      { status: 200, body: 'short', headers: { 'content-length': '20' } },
      { status: 200, body: 'audio', headers: {}, expectedBytes: 10 },
      {
        status: 200,
        body: 'audio',
        headers: { 'content-length': String(AUTOMIX_SOURCE_MAX_BYTES + 1) }
      }
    ]
    for (const item of cases) {
      await assert.rejects(
        downloadAutoMixSource('https://music.example/authorized', join(dir, 'song.flac'), {
          expectedBytes: item.expectedBytes,
          fetch: async () => new Response(item.body, { status: item.status, headers: item.headers })
        })
      )
      assert.deepEqual(await readdir(dir), [])
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('cancel, URL expiry and timeout leave neither finished nor partial files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'twilight-automix-source-'))
  try {
    const controller = new AbortController()
    controller.abort()
    for (const options of [{ signal: controller.signal }, { expiresAt: Date.now() - 1 }]) {
      await assert.rejects(
        downloadAutoMixSource('https://music.example/authorized', join(dir, 'song.flac'), {
          ...options,
          fetch: async () => {
            assert.fail('revoked source must not be fetched')
          }
        })
      )
    }
    let started = false
    await assert.rejects(
      downloadAutoMixSource('https://music.example/authorized', join(dir, 'song.flac'), {
        timeoutMs: 20,
        fetch: async (_url, init) => {
          started = true
          return new Promise<Response>((_resolve, reject) =>
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true
            })
          )
        }
      }),
      /online_source_preparation_timeout/
    )
    assert.ok(started)
    assert.deepEqual(await readdir(dir), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('cancellation of an active body removes its partial file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'twilight-automix-source-'))
  const controller = new AbortController()
  try {
    await assert.rejects(
      downloadAutoMixSource('https://music.example/authorized', join(dir, 'song.flac'), {
        signal: controller.signal,
        fetch: async () =>
          new Response(
            new ReadableStream({
              start(stream) {
                stream.enqueue(new Uint8Array(1024))
                setTimeout(() => controller.abort(), 20)
              }
            })
          )
      })
    )
    assert.deepEqual(await readdir(dir), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
