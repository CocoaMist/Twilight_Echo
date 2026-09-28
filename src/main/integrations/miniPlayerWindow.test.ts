import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MINI_PLAYER_MAX_HEIGHT,
  MINI_PLAYER_MAX_WIDTH,
  MINI_PLAYER_MIN_HEIGHT,
  MINI_PLAYER_MIN_WIDTH,
  clampMiniPlayerBoundsToWorkArea,
  isMiniPlayerBoundsEcho,
  miniPlayerBoundsPatch,
  parseMiniPlayerMoveTarget,
  resizeMiniPlayerBounds
} from './miniPlayerWindow.ts'

test('mini player bounds clamp size before position inside a display work area', () => {
  const bounds = clampMiniPlayerBoundsToWorkArea(
    { x: -500, y: -200, width: 1400, height: 50 },
    { x: 0, y: 0, width: 800, height: 600 }
  )
  assert.deepEqual(bounds, {
    x: 0,
    y: 0,
    width: Math.min(MINI_PLAYER_MAX_WIDTH, 800),
    height: MINI_PLAYER_MIN_HEIGHT
  })
})

test('mini player bounds enforce the minimum supported window size', () => {
  const bounds = clampMiniPlayerBoundsToWorkArea(
    { x: 120, y: 80, width: 1, height: 1 },
    { x: 0, y: 0, width: 1920, height: 1040 }
  )
  assert.deepEqual(bounds, {
    x: 120,
    y: 80,
    width: MINI_PLAYER_MIN_WIDTH,
    height: MINI_PLAYER_MIN_HEIGHT
  })
})

test('mini player bounds support negative monitor coordinates', () => {
  const bounds = clampMiniPlayerBoundsToWorkArea(
    { x: -3000, y: 90, width: 520, height: 220 },
    { x: -1920, y: 0, width: 1920, height: 1040 }
  )
  assert.deepEqual(bounds, { x: -1920, y: 90, width: 520, height: 220 })
})

test('mini player bounds patch persists position and size together', () => {
  assert.deepEqual(miniPlayerBoundsPatch({ x: 20, y: 30, width: 700, height: 260 }), {
    windowX: 20,
    windowY: 30,
    windowWidth: 700,
    windowHeight: 260
  })
  assert.equal(MINI_PLAYER_MIN_WIDTH, 300)
  assert.equal(MINI_PLAYER_MIN_HEIGHT, 88)
  assert.equal(MINI_PLAYER_MAX_WIDTH, 900)
  assert.equal(MINI_PLAYER_MAX_HEIGHT, 520)
})

test('mini player drag targets accept finite coordinates and reject everything else', () => {
  assert.deepEqual(parseMiniPlayerMoveTarget({ x: -1919.6, y: 40.2 }), { x: -1920, y: 40 })
  assert.equal(parseMiniPlayerMoveTarget(null), null)
  assert.equal(parseMiniPlayerMoveTarget([10, 20]), null)
  assert.equal(parseMiniPlayerMoveTarget({ x: '10', y: 20 }), null)
  assert.equal(parseMiniPlayerMoveTarget({ x: Number.NaN, y: 20 }), null)
  assert.equal(parseMiniPlayerMoveTarget({ x: 10, y: Number.POSITIVE_INFINITY }), null)
  assert.equal(parseMiniPlayerMoveTarget({ x: 100_001, y: 0 }), null)
})

test('mini player bounds echoes absorb scale-factor rounding but not user edits', () => {
  const requested = { x: 1538, y: 930, width: 360, height: 88 }
  assert.equal(isMiniPlayerBoundsEcho({ x: 1538, y: 930, width: 361, height: 90 }, requested), true)
  assert.equal(isMiniPlayerBoundsEcho({ x: 1537, y: 931, width: 364, height: 92 }, requested), true)
  assert.equal(
    isMiniPlayerBoundsEcho({ x: 1538, y: 930, width: 392, height: 88 }, requested),
    false
  )
  assert.equal(
    isMiniPlayerBoundsEcho({ x: 1528, y: 930, width: 360, height: 88 }, requested),
    false
  )
})

test('mini player form switches keep the corner the window is parked in', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1040 }
  const strip = { x: 1538, y: 930, width: 360, height: 88 }
  const card = resizeMiniPlayerBounds(strip, { width: 440, height: 184 }, workArea)
  assert.deepEqual(card, { x: 1458, y: 834, width: 440, height: 184 })
  assert.deepEqual(resizeMiniPlayerBounds(card, { width: 300, height: 440 }, workArea), {
    x: 1598,
    y: 578,
    width: 300,
    height: 440
  })
  assert.deepEqual(resizeMiniPlayerBounds(card, { width: 360, height: 88 }, workArea), strip)

  assert.deepEqual(
    resizeMiniPlayerBounds(
      { x: 40, y: 30, width: 360, height: 88 },
      { width: 640, height: 260 },
      workArea
    ),
    { x: 40, y: 30, width: 640, height: 260 }
  )
})

test('mini player anchored resizes still clamp to a small display', () => {
  assert.deepEqual(
    resizeMiniPlayerBounds(
      { x: -1000, y: 300, width: 360, height: 88 },
      { width: 640, height: 520 },
      { x: -1920, y: 0, width: 1280, height: 400 }
    ),
    { x: -1280, y: 0, width: 640, height: 400 }
  )
})
