import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { accumulateSpectrumPeak, smoothSpectrum, spectrumPath } from '@renderer/utils/eqSpectrum'
import type { SpectrumRange, SpectrumSpeed } from '@renderer/utils/eqSpectrum'

export function useEqSpectrum(source: {
  levels: () => Float32Array | null
  visible: () => boolean
  frozen: () => boolean
}) {
  const lineRef = ref<SVGPathElement | null>(null)
  const fillRef = ref<SVGPathElement | null>(null)
  const peakRef = ref<SVGPathElement | null>(null)
  const peakHold = ref(false)
  const range = ref<SpectrumRange>(100)
  const speed = ref<SpectrumSpeed>('medium')
  let displayed = new Float32Array(0)
  let peaks = new Float32Array(0)
  let frame = 0
  let lastTime = 0
  let peakPath = ''
  let motionObserver: MutationObserver | null = null
  const paths = new WeakMap<SVGPathElement, string>()

  function writePath(element: SVGPathElement | null, path: string): void {
    if (!element || paths.get(element) === path) return
    element.setAttribute('d', path)
    paths.set(element, path)
  }

  function updatePeakPath(): void {
    peakPath = peakHold.value && peaks.length > 1 ? spectrumPath(peaks, range.value) : ''
  }

  function draw(): void {
    const path = displayed.length > 1 ? spectrumPath(displayed, range.value) : ''
    writePath(lineRef.value, path)
    writePath(fillRef.value, path ? `${path} L100,100 L0,100 Z` : '')
    writePath(peakRef.value, peakPath)
  }

  function stop(): void {
    if (frame) window.cancelAnimationFrame(frame)
    frame = 0
    lastTime = 0
  }

  function animate(now: number): void {
    frame = 0
    const target = source.levels()
    if (document.hidden || !source.visible() || source.frozen() || !target) return
    const motion = document.documentElement.dataset.teMotion
    if (motion === 'reduced' || motion === 'off') {
      displayed.set(target)
      draw()
      lastTime = 0
      return
    }
    const moving = smoothSpectrum(displayed, target, lastTime ? now - lastTime : 16.7, speed.value)
    lastTime = now
    draw()
    if (moving) frame = window.requestAnimationFrame(animate)
    else lastTime = 0
  }

  function update(): void {
    if (document.hidden) {
      stop()
      return
    }
    if (!source.visible()) {
      stop()
      displayed = new Float32Array(0)
      peaks = new Float32Array(0)
      updatePeakPath()
      draw()
      return
    }
    if (source.frozen()) {
      stop()
      draw()
      return
    }
    const target = source.levels()
    if (!target || target.length < 2) {
      stop()
      displayed = new Float32Array(0)
      draw()
      return
    }
    if (displayed.length !== target.length) displayed = target.slice()
    if (peaks.length !== target.length) peaks = target.slice()
    if (peakHold.value) accumulateSpectrumPeak(peaks, target)
    updatePeakPath()
    const motion = document.documentElement.dataset.teMotion
    if (motion === 'reduced' || motion === 'off') {
      stop()
      displayed.set(target)
      draw()
      return
    }
    if (!frame) frame = window.requestAnimationFrame(animate)
  }

  function resetPeaks(): void {
    peaks = displayed.slice()
    updatePeakPath()
    draw()
  }

  function onVisibilityChange(): void {
    if (document.hidden) {
      stop()
      return
    }
    if (!source.frozen()) displayed = source.levels()?.slice() ?? new Float32Array(0)
    update()
    draw()
  }

  watch([source.levels, source.visible, source.frozen], update)
  watch(peakHold, resetPeaks)
  watch(range, () => {
    updatePeakPath()
    draw()
  })
  onMounted(() => {
    document.addEventListener('visibilitychange', onVisibilityChange)
    motionObserver = new MutationObserver(update)
    motionObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-te-motion']
    })
    update()
    draw()
  })
  onBeforeUnmount(() => {
    stop()
    document.removeEventListener('visibilitychange', onVisibilityChange)
    motionObserver?.disconnect()
  })
  return { lineRef, fillRef, peakRef, peakHold, range, speed, resetPeaks }
}
