import type { DspOutputStageStatus, DspResamplerQuality } from './dspGraph.ts'

const labels: Record<DspResamplerQuality, string> = {
  native: 'Native',
  high: 'High',
  ultra: 'Ultra',
  soxrHq: 'SoX HQ',
  soxrVhq: 'SoX VHQ'
}

export function describeResampler(
  requested: DspResamplerQuality,
  status?: DspOutputStageStatus | null
): string {
  const request = `请求 ${labels[requested]}`
  if (!status?.effectiveResampler || status.effectiveResampler === 'unknown')
    return `${request} · 实际 SRC 未验证`
  if (status.effectiveResampler === 'none' && status.resampled === false)
    return `${request} · 本引擎未重采样（设备或系统仍可能转换）`
  if (
    (status.effectiveResampler !== 'swr' && status.effectiveResampler !== 'soxr') ||
    status.resampled !== true ||
    !status.effectiveResamplerQuality
  )
    return `${request} · 实际 SRC 未验证`
  const actual = `${status.effectiveResampler === 'soxr' ? 'SoX' : 'SWR'} ${labels[status.effectiveResamplerQuality].replace('SoX ', '')}`
  const fallback = status.effectiveResamplerFallback === true ? '（SoX 不可用，已回退）' : ''
  return `${request} · 实际 ${actual}${fallback}`
}
