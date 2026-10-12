import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildDisplacementPixels,
  clearDisplacementMapCache,
  displacementScaleForRadius,
  geometryChanged,
  geometryKey,
  getDisplacementMapUrl,
  liquidRel,
  MAX_DISPLACEMENT_MAP_AXIS,
  MAX_GLASS_RASTER_AXIS,
  MAX_GLASS_RASTER_PIXELS,
  NEUTRAL_BYTE,
  NOMINAL_CARD_GEOMETRY,
  NOMINAL_PLAYBAR_GEOMETRY,
  refractionDistance,
  refractionOffset,
  resolveRasterGeometry,
  resolveRasterSampling,
  rasterSamplingKey,
  roundedRectSDF,
  sdfNormal,
  type DisplacementGeometry,
  type RoundedRectShape
} from './liquidGlassDisplacement.ts'

const SQUARE_SHAPE: RoundedRectShape = { halfWidth: 32, halfHeight: 32, radius: 14 }
const SQUARE_GEOMETRY: DisplacementGeometry = { width: 64, height: 64, radius: 14 }

/** R/G/A of the baked map at a pixel. */
function channelAt(
  raster: { pixels: Uint8ClampedArray; width: number },
  x: number,
  y: number,
  channel: number
): number {
  return raster.pixels[(y * raster.width + x) * 4 + channel]
}

test('roundedRectSDF is negative inside and positive outside', () => {
  assert.ok(roundedRectSDF(0, 0, 0.3, 0.2, 0.1) < 0, 'center is inside')
  assert.ok(roundedRectSDF(5, 5, 0.3, 0.2, 0.1) > 0, 'far corner is outside')
})

test('roundedRectSDF is symmetric across both axes', () => {
  const base = roundedRectSDF(0.17, 0.09, 0.3, 0.2, 0.6)
  assert.equal(roundedRectSDF(-0.17, 0.09, 0.3, 0.2, 0.6), base)
  assert.equal(roundedRectSDF(0.17, -0.09, 0.3, 0.2, 0.6), base)
  assert.equal(roundedRectSDF(-0.17, -0.09, 0.3, 0.2, 0.6), base)
})

test('sdfNormal is a unit vector pointing outward', () => {
  const straightEdge = sdfNormal(-31.5, 0.5, SQUARE_SHAPE)
  assert.equal(straightEdge.x, -1, 'left edge normal points left')
  assert.equal(straightEdge.y, 0, 'left edge normal has no Y component')

  const corner = sdfNormal(28.5, -28.5, SQUARE_SHAPE)
  const length = Math.hypot(corner.x, corner.y)
  assert.ok(Math.abs(length - 1) < 1e-12, `corner normal is unit length, got ${length}`)
  assert.ok(corner.x > 0 && corner.y < 0, 'top-right corner normal points up-right')
  assert.ok(Math.abs(Math.abs(corner.x) - Math.abs(corner.y)) < 1e-12, '45° on the diagonal')
})

test('liquidRel runs from fully refracting at the boundary to clear inside', () => {
  assert.equal(liquidRel(0), 0, 'boundary refracts fully')
  assert.equal(liquidRel(1), 1, 'inner edge of the band is clear')
  assert.ok(liquidRel(-2) === 0, 'clamped below')
  assert.ok(liquidRel(4) === 1, 'clamped above')
})

test('liquidRel rises monotonically and stays within [0, 1]', () => {
  let previous = -Infinity
  for (let i = 0; i <= 40; i++) {
    const value = liquidRel(i / 40)
    assert.ok(value >= 0 && value <= 1, `out of range at ${i / 40}: ${value}`)
    assert.ok(value >= previous - 1e-12, `not monotonic at ${i / 40}`)
    previous = value
  }
})

test('liquidRel concentrates the bend against the boundary', () => {
  // The whole point of this curve over a smoothstep: at the halfway depth the
  // surface must already read mostly clear, which is what keeps the middle of a
  // panel optically open instead of hazing over.
  assert.ok(liquidRel(0.5) > 0.5, `midpoint should be past halfway clear, was ${liquidRel(0.5)}`)
})

