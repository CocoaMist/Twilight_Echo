import assert from 'node:assert/strict'
import test from 'node:test'
import type { ListeningStats } from '@renderer/stores/useListeningStatsStore'
import {
  buildListeningCalendar,
  buildListeningDays,
  comparePeriods,
  formatDayLabel,
  formatListeningDuration,
  listeningDurationParts,
  summarizeDays,
  summarizeRecordedTracks,
  utcDayKey,
  type AnalyticsDay,
  type AnalyticsRange
} from './listeningAnalyticsData.ts'

const DAY_MS = 86_400_000

type TrackStat = ListeningStats['tracks'][string]

function trackStat(format?: string, seconds = 60, plays = 1): TrackStat {
  return {
    seconds,
    plays,
    lastPlayed: 0,
    skips: 0,
    completions: 0,
    title: '曲目',
    artist: '歌手',
    cover: null,
    track: {
      id: 'track',
      title: '曲目',
      artist: '歌手',
      album: '专辑',
      filePath: '/music/track.flac',
      fileName: 'track.flac',
      duration: 300,
      size: 1000,
      cover: null,
      lyrics: null,
      format,
      sampleRate: 192000,
      bitDepth: 24
    }
  }
}

test('UTC 日期键不受输入时区影响并补零', () => {
  assert.equal(utcDayKey(new Date('2024-03-01T00:30:00+08:00')), '2024-02-29')
  assert.equal(utcDayKey(new Date('2024-12-31T23:30:00-08:00')), '2025-01-01')
  assert.equal(utcDayKey(new Date('2024-01-02T05:00:00Z')), '2024-01-02')
})

test('每日序列跨闰日补零、包含 UTC 今天并排除未来', () => {
  const days = {
    '2024-02-28': 12,
    '2024-02-29': 34,
    '2024-03-02': 900
  }
  assert.deepEqual(buildListeningDays(days, new Date('2024-03-01T23:59:59Z'), 4), [
    { key: '2024-02-27', seconds: 0 },
    { key: '2024-02-28', seconds: 12 },
    { key: '2024-02-29', seconds: 34 },
    { key: '2024-03-01', seconds: 0 }
  ])
})

test('7/30/90 天前一期不与当前期重叠', () => {
  const ranges: AnalyticsRange[] = [7, 30, 90]
  const now = new Date('2025-01-02T12:00:00Z')
  for (const count of ranges) {
    const current = buildListeningDays({}, now, count)
    const previous = buildListeningDays({}, now, count, count)
    assert.equal(current.length, count)
    assert.equal(previous.length, count)
    assert.equal(current.at(-1)?.key, '2025-01-02')
    assert.equal(Date.parse(current[0].key) - Date.parse(previous.at(-1)!.key), DAY_MS)
    const keys = new Set(current.map((day) => day.key))
    assert.ok(previous.every((day) => !keys.has(day.key)))
  }
})

test('每日序列仅接受有限正数并处理空范围', () => {
  const days = {
    '2024-01-01': NaN,
    '2024-01-02': Infinity,
    '2024-01-03': -Infinity,
    '2024-01-04': -4,
    '2024-01-05': 0,
    '2024-01-06': 0.5
  }
  const now = new Date('2024-01-06T00:00:00Z')
  assert.deepEqual(
    buildListeningDays(days, now, 6).map((day) => day.seconds),
    [0, 0, 0, 0, 0, 0.5]
  )
  for (const count of [0, -1, NaN, Infinity]) {
    assert.deepEqual(buildListeningDays(days, now, count), [])
  }
})

test('日汇总平均值包含未收听日期，连续天数跨闰日正确', () => {
  const days = buildListeningDays(
    { '2024-02-28': 30, '2024-02-29': 60, '2024-03-01': 60, '2024-03-03': 10 },
    new Date('2024-03-03T00:00:00Z'),
    5
  )
  assert.deepEqual(summarizeDays(days), {
    seconds: 160,
    activeDays: 4,
    averageSeconds: 32,
    longestStreak: 3,
    bestDay: { key: '2024-02-29', seconds: 60 }
  })
})

