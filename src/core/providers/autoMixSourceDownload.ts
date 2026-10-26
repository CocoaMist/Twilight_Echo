import { createReadStream, createWriteStream } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { Readable, Transform } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'

export const AUTOMIX_SOURCE_MAX_BYTES = 256 * 1024 * 1024
export const AUTOMIX_SOURCE_TIMEOUT_MS = 10_000

export interface AutoMixSourceDownloadOptions {
  signal?: AbortSignal
  expiresAt?: number | null
  expectedBytes?: number | null
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

async function validateAudioHeaders(path: string, signal: AbortSignal): Promise<void> {
  const [{ parseFromTokenizer }, { fromStream }] = await Promise.all([
    import('music-metadata'),
    import('strtok3')
  ])
  signal.throwIfAborted()
  const stream = createReadStream(path, { signal })
  const closed = finished(stream, { cleanup: true }).catch(() => {})
  let tokenizer: Awaited<ReturnType<typeof fromStream>> | undefined
  try {
    tokenizer = await fromStream(stream, { abortSignal: signal })
    const { format } = await parseFromTokenizer(tokenizer, {
      duration: false,
      skipCovers: true,
      skipPostHeaders: true
    })
    signal.throwIfAborted()
    if (
      !format.codec ||
      !Number.isFinite(format.sampleRate) ||
      (format.sampleRate ?? 0) <= 0 ||
      !Number.isInteger(format.numberOfChannels) ||
      (format.numberOfChannels ?? 0) <= 0 ||
      format.hasAudio === false
    )
      throw new Error('online_source_invalid_audio')
  } finally {
    // Close the reader before rename/removal on Windows. The same deadline and
    // cancellation signal govern streaming download and metadata inspection.
    try {
      await tokenizer?.close()
    } finally {
      stream.destroy()
      await closed
    }
  }
}

/** An immutable finished file is the playback source as well as the analysis
 * source. URL/ETag hashes alone never establish the identity of audio bytes. */
export async function downloadAutoMixSource(
  url: string,
  target: string,
  options: AutoMixSourceDownloadOptions = {}
): Promise<{ path: string; bytes: number; sha256: string }> {
  const controller = new AbortController()
  const abort = () => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) abort()
  else options.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(
    () => controller.abort(new Error('online_source_preparation_timeout')),
    Math.min(AUTOMIX_SOURCE_TIMEOUT_MS, Math.max(1, options.timeoutMs ?? AUTOMIX_SOURCE_TIMEOUT_MS))
  )
  const part = `${target}.${randomUUID()}.part`
  let bytes = 0
  const hash = createHash('sha256')
  try {
    controller.signal.throwIfAborted()
    if (options.expiresAt != null && options.expiresAt <= Date.now())
      throw new Error('provider_source_expired')
    if (options.expectedBytes != null && options.expectedBytes > AUTOMIX_SOURCE_MAX_BYTES)
      throw new Error('online_source_size_budget')
    const response = await (options.fetch ?? globalThis.fetch)(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Referer: 'https://music.163.com/'
      }
    })
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel()
      throw new Error('online_source_incomplete_response')
    }
    const length = Number(response.headers.get('content-length')) || null
    if (length !== null && length > AUTOMIX_SOURCE_MAX_BYTES) {
      await response.body.cancel()
      throw new Error('online_source_size_budget')
    }
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length
        if (bytes > AUTOMIX_SOURCE_MAX_BYTES) {
          callback(new Error('online_source_size_budget'))
          return
        }
        hash.update(chunk)
        callback(null, chunk)
      }
    })
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      counter,
      createWriteStream(part, { flags: 'wx' }),
      { signal: controller.signal }
    )
    controller.signal.throwIfAborted()
    if (
      bytes === 0 ||
      (length !== null && length !== bytes) ||
      (options.expectedBytes != null && options.expectedBytes !== bytes)
    )
      throw new Error('online_source_incomplete_body')
    // A successful HTTP response can contain an error page. Require recognized
    // audio headers before replacing the authorized playback URL with this file.
    await validateAudioHeaders(part, controller.signal)
    controller.signal.throwIfAborted()
    if (options.expiresAt != null && options.expiresAt <= Date.now())
      throw new Error('provider_source_expired')
    await rename(part, target)
    return { path: target, bytes, sha256: hash.digest('hex') }
  } catch (error) {
    await rm(part, { force: true }).catch(() => {})
    throw error
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}
