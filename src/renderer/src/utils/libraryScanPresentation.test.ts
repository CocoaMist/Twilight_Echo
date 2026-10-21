import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { LocalLibraryScanStatus } from '../../../shared/localLibraryScan.ts'
import { canResumeLocalLibraryScan, libraryScanStatusText } from './libraryScanPresentation.ts'

function legacy(state: LocalLibraryScanStatus['state']): LocalLibraryScanStatus {
  return {
    jobId: 'job',
    mode: 'full',
    state,
    current: 600,
    total: 1000,
    parsedFileCount: 30,
    skippedUnchanged: 570,
    error: ''
  }
}
function database(state: LocalLibraryScanStatus['state']): LocalLibraryScanStatus {
  return {
    ...legacy(state),
    databaseProgress: {
      jobId: 'job',
      state: state === 'idle' ? 'completed' : state,
      phase: 'checking',
      checkedFiles: 1000,
      parsedFiles: 30,
      committedFiles: 600,
      failedFiles: 2,
      trackCount: 300002,
      revision: 5
    }
  }
}

test('SQLite cancel/failure/pause expose continue while completed and legacy cancelled jobs do not', () => {
  for (const state of ['cancelled', 'failed', 'paused'] as const)
    assert.equal(canResumeLocalLibraryScan(database(state)), true)
  assert.equal(
    canResumeLocalLibraryScan({
      ...database('failed'),
      databaseProgress: { ...database('failed').databaseProgress!, state: 'interrupted' }
    }),
    true
  )
  for (const state of ['running', 'completed', 'idle'] as const)
    assert.equal(canResumeLocalLibraryScan(database(state)), false)
  assert.equal(canResumeLocalLibraryScan(legacy('paused')), true)
  assert.equal(canResumeLocalLibraryScan(legacy('cancelled')), false)
  assert.equal(canResumeLocalLibraryScan({ ...database('cancelled'), jobId: null }), false)
})

test('database state copy distinguishes committed retained results and actual parse/commit phases', () => {
  assert.match(libraryScanStatusText(database('cancelled')), /已入库曲目保留；可继续扫描/)
  assert.match(libraryScanStatusText(database('paused')), /可继续浏览和播放/)
  assert.equal(libraryScanStatusText(database('completed')), '检查已完成，曲库已更新')
  for (const phase of ['checking', 'parsing', 'committing', 'idle'] as const) {
    const status = database('running')
    status.databaseProgress!.phase = phase
    const text = libraryScanStatusText(status)
    assert.ok(text.startsWith('正在'))
    assert.doesNotMatch(text, /600 \/ 1000|新增或变化/)
  }
  assert.equal(libraryScanStatusText({ ...database('failed'), error: '磁盘已满' }), '磁盘已满')
})

test('legacy JSON progress retains its existing meaning and controls', () => {
  assert.equal(libraryScanStatusText(legacy('paused')), '已暂停：600 / 1000 项')
  assert.equal(libraryScanStatusText(legacy('running')), '检查文件：600 / 1000 项')
  assert.equal(
    libraryScanStatusText(legacy('running'), {
      jobId: 'job',
      mode: 'full',
      phase: 'parsing',
      current: 600,
      total: 1000,
      parsedFileCount: 30,
      skippedUnchanged: 570
    }),
    '解析元数据：600 / 1000 项'
  )
  assert.equal(
    libraryScanStatusText(legacy('completed')),
    '已完成：解析 30 个文件，跳过 570 个未变化文件'
  )
  assert.equal(libraryScanStatusText(legacy('cancelled')), '扫描已取消，未提交未完成的结果')
})

test('settings use four independently labelled committed counters and keep discovery progress indeterminate', () => {
  const section = readFileSync(
    new URL('../components/settings-page/LibrarySettingsSection.vue', import.meta.url),
    'utf8'
  )
  for (const field of ['checkedFiles', 'parsedFiles', 'trackCount', 'failedFiles'])
    assert.match(section, new RegExp('databaseProgress\\.' + field + '\\.toLocaleString\\(\\)'))
  for (const label of ['检查文件', '解析元数据', '已入库曲目', '失败文件'])
    assert.ok(section.includes('<dt>' + label + '</dt>'))
  assert.match(section, /!libraryScanStatus\.databaseProgress && libraryScanStatus\.total > 0/)
  assert.match(section, /v-if="canResumeLocalLibraryScan\(libraryScanStatus\)"/)
})
