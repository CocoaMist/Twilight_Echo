import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { writeFile } from 'node:fs/promises'
import test from 'node:test'
// The fixture is shared with UI Lab so diagnostics and regression use the same component.
import { createTitlebarFixture } from '../../../../scripts/ui-lab/titlebar-fixture.mjs'

const require = createRequire(import.meta.url)
test('real titlebar isolates previews, follows native state and keeps caption geometry across surfaces', async () => {
  const fixture = await createTitlebarFixture()
  try {
    const result = await promisify(execFile)(require('electron'), [fixture.runner, fixture.html], {
      windowsHide: true,
      timeout: 90_000,
      maxBuffer: 4 * 1024 * 1024
    })
    const json = result.stdout.split('\n').find((line) => line.startsWith('TITLEBAR_LAB_RESULT '))
    assert.ok(json, 'UI Lab must return measured geometry and state checks')
    const evidence = JSON.parse(json.slice('TITLEBAR_LAB_RESULT '.length))
    assert.equal(evidence.matrix.length, 144)
    assert.ok(evidence.checks.length >= 20)
    for (const index of [0, 1, 2]) {
      assert.ok(evidence.checks.includes(`typing-cannot-shrink-search-input:${index}`))
      assert.ok(evidence.checks.includes(`clearing-keeps-search-geometry:${index}`))
    }
    for (const scenario of evidence.matrix) {
      assert.deepEqual(
        scenario.backStates.map((sample: { state: string }) => sample.state),
        ['absent', 'entering', 'present', 'leaving', 'absent-again']
      )
    }
    if (process.env.UI_LAB_TITLEBAR_EVIDENCE)
      await writeFile(
        process.env.UI_LAB_TITLEBAR_EVIDENCE,
        JSON.stringify(evidence, null, 2) + '\n'
      )
  } finally {
    await fixture.clean()
  }
})
