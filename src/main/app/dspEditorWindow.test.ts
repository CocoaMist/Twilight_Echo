import assert from 'node:assert/strict'
import test from 'node:test'
import { dspEditorWindowOptions, isDspEditorWindowRequest } from './dspEditorWindow.ts'
test('only the named blank DSP editor is allowed, sized within its display', () => {
  assert.equal(isDspEditorWindowRequest('about:blank', 'twilight-dsp-editor'), true)
  for (const [url, name] of [
    ['https://example.com', 'twilight-dsp-editor'],
    ['about:blank?x=1', 'twilight-dsp-editor'],
    ['about:blank', 'other']
  ])
    assert.equal(isDspEditorWindowRequest(url, name), false)
  const options = dspEditorWindowOptions({ x: 100, y: 0, width: 800, height: 600 })
  assert.equal(options.width, 800)
  assert.equal(options.height, 600)
  assert.equal(options.x, 100)
  assert.equal(options.y, 0)
  assert.equal(options.modal, false)
  assert.equal(options.webPreferences, undefined)
})
