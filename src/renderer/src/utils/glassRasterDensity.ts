/** Supersample small surfaces on standard displays; respect denser displays. */
export function glassRasterDensity(devicePixelRatio: number): number {
  return Number.isFinite(devicePixelRatio) ? Math.max(2, Math.min(3, devicePixelRatio)) : 2
}

/** DPI can change between monitors without changing an element's CSS dimensions. */
export function observeDevicePixelRatio(
  onChange: () => void,
  target: Pick<
    Window,
    'devicePixelRatio' | 'matchMedia' | 'addEventListener' | 'removeEventListener'
  >
): () => void {
  let ratio = target.devicePixelRatio
  let query: MediaQueryList | null = null
  const arm = (): void => {
    query?.removeEventListener('change', check)
    query = target.matchMedia(`(resolution: ${ratio}dppx)`)
    query.addEventListener('change', check)
  }
  const check = (): void => {
    if (ratio === target.devicePixelRatio) return
    ratio = target.devicePixelRatio
    arm()
    onChange()
  }
  arm()
  target.addEventListener('resize', check)
  return () => {
    query?.removeEventListener('change', check)
    target.removeEventListener('resize', check)
  }
}
