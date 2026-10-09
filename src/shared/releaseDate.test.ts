import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeReleaseDate,
  readLocalReleaseDate,
  formatReleaseDate,
  resolveAlbumReleaseDate
} from './releaseDate.ts'

test('local date tags retain precision and never change calendar day through time zones', () => {
  for (const value of ['2020', '2020-05', '2020-05-12'])
    assert.equal(normalizeReleaseDate(value), value)
  assert.equal(normalizeReleaseDate(2020), '2020')
  assert.equal(normalizeReleaseDate(' 2020/05/12 '), '2020-05-12')
  assert.equal(normalizeReleaseDate('2020-05-12T23:00:00-08:00'), '2020-05-12')
  for (const value of [
    '',
    null,
    0,
    2020.5,
    '0000',
    '2020-00',
    '2020-13',
    '2020-04-31',
    '2021-02-29',
    '1900-02-29',
    '2020-05-00',
    '2020-05/12',
    '2020-05T12:00',
    '2020-05-12T24:00',
    '2020-05-12T12:60',
    '2020-05-12T12:00:60',
    '2020-05-12T12:00+08:60',
    '2020-05-12 garbage'
  ]) {
    assert.equal(normalizeReleaseDate(value), undefined, String(value))
  }
  assert.equal(normalizeReleaseDate('2000-02-29'), '2000-02-29')
  assert.equal(
    readLocalReleaseDate({ releasedate: '2020-05-12', date: '1990', year: 1980 }),
    '2020-05-12'
  )
  assert.equal(
    readLocalReleaseDate({ releasedate: 'invalid', date: '2020-05', year: 1980 }),
    '2020-05'
  )
  assert.equal(readLocalReleaseDate({ date: 'invalid', year: 2020 }), '2020')
  assert.equal(formatReleaseDate('2020'), '2020年')
  assert.equal(formatReleaseDate('2020-05'), '2020年5月')
  assert.equal(formatReleaseDate('2020-05-12'), '2020年5月12日')
  assert.equal(formatReleaseDate(undefined), '发行时间未知')
})

test('album release dates select majority year then precision, frequency and track order', () => {
  const resolve = (...dates: Array<string | undefined>): string | undefined =>
    resolveAlbumReleaseDate(dates.map((releaseDate) => ({ releaseDate })))
  assert.equal(resolve(undefined, 'invalid'), undefined)
  assert.equal(resolve('1990-02-01', '2020', '2020-05', '2020-05-12'), '2020-05-12')
  assert.equal(resolve('2020-05-12', '2020-05-13', '2020-05-13'), '2020-05-13')
  assert.equal(resolve('2020-05-12', '2020-05-13'), '2020-05-12')
  assert.equal(resolve('1990', '2020'), '1990')
})
