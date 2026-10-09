export interface AutoMixConfig {
  enabled: boolean
  allowIntelligentSkip: boolean
  maxTransitionSeconds: number
}

export const DEFAULT_AUTO_MIX: Readonly<AutoMixConfig> = Object.freeze({
  enabled: false,
  allowIntelligentSkip: true,
  maxTransitionSeconds: 12
})

export function autoMixReasonText(reason: string): string {
  const copy: Record<string, string> = {
    analysis_pending: '等待音频准备',
    preparing: '正在后台准备转场',
    queue_changed: '等待当前队列的下一首音频',
    dsp_config_changed: 'DSP 已更新，正在重新准备转场',
    stopped: '播放停止，等待开始播放',
    feature_identity_mismatch: '分析时长与音源不一致，使用保守淡化',
    analysis_unavailable_conservative_crossfade: '分析未就绪，使用保守淡化',
    insufficient_confident_regions: '没有确认合适的节拍区域，使用保守淡化',
    intelligent_prepare_failed_conservative: '智能转场准备失败，使用已就绪的保守淡化',
    intelligent_prepare_late_conservative: '智能转场准备未及时完成，使用已就绪的保守淡化',
    independent_confident_beat_regions: '已确认适合衔接的节拍区域',
    dsp_order_incompatible: '当前 DSP 图无法保持双轨处理顺序',
    album_boundary: '保留专辑连续播放边界',
    cue_boundary: '保留 CUE 分段边界',
    repeat_or_cue_boundary: '当前重复播放或分段边界暂停 AutoMix',
    ab_loop: 'A–B 循环期间暂停 AutoMix',
    short_track: '短曲保留完整内容',
    unsupported_format: '当前格式不支持智能转场',
    user_playback_rate: '自定义播放速度期间暂停 AutoMix',
    preparation_deadline_missed: '音频准备未及时完成，保留正常衔接',
    source_not_seekable_or_expired: '音源暂时无法定位，保留正常衔接',
    transition_resource_limit: '准备资源已达上限，保留正常衔接',
    retirement_resource_limit: '旧转场资源正在回收，保留已就绪方案或正常衔接',
    transition_prepare_failed: '音频转场准备失败，保留正常衔接',
    known_duration_required: '时长未知，保留正常播放'
  }
  return copy[reason] ?? ''
}

export function normalizeAutoMix(value: Partial<AutoMixConfig> | undefined): AutoMixConfig {
  return {
    enabled: value?.enabled === true,
    allowIntelligentSkip: value?.allowIntelligentSkip !== false,
    maxTransitionSeconds:
      typeof value?.maxTransitionSeconds === 'number' && Number.isFinite(value.maxTransitionSeconds)
        ? Math.min(12, Math.max(0.3, value.maxTransitionSeconds))
        : 12
  }
}

export interface AutoMixStatus {
  enabled: boolean
  state: 'disabled' | 'preparing' | 'ready' | 'mixing' | 'degraded'
  progress: number
  transitionSeconds: number
  styleId: number | null
  reason: string
  configRevision: number
  pairRevision?: number
  featuresDelivered?: boolean
  experimentalAllowed?: boolean
  stableRelease?: boolean
  intelligentSkipSupported?: boolean
}

export const AUTO_MIX_MODEL_HASHES = Object.freeze({
  beatThis: '10b8a43f58ec08dec4cf3c0df3ae4c62b8c51b4d96449c318af7f2aa76dc574f',
  yamnet: '564a1406a3173634aedc049863403e581c1fabf2b0e2c22515d924d3ffb160e5'
})
export const AUTO_MIX_ANALYSIS_VERSION = 3 as const

export interface AutoMixWindow {
  sourceStart: number
  sourceEnd: number
  energyDbfs: number[]
  energyHopSeconds: 0.02
  beatKnown: boolean
  beats: number[] | null
  downbeats: number[] | null
  stableRegions: { start: number; end: number; bpm: number; confidence: number }[] | null
  vocalKnown: boolean
  vocalWindows: { start: number; end: number; probability: number }[] | null
  key: null // Key estimator has not passed its validation gate.
  phraseBoundaries: null
  beatReason?: string
  vocalReason?: string
}