test('refractionDistance is bounded by the radius and zero outside', () => {
  // This bound is the whole ghosting fix: a pixel can never sample further than
  // its own distance to the boundary, so the sample always lands inside.
  assert.equal(refractionDistance(0, 22), 22, 'boundary samples one radius inward')
  assert.equal(refractionDistance(-22, 22), 0, 'one radius deep is already clear')
  assert.equal(refractionDistance(-500, 22), 0, 'deep interior is untouched')
  assert.equal(refractionDistance(5, 22), 22, 'clamped at the radius outside the shape')
})

test('every sampled point stays inside the surface', () => {
  // This is the invariant that stops doubled text. The offset is *inward* along
  // the normal and capped at one radius, so a boundary pixel reads content one
  // radius in rather than content from beyond the far edge. An unbounded
  // `feDisplacementMap scale` broke exactly this.
  const shape = SQUARE_SHAPE
  for (let y = -31.5; y <= 31.5; y += 0.5) {
    for (let x = -31.5; x <= 31.5; x += 0.5) {
      const signedDistance = roundedRectSDF(x, y, shape.halfWidth, shape.halfHeight, shape.radius)
      if (signedDistance > 0) continue
      const sample = refractionOffset(x, y, shape, shape.radius)
      const offsetPx = Math.hypot(sample.x, sample.y) * shape.radius
      assert.ok(
        offsetPx <= shape.radius + 1e-9,
        `offset ${offsetPx.toFixed(3)}px exceeds the radius at ${x},${y}`
      )

      // The sampled coordinate itself must land within the shape.
      const sampled = roundedRectSDF(
        x + sample.x * shape.radius,
        y + sample.y * shape.radius,
        shape.halfWidth,
        shape.halfHeight,
        shape.radius
      )
      assert.ok(sampled <= 1e-9, `sample escaped the surface at ${x},${y} (sdf ${sampled})`)
    }
  }
})

test('refraction offset points inward on every side', () => {
  const rim = SQUARE_SHAPE.radius
  assert.ok(refractionOffset(-31.5, 0, SQUARE_SHAPE, rim).x > 0, 'left pushes right')
  assert.ok(refractionOffset(31.5, 0, SQUARE_SHAPE, rim).x < 0, 'right pushes left')
  assert.ok(refractionOffset(0, -31.5, SQUARE_SHAPE, rim).y > 0, 'top pushes down')
  assert.ok(refractionOffset(0, 31.5, SQUARE_SHAPE, rim).y < 0, 'bottom pushes up')
})

test('refraction offset is zero at the exact center', () => {
  const center = refractionOffset(0, 0, SQUARE_SHAPE, SQUARE_SHAPE.radius)
  assert.equal(center.x, 0)
  assert.equal(center.y, 0)
  assert.equal(center.magnitude, 0)
})

test('refraction offset is antisymmetric about the center', () => {
  const rim = SQUARE_SHAPE.radius
  const a = refractionOffset(-30, -26, SQUARE_SHAPE, rim)
  const b = refractionOffset(30, 26, SQUARE_SHAPE, rim)
  assert.ok(Math.abs(a.x + b.x) < 1e-12, 'x mirrors')
  assert.ok(Math.abs(a.y + b.y) < 1e-12, 'y mirrors')
  assert.equal(a.magnitude, b.magnitude, 'magnitude mirrors')
})

test('corner regions refract diagonally, straight edges stay single-axis', () => {
  const rim = SQUARE_SHAPE.radius
  // Just inside the top-right corner arc. (28.5, -28.5) is *outside* this shape —
  // the arc of a 14.08px radius on a 64px box bows well inside the bounding box
  // corner, so a point that looks near the corner can be past the boundary.
  const corner = refractionOffset(26, -26, SQUARE_SHAPE, rim)
  assert.ok(corner.x < 0, 'corner pulls left (inward)')
  assert.ok(corner.y > 0, 'corner pulls down (inward)')
  assert.ok(Math.abs(corner.x) > 0.05 && Math.abs(corner.y) > 0.05, 'both axes are engaged')

  const edge = refractionOffset(-31.5, 0.5, SQUARE_SHAPE, rim)
  assert.ok(edge.x > 0.05, 'edge pulls inward on X')
  assert.equal(edge.y, 0, 'edge has no Y component')
})