test('日汇总在跨年连续、缺失日期和无效数值间正确断开', () => {
  const days = [
    { key: '2023-12-31', seconds: 1 },
    { key: '2024-01-01', seconds: 2 },
    { key: '2024-01-03', seconds: 3 },
    { key: '2024-01-04', seconds: NaN },
    { key: '2024-01-05', seconds: Infinity },
    { key: '2024-01-06', seconds: -1 },
    { key: '2024-01-07', seconds: 4 }
  ]
  assert.deepEqual(summarizeDays(days), {
    seconds: 10,
    activeDays: 4,
    averageSeconds: 10 / 7,
    longestStreak: 2,
    bestDay: { key: '2024-01-07', seconds: 4 }
  })
})

test('空日汇总与全零日汇总都没有最佳日', () => {
  const expected = {
    seconds: 0,
    activeDays: 0,
    averageSeconds: 0,
    longestStreak: 0,
    bestDay: null
  }
  assert.deepEqual(summarizeDays([]), expected)
  assert.deepEqual(summarizeDays([{ key: '2024-01-01', seconds: 0 }]), expected)
})

test('前期为零用 new，空期相同，普通变化保留正负百分比', () => {
  assert.deepEqual(comparePeriods(60, 0), { percent: null, direction: 'new' })
  assert.deepEqual(comparePeriods(0, 0), { percent: 0, direction: 'same' })
  assert.deepEqual(comparePeriods(150, 100), { percent: 50, direction: 'up' })
  assert.deepEqual(comparePeriods(50, 100), { percent: -50, direction: 'down' })
  assert.deepEqual(comparePeriods(0, 100), { percent: -100, direction: 'down' })
  assert.deepEqual(comparePeriods(100, 100), { percent: 0, direction: 'same' })
  assert.deepEqual(comparePeriods(Infinity, NaN), { percent: 0, direction: 'same' })
  assert.deepEqual(comparePeriods(60, -5), { percent: null, direction: 'new' })
})

test('中文时长先取整再进位，不出现 60 秒或 60 分钟余数', () => {
  const cases: Array<[number, string]> = [
    [0, '0秒'],
    [-1, '0秒'],
    [NaN, '0秒'],
    [Infinity, '0秒'],
    [12.4, '12秒'],
    [59.4, '59秒'],
    [59.9, '1分钟'],
    [119.9, '2分钟'],
    [3599.9, '1小时'],
    [3600, '1小时'],
    [3660, '1小时1分钟'],
    [7200, '2小时']
  ]
  for (const [seconds, expected] of cases) assert.equal(formatListeningDuration(seconds), expected)
})

test('大数时长以秒/分钟/一位小时显示且去除尾零', () => {
  const cases: Array<[number, string, string]> = [
    [0, '0', '秒'],
    [NaN, '0', '秒'],
    [-Infinity, '0', '秒'],
    [-60, '0', '秒'],
    [59.4, '59', '秒'],
    [59.9, '1', '分钟'],
    [3599, '59', '分钟'],
    [3599.9, '1', '小时'],
    [3600, '1', '小时'],
    [5400, '1.5', '小时'],
    [7200, '2', '小时'],
    [8100, '2.3', '小时']
  ]
  for (const [seconds, value, unit] of cases) {
    assert.deepEqual(listeningDurationParts(seconds), { value, unit })
  }
  assert.equal(formatDayLabel('2024-02-09'), '2月9日')
})

