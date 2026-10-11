import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateStemMaterial, stemBudgetMs } from './autoMixStemService.ts'
import { normalizeAutoMixStemCacheMiB } from '../../shared/twilightAutoMix.ts'

test('legacy and unsupported stem cache settings migrate to 512 MiB', () => {
  for (const value of [undefined, null, '256', -1, 128, NaN, Infinity])
    assert.equal(normalizeAutoMixStemCacheMiB(value), 512)
  for (const value of [0, 256, 512, 1024, 2048])
    assert.equal(normalizeAutoMixStemCacheMiB(value), value)
})

test('streamed material hashing checks bytes and length, and honors cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stem-digest-test-'))
  const path = join(directory, '中文材料.f32')
  const block = Buffer.alloc(256 * 1024, 123)
  const hash = createHash('sha256')
  const file = await open(path, 'w')
  try {
    for (let i = 0; i < 65; i++) {
      await file.write(block)
      hash.update(block)
    }
  } finally {
    await file.close()
  }
  const digest = hash.digest('hex')
  const length = block.length * 65
  try {
    await validateStemMaterial(path, length, digest, new AbortController().signal)
    await assert.rejects(
      validateStemMaterial(path, length - 1, digest, new AbortController().signal),
      /material_digest_mismatch/
    )
    await assert.rejects(
      validateStemMaterial(path, length, '0'.repeat(64), new AbortController().signal),
      /material_digest_mismatch/
    )
    const aborted = new AbortController()
    aborted.abort()
    await assert.rejects(validateStemMaterial(path, length, digest, aborted.signal), /abort/i)
    const during = new AbortController()
    const pending = validateStemMaterial(path, length, digest, during.signal)
    setImmediate(() => during.abort())
    await assert.rejects(pending, /abort/i)
    // The file handle must be closed on every failure, including Windows.
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('stem budget preserves native preparation and submission time', () => {
  assert.equal(stemBudgetMs(100, 0), 78000)
  assert.equal(stemBudgetMs(200, 0), 90000)
  assert.equal(stemBudgetMs(22, 0), 0)
})
