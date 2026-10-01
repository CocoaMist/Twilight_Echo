const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve, sep } = require('node:path')
const test = require('node:test')
const { resolveMingwEnvironment } = require('../../scripts/audio-engine-toolchain.cjs')

test(
  'native EQ PCM matches renderer response, applies zero-gain filters and preserves channel masks',
  {
    timeout: 60000
  },
  async () => {
    const { computeBiquadCoefficients, magnitudeDbAtFrequency } =
      await import('../../src/renderer/src/utils/eqResponse.ts')
    const env = process.platform === 'win32' ? resolveMingwEnvironment() : process.env
    const compiler =
      process.platform === 'win32' ? join(env.W64DEVKIT_ROOT, 'bin', 'g++.exe') : 'c++'
    const directory = mkdtempSync(join(tmpdir(), 'twilight-parametric-eq-'))
    const executable = join(directory, 'eq-test.exe')
    try {
      const build = spawnSync(
        compiler,
        [
          '-std=c++20',
          '-O2',
          ...(process.platform === 'win32' ? ['-static'] : []),
          '-o',
          executable,
          join(__dirname, 'ParametricEqProcessor.test.cpp'),
          join(__dirname, 'ParametricEqProcessor.cpp')
        ],
        { env, encoding: 'utf8', windowsHide: true, timeout: 45000 }
      )
      assert.equal(build.status, 0, build.error?.message || build.stderr || build.stdout)
      const result = spawnSync(executable, [], {
        env,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000
      })
      assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout)
      const rows = result.stdout.trim().split(/\r?\n/)
      assert.equal(rows.length, 288)
      for (const row of rows) {
        const [type, ...values] = row.split(' ')
        const [sampleRate, gain, q, frequency, measured] = values.map(Number)
        const coefficients = computeBiquadCoefficients(type, 1000, gain, q, sampleRate)
        const expected = magnitudeDbAtFrequency(coefficients, frequency, sampleRate)
        if (expected < -100) assert.ok(measured < -100, row)
        else assert.ok(Math.abs(measured - expected) < 0.03, `${row}: expected ${expected} dB`)
      }
    } finally {
      assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