test('日历在闰年边界也严格限制为含今天的 365 天', () => {
  const cases = [
    ['2024-02-29', '2023-03-02'],
    ['2024-03-01', '2023-03-03'],
    ['2025-02-28', '2024-03-01'],
    ['2024-03-04', '2023-03-06'],
    ['2024-03-03', '2023-03-05']
  ]
  for (const [today, first] of cases) {
    const calendar = buildListeningCalendar({}, new Date(`${today}T23:59:59Z`))
    const range = calendar.cells.filter((cell) => cell.inRange)
    assert.equal(range.length, 365)
    assert.equal(range[0].key, first)
    assert.equal(range.at(-1)?.key, today)
    assert.equal(calendar.cells.length, calendar.weeks * 7)
    assert.equal(calendar.weeks, 53)
    assert.equal(new Date(calendar.cells[0].key).getUTCDay(), 1)
    assert.equal(new Date(calendar.cells.at(-1)!.key).getUTCDay(), 0)
    assert.equal(calendar.cells.filter((cell) => cell.isToday).length, 1)
    assert.ok(range.at(-1)?.isToday)
    for (let index = 1; index < calendar.cells.length; index += 1) {
      assert.equal(
        Date.parse(calendar.cells[index].key) - Date.parse(calendar.cells[index - 1].key),
        DAY_MS
      )
    }
  }
})

test('日历补位禁用、不汇总边界外记录、月份列从 1 开始且忽略补位月份', () => {
  const calendar = buildListeningCalendar(
    { '2023-02-28': 10000, '2023-03-01': 10000, '2023-03-02': 60, '2024-03-01': 10000 },
    new Date('2024-03-01T00:30:00+08:00')
  )
  for (const cell of calendar.cells) {
    if (!cell.inRange) {
      assert.equal(cell.seconds, 0)
      assert.equal(cell.level, 0)
      assert.equal(cell.isToday, false)
    }
  }
  assert.equal(calendar.summary.seconds, 60)
  assert.equal(calendar.summary.averageSeconds, 60 / 365)
  assert.deepEqual(calendar.months[0], { key: '2023-03', label: '3月', column: 1 })
  assert.equal(calendar.months.at(-1)?.key, '2024-02')
  for (const month of calendar.months) {
    const index = calendar.cells.findIndex((cell) => cell.inRange && cell.key.startsWith(month.key))
    assert.equal(month.column, Math.floor(index / 7) + 1)
    assert.ok(month.column >= 1 && month.column <= calendar.weeks)
  }
})

test('日历等级只有 0 到 4，无效记录不影响等级与汇总', () => {
  const calendar = buildListeningCalendar(
    {
      '2024-02-23': NaN,
      '2024-02-24': Infinity,
      '2024-02-25': -20,
      '2024-02-26': 25,
      '2024-02-27': 50,
      '2024-02-28': 75,
      '2024-02-29': 100
    },
    new Date('2024-02-29T00:00:00Z')
  )
  assert.deepEqual(
    calendar.cells.filter((cell) => cell.seconds > 0).map((cell) => cell.level),
    [1, 2, 3, 4]
  )
  assert.equal(calendar.summary.seconds, 250)
  assert.equal(calendar.summary.activeDays, 4)
  assert.equal(calendar.summary.longestStreak, 4)
})

test('曲目仅按实际记录计数，秒数和播放数分别清理非有限值', () => {
  const tracks = {
    secondsOnly: trackStat('flac', 20, 0),
    playsOnly: trackStat('mp3', 0, 3),
    both: trackStat(' flac ', 30, 2),
    invalidSeconds: trackStat('aac', Infinity, 1),
    invalidPlays: trackStat('wav', 5, NaN),
    empty: trackStat('ogg', 0, 0),
    invalid: trackStat('aiff', -5, -Infinity)
  }
  const summary = summarizeRecordedTracks(tracks)
  assert.equal(summary.seconds, 55)
  assert.equal(summary.plays, 6)
  assert.equal(summary.trackCount, 5)
  assert.deepEqual(
    summary.formats.map((format) => format.key),
    ['FLAC', 'AAC', 'MP3', 'WAV']
  )
  assert.equal(
    summary.formats.reduce((sum, format) => sum + format.count, 0),
    summary.trackCount
  )
  for (const format of summary.formats) {
    assert.equal(format.percent, (format.count / summary.trackCount) * 100)
  }
})