test('a zero radius refracts nothing rather than dividing by zero', () => {
  const square: RoundedRectShape = { halfWidth: 20, halfHeight: 20, radius: 0 }
  const sample = refractionOffset(-19.5, 0, square, 1)
  assert.equal(sample.x, 0)
  assert.equal(sample.y, 0)
  assert.equal(sample.magnitude, 0)
})

test('displacementScaleForRadius reproduces the radius as a real pixel offset', () => {
  // feDisplacementMap shifts by scale * (channel - 0.5), and a unit offset encodes
  // as 1.0, so a full-strength lens needs 2 * radius to move exactly radius px.
  assert.equal(displacementScaleForRadius(22, 1), 44)
  assert.equal(displacementScaleForRadius(22, 0.5), 22)
  assert.equal(displacementScaleForRadius(22, 0), 0)
  assert.equal(displacementScaleForRadius(0, 1), 0)
})

test('displacementScaleForRadius rejects unusable input instead of emitting NaN', () => {
  // The result is bound straight onto an SVG attribute, where NaN is fatal.
  assert.equal(displacementScaleForRadius(Number.NaN, 1), 0)
  assert.equal(displacementScaleForRadius(22, Number.NaN), 0)
  assert.equal(displacementScaleForRadius(-5, 1), 0)
  assert.equal(displacementScaleForRadius(22, -1), 0)
})

test('raster geometry rounds fractional layout sizes', () => {
  const resolved = resolveRasterGeometry({ width: 24.6, height: 16.2, radius: 5 })
  assert.equal(resolved.width, 25)
  assert.equal(resolved.height, 16)
})

test('raster geometry clamps a pill radius to a true capsule', () => {
  // `border-radius: 999px` is how the app declares pills; taken literally it
  // would blow straight past the shape.
  const resolved = resolveRasterGeometry({ width: 200, height: 40, radius: 999 })
  assert.equal(resolved.shape.radius, 20, 'radius capped at the short half-axis')
})

test('raster geometry caps its long axis and scales the shape to match', () => {
  const wide = 4000
  const resolved = resolveRasterGeometry({ width: wide, height: 72, radius: 22 })
  assert.ok(resolved.width <= MAX_DISPLACEMENT_MAP_AXIS, `width was ${resolved.width}`)
  // Corners must stay proportionate to the raster, or the arc lands off the corner.
  const scale = resolved.width / wide
  assert.ok(Math.abs(resolved.shape.radius - 22 * scale) < 0.5, 'radius scaled with the raster')
})

test('the band width defaults to the radius and is overridable', () => {
  assert.equal(resolveRasterGeometry({ width: 64, height: 64, radius: 14 }).blurRadius, 14)
  assert.equal(
    resolveRasterGeometry({ width: 64, height: 64, radius: 14, blurRadius: 30 }).blurRadius,
    30
  )
})

test('pixel buffer has RGBA length and stays fully opaque', () => {
  const raster = buildDisplacementPixels({ width: 24, height: 16, radius: 6 })

  assert.equal(raster.pixels.length, raster.width * raster.height * 4)
  assert.ok(raster.pixels instanceof Uint8ClampedArray)
  // Alpha must not carry the profile. Chromium decodes images premultiplied, so a
  // transparent interior loses its RGB and the neutral 128 becomes 0 — which
  // `feDisplacementMap` reads as a full-amplitude shift of the entire backdrop
  // instead of no displacement at all.
  for (let p = 3; p < raster.pixels.length; p += 4) {
    assert.equal(raster.pixels[p], 255, `alpha at byte ${p} is not opaque`)
  }
})

