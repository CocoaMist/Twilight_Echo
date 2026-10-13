/** Count the decoded fetch body, including chunked and compressed responses. */
export async function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
  tooLargeMessage: string
): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await cancelResponseBody(response)
    throw new Error(tooLargeMessage)
  }
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) throw new Error(tooLargeMessage)
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks, bytes)
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
}

export async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}
