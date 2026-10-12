import assert from 'node:assert/strict'
import test from 'node:test'
import { glassRasterDensity, observeDevicePixelRatio } from './glassRasterDensity.ts'

test('glass density supersamples standard displays and bounds high DPI requests', () => {
  for (const ratio of [1, 1.25, 1.5, 2, NaN]) assert.equal(glassRasterDensity(ratio), 2)
  assert.equal(glassRasterDensity(2.5), 2.5)
  assert.equal(glassRasterDensity(4), 3)
})

test('DPI observation re-arms across monitors, ignores ordinary resize and releases listeners', () => {
  const events = new EventTarget()
  const queries: { media: string; events: EventTarget }[] = []
  const target = {
    devicePixelRatio: 1,
    matchMedia(media: string) {
      const queryEvents = new EventTarget()
      queries.push({ media, events: queryEvents })
      return queryEvents
    },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events)
  }
  let changes = 0
  const stop = observeDevicePixelRatio(() => changes++, target as unknown as Window)
  events.dispatchEvent(new Event('resize'))
  assert.equal(changes, 0)
  target.devicePixelRatio = 2.5
  queries[0].events.dispatchEvent(new Event('change'))
  assert.equal(changes, 1)
  assert.equal(queries[1].media, '(resolution: 2.5dppx)')
  events.dispatchEvent(new Event('resize'))
  assert.equal(changes, 1, 'media event and resize must not duplicate work')
  target.devicePixelRatio = 3
  queries[0].events.dispatchEvent(new Event('change'))
  assert.equal(changes, 1, 'old monitor query is detached')
  events.dispatchEvent(new Event('resize'))
  assert.equal(changes, 2, 'resize fallback handles the next monitor')
  stop()
  target.devicePixelRatio = 1
  events.dispatchEvent(new Event('resize'))
  queries.at(-1)?.events.dispatchEvent(new Event('change'))
  assert.equal(changes, 2, 'unmount stops both listeners')
})
