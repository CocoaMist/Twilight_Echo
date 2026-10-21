import assert from 'node:assert/strict'
import test from 'node:test'
import { computed, effectScope, ref, shallowRef } from 'vue'
import { useTrackMultiSelect } from './useTrackMultiSelect.ts'
import {
  addSelectionRange,
  selectionContains,
  toggleSelectionPosition
} from '../../../../shared/librarySelectionRanges.ts'
import type { LibrarySelectionRange } from '../../../../shared/librarySelection.ts'
import type { Track } from '../../types/music.ts'

function fixture(t: test.TestContext) {
  const scope = effectScope(),
    enabled = ref(true),
    total = ref(300_000),
    epoch = ref(0),
    offset = ref(0)
  const rows = shallowRef<Track[]>([])
  const positions = computed(
    () => new Map(rows.value.map((row, index) => [row.id, offset.value + index]))
  )
  const selection = scope.run(() =>
    useTrackMultiSelect({
      tracks: rows,
      querySelection: () =>
        enabled.value
          ? { total: total.value, positionForKey: (key) => positions.value.get(key) ?? null }
          : null,
      selectionOrder: (row) => positions.value.get(row.id) ?? -1,
      preserveSelectedTracks: enabled,
      snapshotTrack: () => {
        throw new Error('Query selection must not cache Track records')
      },
      rangeContext: offset,
      resetSources: [epoch]
    })
  )!
  const page = (start: number) => {
    offset.value = start
    rows.value = Array.from(
      { length: Math.min(200, total.value - start) },
      (_, i) => ({ id: String(start + i), title: `Row ${start + i}` }) as Track
    )
  }
  t.after(() => scope.stop())
  page(0)
  return { selection, rows, page, total, enabled, epoch }
}

test('query select-all represents 300k rows with one interval and no IDs or cached records', (t) => {
  const { selection, page } = fixture(t)
  selection.selectAll()
  assert.equal(selection.selectedCount.value, 300_000)
  assert.equal(selection.selectedIds.value.size, 0)
  assert.deepEqual(selection.getSelectedRanges(), [[0, 300_000]])
  page(234_500)
  assert.equal(selection.isSelected('234567'), true)
  assert.throws(() => selection.getSelectedTracks(), /异步批次/)
  assert.throws(() => selection.getSelectedTrackIds(), /异步批次/)
  selection.toggle('234567', 67)
  assert.equal(selection.isSelected('234567'), false)
  assert.equal(selection.selectedCount.value, 299_999)
  assert.deepEqual(selection.getSelectedRanges(), [
    [0, 234567],
    [234568, 300000]
  ])
})

test('Shift range crosses unloaded pages and eviction while keeping the original absolute anchor', (t) => {
  const { selection, page, rows } = fixture(t)
  selection.selectOnly('10', 10)
  page(234_500)
  selection.onRowClick(rows.value[67], 67, { shiftKey: true } as MouseEvent)
  assert.deepEqual(selection.getSelectedRanges(), [[10, 234568]])
  assert.equal(selection.selectedCount.value, 234558)
  page(1000)
  selection.onRowClick(rows.value[5], 5, { shiftKey: true } as MouseEvent)
  assert.deepEqual(
    selection.getSelectedRanges(),
    [[10, 234568]],
    'paged range union retains prior explicit intent'
  )
  assert.equal(selection.isSelected('1005'), true)
})

test('query toggles merge and split ranges; reset, count/source changes and disposal release intent', (t) => {
  const { selection, page, epoch, enabled, total } = fixture(t)
  selection.toggle('3', 3)
  selection.toggle('4', 4)
  selection.toggle('6', 6)
  assert.deepEqual(selection.getSelectedRanges(), [
    [3, 5],
    [6, 7]
  ])
  const old = selection.selectionVersion.value
  selection.toggle('5', 5)
  assert.ok(selection.selectionVersion.value > old)
  assert.deepEqual(selection.getSelectedRanges(), [[3, 7]])
  page(10_000)
  assert.equal(selection.selectedCount.value, 4)
  epoch.value++
  assert.equal(selection.selectedCount.value, 0)
  selection.selectAll()
  total.value = 5
  assert.equal(selection.selectedCount.value, 0)
  page(0)
  selection.selectAll()
  enabled.value = false
  assert.equal(selection.selectedCount.value, 0)
  assert.equal(selection.getSelectedRanges(), null)
})

test('duplicate Track IDs still select independent query occurrences', () => {
  const rows = [{ id: 'same' }, { id: 'same' }] as Track[],
    positions = new Map([
      [rows[0], 200],
      [rows[1], 9000]
    ])
  const selection = useTrackMultiSelect({
    tracks: () => rows,
    keyForTrack: (track) => (track === rows[0] ? 'first' : 'second'),
    selectionOrder: (track) => positions.get(track)!,
    querySelection: () => ({
      total: 10_000,
      positionForKey: (key) => (key === 'first' ? 200 : 9000)
    })
  })
  selection.toggle('first', 0, rows[0])
  assert.equal(selection.isSelected('first'), true)
  assert.equal(selection.isSelected('second'), false)
  selection.toggle('second', 1, rows[1])
  assert.deepEqual(selection.getSelectedRanges(), [
    [200, 201],
    [9000, 9001]
  ])
})

test('interval normalization matches a concrete set over deterministic mixed add/toggle operations', () => {
  let ranges: LibrarySelectionRange[] = [],
    seed = 42
  const selected = new Set<number>()
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed
  }
  for (let iteration = 0; iteration < 2000; iteration++) {
    const a = random() % 300,
      b = Math.min(300, a + (random() % 40) + 1)
    if (iteration % 3) {
      ranges = toggleSelectionPosition(ranges, a)
      if (selected.has(a)) selected.delete(a)
      else selected.add(a)
    } else {
      ranges = addSelectionRange(ranges, a, b)
      for (let p = a; p < b; p++) selected.add(p)
    }
    for (let p = 0; p < 300; p++) assert.equal(selectionContains(ranges, p), selected.has(p))
    assert.equal(
      ranges.reduce((n, [start, end]) => n + end - start, 0),
      selected.size
    )
    for (let i = 1; i < ranges.length; i++) assert.ok(ranges[i - 1][1] < ranges[i][0])
  }
})