export interface AutoMixFeatures {
  schemaVersion: 1
  analysisVersion: typeof AUTO_MIX_ANALYSIS_VERSION
  available: true
  provenance: 'independent-beat-this-yamnet-v1'
  durationSeconds: number
  modelHashes: typeof AUTO_MIX_MODEL_HASHES
  windows: { head?: AutoMixWindow; tail?: AutoMixWindow }
}

export type AutoMixAnalysisResult =
  | AutoMixFeatures
  | {
      schemaVersion: 1
      analysisVersion: typeof AUTO_MIX_ANALYSIS_VERSION
      available: false
      reason: string
    }

const record = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const probability = (x: unknown): x is number => finite(x) && x >= 0 && x <= 1

function isWindow(value: unknown, duration: number): value is AutoMixWindow {
  if (!record(value) || !finite(value.sourceStart) || !finite(value.sourceEnd)) return false
  const { sourceStart: start, sourceEnd: end } = value
  if (start < 0 || end <= start || end > duration + 0.1 || end - start > 45.1) return false
  if (
    value.energyHopSeconds !== 0.02 ||
    !Array.isArray(value.energyDbfs) ||
    value.energyDbfs.length > 2251 ||
    !value.energyDbfs.every((x) => finite(x) && x >= -120 && x <= 120)
  )
    return false
  if (value.key !== null || value.phraseBoundaries !== null) return false
  if (typeof value.beatKnown !== 'boolean' || typeof value.vocalKnown !== 'boolean') return false
  const times = (x: unknown): x is number[] =>
    Array.isArray(x) &&
    x.length <= 2251 &&
    x.every((t, i) => finite(t) && t >= start && t <= end + 0.02 && (i === 0 || t > x[i - 1]))
  const regions = (x: unknown, key: 'confidence' | 'probability'): boolean =>
    Array.isArray(x) &&
    x.length <= 96 &&
    x.every(
      (r) =>
        record(r) &&
        finite(r.start) &&
        finite(r.end) &&
        r.start >= start &&
        r.end >= r.start &&
        r.end <= end + 0.1 &&
        probability(r[key]) &&
        (key !== 'confidence' || (finite(r.bpm) && r.bpm >= 40 && r.bpm <= 300))
    )
  if (
    value.beatKnown
      ? !times(value.beats) ||
        !times(value.downbeats) ||
        !regions(value.stableRegions, 'confidence')
      : value.beats !== null || value.downbeats !== null || value.stableRegions !== null
  )
    return false
  if (value.vocalKnown ? !regions(value.vocalWindows, 'probability') : value.vocalWindows !== null)
    return false
  return [value.beatReason, value.vocalReason].every(
    (reason) => reason === undefined || (typeof reason === 'string' && reason.length <= 2048)
  )
}

export function isAutoMixAnalysisResult(value: unknown): value is AutoMixAnalysisResult {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    value.analysisVersion !== AUTO_MIX_ANALYSIS_VERSION
  )
    return false
  if (value.available === false)
    return typeof value.reason === 'string' && value.reason.length <= 2048
  if (
    value.available !== true ||
    value.provenance !== 'independent-beat-this-yamnet-v1' ||
    !finite(value.durationSeconds) ||
    value.durationSeconds <= 0 ||
    !record(value.modelHashes) ||
    value.modelHashes.beatThis !== AUTO_MIX_MODEL_HASHES.beatThis ||
    value.modelHashes.yamnet !== AUTO_MIX_MODEL_HASHES.yamnet ||
    !record(value.windows)
  )
    return false
  const windows = value.windows
  const keys = Object.keys(windows)
  return (
    keys.length >= 1 &&
    keys.length <= 2 &&
    keys.every(
      (key) =>
        (key === 'head' || key === 'tail') &&
        isWindow(windows[key], value.durationSeconds as number)
    )
  )
}