test('refraction magnitude decreases monotonically from border to center', () => {
  const raster = buildDisplacementPixels(SQUARE_GEOMETRY)
  const y = raster.height / 2
  let previous = Infinity
  for (let x = 0; x <= raster.width / 2; x++) {
    // The X offset itself is the profile now that alpha is uniform.
    const value = Math.abs(channelAt(raster, x, y, 0) - NEUTRAL_BYTE)
    assert.ok(value <= previous + 1, `not monotonic at x=${x}: ${value} > ${previous}`)
    previous = value
  }
})

test('G and B channels carry the same Y offset', () => {
  const raster = buildDisplacementPixels({ width: 20, height: 20, radius: 5 })
  for (let p = 0; p < raster.pixels.length; p += 4) {
    assert.equal(raster.pixels[p + 1], raster.pixels[p + 2], `G/B mismatch at byte ${p}`)
  }
})

test('map center is neutral so the middle of a surface is not displaced', () => {
  const raster = buildDisplacementPixels(SQUARE_GEOMETRY)
  const mid = raster.width / 2

  assert.ok(Math.abs(channelAt(raster, mid, mid, 0) - NEUTRAL_BYTE) <= 2, 'R center is neutral')
  assert.ok(Math.abs(channelAt(raster, mid, mid, 1) - NEUTRAL_BYTE) <= 2, 'G center is neutral')
})

test('map carries strong displacement at the border', () => {
  const raster = buildDisplacementPixels(SQUARE_GEOMETRY)
  const y = raster.height / 2

  const leftR = channelAt(raster, 0, y, 0)
  const rightR = channelAt(raster, raster.width - 1, y, 0)

  // border must deviate hard from neutral, or nothing visibly refracts
  assert.ok(leftR - NEUTRAL_BYTE > 100, `left border R was ${leftR}`)
  assert.ok(NEUTRAL_BYTE - rightR > 100, `right border R was ${rightR}`)
})

test('displacement is strongest at the border and weakest at the center', () => {
  const raster = buildDisplacementPixels(SQUARE_GEOMETRY)
  const y = raster.height / 2
  const deviation = (x: number): number => Math.abs(channelAt(raster, x, y, 0) - NEUTRAL_BYTE)

  assert.ok(deviation(0) > deviation(3), 'border beats near-rim')
  assert.ok(deviation(3) > deviation(raster.width / 2), 'near-rim beats center')
})

test('map is symmetric left-to-right and top-to-bottom', () => {
  const raster = buildDisplacementPixels({ width: 32, height: 32, radius: 8 })
  const size = raster.width

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // R mirrors with inverted sign around neutral. Neutral is 128 while the byte
      // midpoint is 127.5, so quantization allows one unit of slack.
      const left = channelAt(raster, x, y, 0) - NEUTRAL_BYTE
      const right = channelAt(raster, size - 1 - x, y, 0) - NEUTRAL_BYTE
      assert.ok(Math.abs(left + right) <= 1, `R asymmetry at ${x},${y}: ${left} vs ${right}`)

      const top = channelAt(raster, x, y, 1) - NEUTRAL_BYTE
      const bottom = channelAt(raster, x, size - 1 - y, 1) - NEUTRAL_BYTE
      assert.ok(Math.abs(top + bottom) <= 1, `G asymmetry at ${x},${y}: ${top} vs ${bottom}`)
    }
  }
})

test('corner pixels deviate on both channels while edge midpoints stay single-axis', () => {
  const raster = buildDisplacementPixels(SQUARE_GEOMETRY)
  const size = raster.width

  // Top-right corner region: diagonal inward pull engages R and G together. The
  // probe has to sit *inside* the rounded corner — a few px further out at
  // (size-4, 3) is past the arc, where the field is zero because the filter clips
  // it anyway.
  const cornerR = channelAt(raster, size - 6, 5, 0) - NEUTRAL_BYTE
  const cornerG = channelAt(raster, size - 6, 5, 1) - NEUTRAL_BYTE
  assert.ok(cornerR < -20, `corner R deviates inward, was ${cornerR}`)
  assert.ok(cornerG > 20, `corner G deviates inward, was ${cornerG}`)

  // Left edge midpoint: R only.
  assert.ok(channelAt(raster, 0, size / 2, 0) - NEUTRAL_BYTE > 100, 'edge R deviates')
  assert.ok(Math.abs(channelAt(raster, 0, size / 2, 1) - NEUTRAL_BYTE) <= 2, 'edge G is neutral')
})

