import assert from 'node:assert/strict'
import test from 'node:test'
import type { AudioDiagnosticReport } from '../../shared/coreAudioDiagnostics.ts'
import { exportCoreAudioDiagnostics } from './coreAudioDiagnosticsExport.ts'

const report = {
  schemaVersion: 1,
  generatedAt: '2026-01-01T00:00:00Z',
  sessionId: 'test',
  privacy: {},
  environment: {
    appName: 'TwilightEcho',
    appVersion: 'test',
    packaged: true,
    platform: 'win32',
    architecture: 'x64',
    osRelease: 'test',
    locale: 'en-US',
    processVersions: { node: 'test', modules: 'test' }
  },
  snapshot: {},
  events: []
} as unknown as AudioDiagnosticReport

test('canceling export does not collect Core diagnostics', async () => {
  let captured = 0
  assert.deepEqual(
    await exportCoreAudioDiagnostics({
      locale: 'zh-CN',
      choose: async () => null,
      report: async () => {
        captured++
        return report
      },
      write: async () => assert.fail('unexpected write')
    }),
    { filePath: null }
  )
  assert.equal(captured, 0)
})

test('one Core capture produces Markdown and matching JSON companions', async () => {
  let captured = 0
  const writes: [string, string][] = []
  const result = await exportCoreAudioDiagnostics({
    locale: 'en-US',
    choose: async () => 'D:/report.json',
    report: async (locale) => {
      assert.equal(locale, 'en-US')
      captured++
      return report
    },
    write: async (path, contents) => {
      writes.push([path, contents])
    }
  })
  assert.equal(captured, 1)
  assert.deepEqual(result, { filePath: 'D:/report.md' })
  assert.deepEqual(
    writes.map(([path]) => path),
    ['D:/report.md', 'D:/report.json']
  )
  assert.deepEqual(JSON.parse(writes[1][1]), report)
  assert.match(writes[0][1], /test/)
})

test('export surfaces filesystem failure instead of claiming success', async () => {
  await assert.rejects(
    exportCoreAudioDiagnostics({
      locale: 'zh-CN',
      choose: async () => 'D:/report.md',
      report: async () => report,
      write: async () => {
        throw new Error('disk full')
      }
    }),
    /disk full/
  )
})
