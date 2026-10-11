const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { resolveAnalysisDirectory } = require('./automix-native-device-soak.cjs')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-soak-provenance-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'pairs.validation.json')
  const previous = {
    manifestSha256: 'corpus',
    analysisDllSha256: 'analysis-runtime',
    graphs: { 'beat-this.tamg': 'beat', 'yamnet.tamg': 'voice' }
  }
  fs.writeFileSync(file, JSON.stringify(previous))
  return {
    directory,
    file,
    evidence: {
      ...previous,
      analysisReuse: {
        directory,
        reportSha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
      }
    }
  }
}

test('native soak resolves explicitly verified reused analysis without claiming new inference', (t) => {
  const { directory, evidence } = fixture(t)
  assert.equal(resolveAnalysisDirectory('current-render', evidence), directory)
  assert.equal(resolveAnalysisDirectory('current-render', {}), 'current-render')
})

test('native soak rejects an altered original analysis report', (t) => {
  const { file, evidence } = fixture(t)
  fs.appendFileSync(file, '\n')
  assert.throws(() => resolveAnalysisDirectory('current-render', evidence), /report changed/)
})

test('native soak rejects corpus, analysis runtime and public graph substitutions', (t) => {
  const { evidence } = fixture(t)
  for (const key of ['manifestSha256', 'analysisDllSha256']) {
    assert.throws(
      () =>
        resolveAnalysisDirectory('current-render', {
          ...evidence,
          [key]: 'changed'
        }),
      /provenance mismatch/
    )
  }
  assert.throws(
    () =>
      resolveAnalysisDirectory('current-render', {
        ...evidence,
        graphs: { ...evidence.graphs, 'yamnet.tamg': 'changed' }
      }),
    /graphs changed/
  )
})
