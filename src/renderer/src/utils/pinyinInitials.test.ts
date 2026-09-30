import assert from 'node:assert/strict'
import test from 'node:test'

const { getPinyinInitial, getPinyinInitials, isCjkChar } = (await import(
  new URL('./pinyinInitials.ts', import.meta.url).href
)) as typeof import('./pinyinInitials')

test('extracts correct pinyin initials for common characters', () => {
  assert.equal(getPinyinInitials('周杰伦'), 'zjl')
  assert.equal(getPinyinInitials('范特西'), 'ftx')
  assert.equal(getPinyinInitials('告白实行委员会'), 'gbsxwyh')
})

test('returns empty string for non-CJK characters', () => {
  assert.equal(getPinyinInitial('a'), '')
  assert.equal(getPinyinInitial('1'), '')
  assert.equal(getPinyinInitial(' '), '')
  assert.equal(getPinyinInitials('Song Title 42 / Artist 🎵 𠀀'), '')
  assert.equal(getPinyinInitials('周 Jay 42 杰'), 'zj')
})

test('identifies CJK characters', () => {
  assert.ok(isCjkChar('周'))
  assert.ok(isCjkChar('杰'))
  assert.ok(!isCjkChar('a'))
  assert.ok(!isCjkChar('1'))
})
