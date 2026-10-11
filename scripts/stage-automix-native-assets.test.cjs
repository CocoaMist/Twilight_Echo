const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { allowed, validate, stage } = require('./stage-automix-native-assets.cjs')

function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'twilight-public-automix-'))
  try {
    run(root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}
test('release allowlist contains only locked public graphs and exact required notices', () => {
  assert.deepEqual(
    [...allowed].sort(),
    [
      'Beat-This-LICENSE.txt',
      'Signalsmith-Linear-LICENSE.txt',
      'Signalsmith-Stretch-LICENSE.txt',
      'YAMNet-LICENSE.txt',
      'beat-this.tamg',
      'manifest.json',
      'yamnet.tamg'
    ].sort()
  )
})
for (const name of ['research.json', 'small0.ckpt', 'onnxruntime.dll', 'SDK']) {
  test(`unknown asset ${name} cannot enter staging`, () =>
    fixture((root) => {
      if (name === 'SDK') fs.mkdirSync(path.join(root, name))
      else fs.writeFileSync(path.join(root, name), 'not an approved public asset')
      assert.throws(() => validate(root), /Unapproved AutoMix release asset/)
    }))
}
test('a graph filename is insufficient without the locked content hash', () =>
  fixture((root) => {
    fs.writeFileSync(path.join(root, 'beat-this.tamg'), 'altered graph')
    assert.throws(() => validate(root), /public graph hash mismatch/)
    assert.throws(
      () => stage(root, path.join(root, 'destination')),
      /Unapproved public source graph/
    )
    assert.equal(fs.existsSync(path.join(root, 'destination')), false)
  }))
