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

  function draw(): void {
    const path = displayed.length > 1 ? spectrumPath(displayed, range.value) : ''
    lineRef.value?.setAttribute('d', path)
    fillRef.value?.setAttribute('d', path ? `${path} L100,100 L0,100 Z` : '')
    peakRef.value?.setAttribute(
      'd',
      peakHold.value && peaks.length > 1 ? spectrumPath(peaks, range.value) : ''
    )
  }

  function stop(): void {
    if (frame) window.cancelAnimationFrame(frame)
    frame = 0
    lastTime = 0
  }

  function animate(now: number): void {
    frame = 0
    const target = source.levels()
    if (!source.visible() || source.frozen() || !target) return
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
    if (!source.visible()) {
      stop()
      displayed = new Float32Array(0)
      peaks = new Float32Array(0)
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
    const motion = document.documentElement.dataset.teMotion
    if (motion === 'reduced' || motion === 'off') {
      stop()
      displayed.set(target)
      draw()
      return
    }
    draw()
    if (!frame) frame = window.requestAnimationFrame(animate)
  }

  function resetPeaks(): void {
    peaks = displayed.slice()
    draw()
  }

  watch([source.levels, source.visible, source.frozen], update)
  watch(peakHold, resetPeaks)
  watch(range, draw)
  onMounted(update)
  onBeforeUnmount(stop)
  return { lineRef, fillRef, peakRef, peakHold, range, speed, resetPeaks }
}
