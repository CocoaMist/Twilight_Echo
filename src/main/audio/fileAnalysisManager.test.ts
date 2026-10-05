import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FileAnalysisManager } from './fileAnalysisManager.ts'

test('failure cooldown remains effective, expired records are swept and success clears the record', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'twilight-analysis-retention-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  let now = 1,
    succeeds = false,
    analyzes = 0
  const manager = new FileAnalysisManager({
    cache: { get: async () => null, set: async () => {}, deleteIfMatches: async () => true },
    analyzeFile: async () => {
      analyzes++
      return succeeds ? { bpm: 120 } : null
    },
    now: () => now,
    failureCooldownMs: 100,
    buildIdentity: (request) => request.filePath
  })
  const internal = manager as unknown as { failures: Map<string, unknown> }
  const requests: Array<{ filePath: string; trackId: string }> = []
  for (let i = 0; i < 1050; i++) {
    const filePath = join(folder, `${i}.flac`)
    await writeFile(filePath, 'fixture')
    const request = { filePath, trackId: String(i) }
    requests.push(request)
    assert.equal((await manager.requestAnalysis(request)).status, 'failed')
    assert.ok(internal.failures.size <= 1024)
  }
  assert.equal(internal.failures.size, 1024)
  assert.equal((await manager.requestAnalysis(requests[1049])).status, 'skipped')
  assert.equal(analyzes, 1050)
  now += 101
  succeeds = true
  assert.equal((await manager.requestAnalysis(requests[1049])).status, 'completed')
  assert.equal(internal.failures.has(requests[1049].filePath), false)
  for (let i = 0; i < 64; i++) await manager.requestAnalysis(requests[1049])
  assert.equal(internal.failures.size, 0)
})
