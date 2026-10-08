/** Convert mouse detents and small trackpad deltas into whole percentage steps. */
export function createVolumeWheelStepper(): (event: WheelEvent) => number {
  let remainder = 0
  let lastTime = -Infinity

  return (event) => {
    // Ctrl-wheel is a trackpad pinch gesture, not a volume adjustment.
    if (event.ctrlKey) return 0
    const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX
    if (!Number.isFinite(delta) || delta === 0) return 0

    if (event.timeStamp - lastTime > 180 || Math.sign(delta) !== Math.sign(remainder)) {
      remainder = 0
    }
    lastTime = event.timeStamp

    if (event.deltaMode !== 0 || Math.abs(delta) >= 40) {
      remainder = 0
      const unit = event.deltaMode === 1 ? 3 : event.deltaMode === 2 ? 1 : 100
      return -Math.sign(delta) * Math.max(1, Math.round(Math.abs(delta) / unit))
    }

    remainder += delta
    const steps = Math.trunc(remainder / 12)
    remainder -= steps * 12
    return steps === 0 ? 0 : -steps
  }
}

export function clampVolumePercent(value: number, maximum = 100): number {
  return Math.min(maximum, Math.max(0, Math.round(value)))
}
