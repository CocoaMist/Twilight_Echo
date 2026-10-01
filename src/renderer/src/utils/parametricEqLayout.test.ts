import assert from 'node:assert/strict'
import test from 'node:test'
import { constrainEqInspector, placeEqInspector, placeEqTooltip } from './parametricEqLayout.ts'

test('inspector stays at the bottom unless it would cover the selected node', () => {
  const plot = { width: 1000, height: 600 }
  const panel = { width: 460, height: 146 }
  assert.deepEqual(placeEqInspector(plot, { x: 500, y: 200 }, panel), { left: 270, top: 442 })
  assert.deepEqual(placeEqInspector(plot, { x: 500, y: 450 }, panel), { left: 270, top: 12 })
  assert.deepEqual(placeEqInspector(plot, { x: 50, y: 500 }, panel), { left: 270, top: 442 })
})

test('tooltips remain inside the plot at all frequency and gain extremes', () => {
  for (const width of [300, 660, 1300]) {
    const plot = { width, height: 360 }
    for (const x of [0, width / 2, width]) {
      for (const y of [0, 180, 360]) {
        const tooltip = placeEqTooltip(plot, { x, y })
        assert.ok(tooltip.left >= 0)
        assert.ok(tooltip.left + tooltip.width <= width)
        assert.ok(tooltip.top >= 0 && tooltip.top + 64 <= plot.height)
      }
    }
  }
})

test('manual inspector placement stays within the plot and reclamps after resize', () => {
  const panel = { width: 460, height: 158 }
  const position = { left: 250, top: 170 }
  assert.deepEqual(constrainEqInspector({ width: 1000, height: 600 }, panel, position), position)
  assert.deepEqual(constrainEqInspector({ width: 700, height: 300 }, panel, position), {
    left: 232,
    top: 134
  })
  for (const left of [-10000, 0, 300, 10000])
    for (const top of [-10000, 0, 300, 10000]) {
      const placement = constrainEqInspector({ width: 800, height: 400 }, panel, { left, top })
      assert.ok(placement.left >= 8 && placement.left + panel.width <= 792)
      assert.ok(placement.top >= 8 && placement.top + panel.height <= 392)
    }
})
