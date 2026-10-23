import type { IncomingHttpHeaders } from 'node:http'

export const AMLL_TTML_TIMEOUT_MS = 8_000
export const AMLL_TTML_MAX_BYTES = 2 * 1024 * 1024
export const AMLL_TTML_CACHE_TTL_MS = 10 * 60 * 1000
export const AMLL_TTML_CACHE_MAX_ENTRIES = 64

const AMLL_TTML_URLS = [
  'https://amll-ttml-db.stevexmh.net/ncm/{id}',
  'https://raw.githubusercontent.com/amll-dev/amll-ttml-db/refs/heads/main/ncm-lyrics/{id}.ttml',
  'https://cdn.jsdelivr.net/gh/amll-dev/amll-ttml-db@main/ncm-lyrics/{id}.ttml'
] as const

type CacheEntry = { value: string; expiresAt: number }
const cache = new Map<number, CacheEntry>()

export function normalizeAmlSongId(value: unknown): number {
  if (typeof value !== 'number') throw new Error('Invalid AMLL NCM song ID')
  const id = value
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid AMLL NCM song ID')
  return id
}

export function clearAmlTtmlCache(): void {
  cache.clear()
}

function readCache(id: number, now = Date.now()): string | null {
  const entry = cache.get(id)
  if (!entry) return null
  if (entry.expiresAt <= now) {
    cache.delete(id)
    return null
  }
  return entry.value
}

function writeCache(id: number, value: string, now = Date.now()): void {
  cache.delete(id)
  cache.set(id, { value, expiresAt: now + AMLL_TTML_CACHE_TTL_MS })
  while (cache.size > AMLL_TTML_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest == null) break
    cache.delete(oldest)
  }
}

function contentLength(headers: Headers | IncomingHttpHeaders): number | null {
  const value =
    headers instanceof Headers ? headers.get('content-length') : headers['content-length']
  const raw = Array.isArray(value) ? value[0] : value
  if (!raw) return null
  const length = Number(raw)
  return Number.isSafeInteger(length) && length >= 0 ? length : null
}

function validateTtmlPayload(text: string): string {
  if (Buffer.byteLength(text, 'utf8') > AMLL_TTML_MAX_BYTES) {
    throw new Error('AMLL TTML response exceeds size limit')
  }
  if (!text.trim() || /<!DOCTYPE|<!ENTITY/i.test(text) || !/<tt(?:\s|>)/i.test(text)) {
    throw new Error('AMLL response is not a safe TTML document')
  }
  return text.replace(/^\uFEFF/, '')
}

export async function fetchAmlTtml(
  songIdInput: unknown,
  options: {
    fetchImpl?: typeof fetch
    signal?: AbortSignal
    timeoutMs?: number
    bypassCache?: boolean
  } = {}
): Promise<string | null> {
  options.signal?.throwIfAborted()
  const songId = normalizeAmlSongId(songIdInput)
  if (!options.bypassCache) {
    const cached = readCache(songId)
    if (cached) return cached
  }

  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? AMLL_TTML_TIMEOUT_MS
  let lastError: unknown = null

  for (const template of AMLL_TTML_URLS) {
    options.signal?.throwIfAborted()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onAbort = (): void => controller.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const url = template.replace('{id}', encodeURIComponent(String(songId)))
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/ttml, application/xml, text/xml;q=0.9' },
        redirect: 'error',
        signal: controller.signal
      })
      if (!response.ok) {
        if (response.status === 404) continue
        throw new Error(`AMLL TTML request failed with HTTP ${response.status}`)
      }
      const length = contentLength(response.headers)
      if (length != null && length > AMLL_TTML_MAX_BYTES) {
        throw new Error('AMLL TTML response exceeds size limit')
      }
      const text = validateTtmlPayload(await response.text())
      writeCache(songId, text)
      return text
    } catch (error) {
      lastError = error
      if (options.signal?.aborted) throw error
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  if (lastError && !(lastError instanceof Error && /HTTP 404/.test(lastError.message))) {
    throw lastError
  }
  return null
}