test('a wide strip refracts on both axes at its own radius', () => {
  const raster = buildDisplacementPixels(NOMINAL_PLAYBAR_GEOMETRY)
  const midX = Math.trunc(raster.width / 2)
  const midY = Math.trunc(raster.height / 2)

  const topG = channelAt(raster, midX, 0, 1)
  const bottomG = channelAt(raster, midX, raster.height - 1, 1)
  assert.ok(topG - NEUTRAL_BYTE > 60, `top edge G was ${topG}`)
  assert.ok(NEUTRAL_BYTE - bottomG > 60, `bottom edge G was ${bottomG}`)

  assert.ok(channelAt(raster, 0, midY, 0) - NEUTRAL_BYTE > 60, 'left edge refracts on X')
})

test('a wider radius rounds more of the map', () => {
  // Band width is pinned so the radius is the only variable. Left free, it would
  // default to the radius and confound "rounder corner" with "deeper band".
  const sharp = buildDisplacementPixels({ width: 64, height: 64, radius: 3, blurRadius: 12 })
  const round = buildDisplacementPixels({ width: 64, height: 64, radius: 28, blurRadius: 12 })

  // A point inside the corner quadrant, 6.5px deep. The sharp map's radius is
  // only 3px, so this pixel is already past its lens and reads clear on both
  // channels; the round map still bends it, diagonally.
  const sharpX = channelAt(sharp, 52, 6, 0) - NEUTRAL_BYTE
  const sharpY = channelAt(sharp, 52, 6, 1) - NEUTRAL_BYTE
  const roundX = channelAt(round, 52, 6, 0) - NEUTRAL_BYTE
  const roundY = channelAt(round, 52, 6, 1) - NEUTRAL_BYTE

  assert.equal(sharpX, 0, `beyond a 3px radius nothing refracts on X, was ${sharpX}`)
  assert.equal(sharpY, 0, `beyond a 3px radius nothing refracts on Y, was ${sharpY}`)
  assert.ok(roundX < -20, `round map corner pulls inward on X, was ${roundX}`)
  assert.ok(roundY > 20, `round map corner pulls inward on Y, was ${roundY}`)
})

test('invalid sizes are rejected rather than producing a broken map', () => {
  assert.throws(
    () => buildDisplacementPixels({ width: 0, height: 10, radius: 2 }),
    /invalid displacement map size/
  )
  assert.throws(
    () => buildDisplacementPixels({ width: 10, height: 0, radius: 2 }),
    /invalid displacement map size/
  )
  assert.throws(
    () => buildDisplacementPixels({ width: -4, height: 4, radius: 2 }),
    /invalid displacement map size/
  )
  assert.throws(
    () => buildDisplacementPixels({ width: Number.NaN, height: 4, radius: 2 }),
    /invalid displacement map size/
  )
})

test('fractional layout sizes are rasterized rather than rejected', () => {
  // Measured geometry comes from getBoundingClientRect, which is fractional at
  // most zoom levels; rejecting it would leave the surface unfiltered.
  const raster = buildDisplacementPixels({ width: 24.6, height: 16.2, radius: 5.4 })
  assert.equal(raster.width, 25)
  assert.equal(raster.height, 16)
})

test('nominal geometries match the shipped CSS so the first paint is already close', () => {
  // PlayerBar.css lays the bar out at 1180x72 with border-radius 22px.
  assert.equal(NOMINAL_PLAYBAR_GEOMETRY.width, 1180)
  assert.equal(NOMINAL_PLAYBAR_GEOMETRY.height, 72)
  assert.equal(NOMINAL_PLAYBAR_GEOMETRY.radius, 22)
  assert.ok(NOMINAL_CARD_GEOMETRY.width === NOMINAL_CARD_GEOMETRY.height, 'cards are near-square')
})

