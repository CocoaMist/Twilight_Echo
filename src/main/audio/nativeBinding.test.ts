import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { getNativeAddonCandidates, loadNativeBindingWithDiagnostics } from './nativeBinding.ts'

test('packaged utility workers load only the addon beside their own archive', () => {
  const resources = join(process.cwd(), 'fixture-evaluation', 'resources')
  for (const entry of [
    join('out', 'main', 'audioEngineService.js'),
    join('out', 'main', 'chunks', 'nativeBinding-hash.js'),
    join('out', 'main', 'audioAnalysisService.js')
  ]) {
    assert.deepEqual(
      getNativeAddonCandidates({
        modulePath: join(resources, 'app.asar', entry),
        resourcesPath: join(process.cwd(), 'stale-electron', 'resources'),
        appPath: join(process.cwd(), 'stale-project'),
        cwd: process.cwd()
      }),
      [join(resources, 'audio-engine', 'twilight_audio_node.node')]
    )
  }
})

test('a missing packaged addon does not fall through to the launch directory', () => {
  const candidates = getNativeAddonCandidates({
    modulePath: join(
      process.cwd(),
      'missing-package-fixture',
      'resources',
      'app.asar',
      'out',
      'main',
      'audioEngineService.js'
    ),
    cwd: process.cwd()
  })
  const result = loadNativeBindingWithDiagnostics(() => candidates)
  assert.equal(result.binding, null)
  assert.equal(result.candidateCount, 1)
  assert.deepEqual(result.attempts, [])
})

test('development workers without an app singleton anchor to their source tree', () => {
  const root = join(process.cwd(), 'dev-fixture')
  for (const entry of [
    join('src', 'main', 'audio', 'nativeBinding.ts'),
    join('out', 'main', 'chunks', 'nativeBinding-hash.js')
  ]) {
    const candidates = getNativeAddonCandidates({
      modulePath: join(root, entry),
      resourcesPath: '',
      cwd: join(process.cwd(), 'unrelated-launch-directory')
    })
    assert.equal(candidates[0], join(root, 'resources', 'audio-engine', 'twilight_audio_node.node'))
    assert.ok(candidates.every((candidate) => !candidate.includes('unrelated-launch-directory')))
  }
})