test('格式只使用明确 format，不由文件名、采样率或位深推断质量', () => {
  const noSnapshot = trackStat()
  delete noSnapshot.track
  const summary = summarizeRecordedTracks({
    missing: trackStat(),
    blank: trackStat('   '),
    noSnapshot,
    normalized: trackStat(' fLaC '),
    otherFlac: trackStat('FLAC')
  })
  assert.deepEqual(summary.formats, [
    { key: 'unknown', label: '未知', count: 3, percent: 60 },
    { key: 'FLAC', label: 'FLAC', count: 2, percent: 40 }
  ])
})

test('格式同数按字母顺序稳定排序，保留未知并折叠长尾且计数守恒', () => {
  const formats = ['wav', 'ogg', 'mp3', 'flac', 'dsd', 'alac', 'aac', '']
  const tracks: ListeningStats['tracks'] = {}
  for (const format of formats) tracks[format] = trackStat(format)
  const summary = summarizeRecordedTracks(tracks)
  assert.deepEqual(
    summary.formats.map((format) => format.key),
    ['AAC', 'ALAC', 'DSD', 'FLAC', 'unknown', 'other']
  )
  assert.deepEqual(summary.formats.at(-1), { key: 'other', label: '其他', count: 3, percent: 37.5 })
  assert.equal(summary.formats.length, 6)
  assert.equal(
    summary.formats.reduce((sum, format) => sum + format.count, 0),
    8
  )
  assert.equal(
    summary.formats.reduce((sum, format) => sum + format.percent, 0),
    100
  )
  assert.equal(summary.seconds, 480)
  assert.equal(summary.plays, 8)
  const reversed: ListeningStats['tracks'] = {}
  for (const format of [...formats].reverse()) reversed[format] = tracks[format]
  assert.deepEqual(summarizeRecordedTracks(reversed), summary)
})

test('空曲目汇总无格式且忽略继承属性', () => {
  const tracks: ListeningStats['tracks'] = Object.create({ inherited: trackStat('flac') })
  const expected = { seconds: 0, plays: 0, trackCount: 0, formats: [] }
  assert.deepEqual(summarizeRecordedTracks({}), expected)
  assert.deepEqual(summarizeRecordedTracks(tracks), expected)
  assert.deepEqual(summarizeRecordedTracks({ empty: trackStat('flac', 0, 0) }), expected)
})

test('所有构建和汇总函数不更改输入，也不向结果泄漏输入对象', () => {
  const days = Object.freeze({ '2024-02-29': 60 })
  const now = new Date('2024-02-29T23:59:00Z')
  const timestamp = now.getTime()
  const rows: AnalyticsDay[] = [{ key: '2024-02-29', seconds: 60 }]
  Object.freeze(rows[0])
  Object.freeze(rows)
  const stat = trackStat(' flac ')
  Object.freeze(stat.track)
  Object.freeze(stat)
  const tracks = Object.freeze({ first: stat })
  const snapshot = structuredClone(tracks)
  buildListeningDays(days, now, 7, 7)
  const calendar = buildListeningCalendar(days, now)
  const summary = summarizeDays(rows)
  const recorded = summarizeRecordedTracks(tracks)
  calendar.cells.find((cell) => cell.isToday)!.seconds = 99
  summary.bestDay!.seconds = 99
  recorded.formats[0].label = '变更'
  assert.equal(now.getTime(), timestamp)
  assert.deepEqual(days, { '2024-02-29': 60 })
  assert.deepEqual(rows, [{ key: '2024-02-29', seconds: 60 }])
  assert.deepEqual(tracks, snapshot)
})