test('geometry keys collapse equivalent geometries and separate different ones', () => {
  assert.equal(
    geometryKey({ width: 100, height: 50, radius: 10 }),
    geometryKey({ width: 100.2, height: 49.8, radius: 10 }),
    'sub-pixel jitter reuses one raster'
  )
  assert.notEqual(
    geometryKey({ width: 100, height: 50, radius: 10 }),
    geometryKey({ width: 100, height: 50, radius: 20 }),
    'a different radius is a different map'
  )
})

test('geometryChanged tracks whether a re-rasterize is warranted', () => {
  const base: DisplacementGeometry = { width: 100, height: 50, radius: 10 }
  assert.equal(geometryChanged(base, { width: 100.3, height: 50, radius: 10 }), false)
  assert.equal(geometryChanged(base, { width: 100, height: 50, radius: 22 }), true)
  assert.equal(geometryChanged(null, null), false)
  assert.equal(geometryChanged(base, null), true)
})

test('map url generation degrades to empty string without a DOM', () => {
  clearDisplacementMapCache()
  // node test env has no document; callers are expected to skip the filter
  assert.equal(typeof globalThis.document, 'undefined')
  assert.equal(getDisplacementMapUrl(NOMINAL_CARD_GEOMETRY), '')
})

test('dense sampling registers the same optical field and bounds both axes and area', () => {
  const geometry = { width: 320, height: 200, radius: 18 }
  const base = resolveRasterGeometry(geometry)
  const dense = resolveRasterSampling(geometry, 2.5)
  assert.deepEqual(dense.shape, base.shape, 'density must not change optical radius')
  assert.equal(dense.width, 800)
  assert.equal(dense.height, 500)
  for (const dimensions of [
    [4000, 72],
    [4000, 4000],
    [72, 4000]
  ]) {
    const raster = resolveRasterSampling(
      { width: dimensions[0], height: dimensions[1], radius: 20 },
      100
    )
    assert.ok(raster.width <= MAX_GLASS_RASTER_AXIS && raster.height <= MAX_GLASS_RASTER_AXIS)
    assert.ok(raster.width * raster.height <= MAX_GLASS_RASTER_PIXELS)
  }
  assert.equal(rasterSamplingKey(geometry, 3), rasterSamplingKey(geometry, 100))
  assert.deepEqual(resolveRasterSampling(geometry, NaN), resolveRasterSampling(geometry))
})

test('displacement contour integrates coverage without premultiplied RGB loss', () => {
  const geometry = { width: 32, height: 32, radius: 8 }
  const raster = buildDisplacementPixels(geometry)
  const { shape, blurRadius } = resolveRasterGeometry(geometry)
  for (const [x, y] of [
    [0, 2],
    [1, 1],
    [2, 0]
  ]) {
    let referenceX = 0,
      referenceY = 0
    for (let sy = 0; sy < 64; sy++) {
      for (let sx = 0; sx < 64; sx++) {
        const sample = refractionOffset(
          x + (sx + 0.5) / 64 - 16,
          y + (sy + 0.5) / 64 - 16,
          shape,
          blurRadius
        )
        referenceX += sample.x / 4096
        referenceY += sample.y / 4096
      }
    }
    assert.ok(Math.abs(channelAt(raster, x, y, 0) - (referenceX * 0.5 + 0.5) * 255) < 5)
    assert.ok(Math.abs(channelAt(raster, x, y, 1) - (referenceY * 0.5 + 0.5) * 255) < 5)
    assert.equal(channelAt(raster, x, y, 3), 255)
  }
  const dense = buildDisplacementPixels(geometry, 2)
  assert.equal(dense.width, 64)
  assert.equal(channelAt(dense, 32, 32, 0), NEUTRAL_BYTE)
  for (let p = 3; p < dense.pixels.length; p += 4) assert.equal(dense.pixels[p], 255)
})
