<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useAudioOutputDspStore } from '@renderer/stores/useAudioOutputDspStore'
import { usePlayerStore } from '@renderer/stores/usePlayerStore'
import { type DspWorkspaceTab } from '@renderer/utils/dspWorkbench'
import { dspSampleRate, dspSignalNodes } from '@renderer/utils/dspSignalOverview'
import { dspNodeCategory, nodeLabel } from '@renderer/utils/dspNodeParams'
import { describeResampler } from '../../../../shared/resamplerStatus.ts'
import {
  DEFAULT_DSP_STEREO_IMAGE,
  extractStereoImageFromGraph,
  type DspGraphStatus,
  type DspSceneState,
  type DspStereoImageConfig
} from '../../../../shared/dspGraph.ts'
import aacLogoUrl from '@renderer/assets/images/audio-logos/aac.png'
import appleLogoUrl from '@renderer/assets/images/audio-logos/apple-coreaudio.png'
import asioLogoUrl from '@renderer/assets/images/audio-logos/asio.png'
import coreAudioLogoUrl from '@renderer/assets/images/audio-logos/coreaudio.png'
import dolbyAtmosLogoUrl from '@renderer/assets/images/audio-logos/dolby-atmos.png'
import dolbyDigitalLogoUrl from '@renderer/assets/images/audio-logos/dolby-digital.png'
import dsdLogoUrl from '@renderer/assets/images/audio-logos/dsd.png'
import ffmpegDarkLogoUrl from '@renderer/assets/images/audio-logos/ffmpeg-logo-dark.png'
import ffmpegLogoUrl from '@renderer/assets/images/audio-logos/ffmpeg-logo.png'
import flacLightLogoUrl from '@renderer/assets/images/audio-logos/flac-light-bg.png'
import flacDarkLogoUrl from '@renderer/assets/images/audio-logos/flac-transparent.png'
import mp3LogoUrl from '@renderer/assets/images/audio-logos/mp3.png'
import oggVorbisLogoUrl from '@renderer/assets/images/audio-logos/ogg-vorbis.png'
import opusLogoUrl from '@renderer/assets/images/audio-logos/opus.png'
import pipewireDarkLogoUrl from '@renderer/assets/images/audio-logos/pipewire-dark.png'
import pipewireLogoUrl from '@renderer/assets/images/audio-logos/pipewire.png'
import pulseAudioLogoUrl from '@renderer/assets/images/audio-logos/pulseaudio.png'
import sacdLogoUrl from '@renderer/assets/images/audio-logos/sacd.png'
import steinbergLogoUrl from '@renderer/assets/images/audio-logos/steinberg.png'
import twilightEchoLogoUrl from '@renderer/assets/images/audio-logos/twilight-echo.png'
import wavpackLogoUrl from '@renderer/assets/images/audio-logos/wavpack.png'
import windowsWasapiLogoUrl from '@renderer/assets/images/audio-logos/windows-wasapi.png'

const props = defineProps<{
  status: DspGraphStatus | null
  sceneState: DspSceneState | null
  sceneName: string
  disabled: boolean
}>()
const emit = defineEmits<{ node: [id: string]; output: []; navigate: [tab: DspWorkspaceTab] }>()
const outputStore = useAudioOutputDspStore()
const {
  audioProcessing,
  outputInfo,
  playbackInfo,
  audioOutputConfig,
  audioEngineReady,
  audioOutput,
  audioOutputOptions,
  audioDevice,
  audioDeviceOptions,
  exclusiveMode,
  dspOutputStage,
  dspStereoImage,
  dspGraphStatus,
  loudnormStatus
} = storeToRefs(outputStore)
const playerStore = usePlayerStore()
const { isPlaying } = playerStore
const currentTrack = computed(() => playerStore.currentTrack?.value ?? null)

const effectiveStatus = computed(() => props.status ?? dspGraphStatus?.value ?? null)
const bypassed = computed(
  () =>
    !audioProcessing.value.dspEnabled ||
    audioProcessing.value.directMode ||
    !!props.sceneState?.effectiveBypassReason
)
const nodes = computed(() => dspSignalNodes(props.sceneState, effectiveStatus.value, bypassed.value))
const activeGraphNodes = computed(() => {
  const graph = props.sceneState?.effectiveGraph ?? props.sceneState?.graph
  return new Map((graph?.nodes ?? []).map((node) => [node.id, node]))
})
const runtimeNodesMap = computed(
  () => new Map((effectiveStatus.value?.nodes ?? []).map((node) => [node.id, node]))
)
const activeNodeCount = computed(() => nodes.value.filter((node) => node.active).length)
const chainExpanded = ref(false)
const flowing = computed(() => audioEngineReady.value && isPlaying.value)

const selectedDevice = computed(
  () =>
    audioDeviceOptions.value?.find((device) => device.id === audioDevice.value) ??
    audioDeviceOptions.value?.[0] ??
    null
)

const rate = computed(() => {
  const outStage =
    effectiveStatus.value?.outputStage ??
    props.sceneState?.effectiveGraph?.outputStage ??
    props.sceneState?.graph?.outputStage ??
    dspOutputStage?.value
  return (
    outputInfo.value?.actualSampleRate ||
    outputInfo.value?.outputSampleRate ||
    effectiveStatus.value?.outputStage?.actualSampleRate ||
    (typeof outStage?.targetSampleRate === 'number' ? outStage.targetSampleRate : 0) ||
    playbackInfo.value?.actualSampleRate ||
    playbackInfo.value?.outputSampleRate ||
    selectedDevice.value?.sampleRates?.[0] ||
    currentTrack.value?.sampleRate ||
    48000
  )
})

const sourceRate = computed(() => {
  const info = playbackInfo.value
  const track = currentTrack.value
  return (
    info?.sourceSampleRate ||
    info?.decodedSampleRate ||
    track?.sampleRate ||
    rate.value
  )
})

const sourceBits = computed(() => {
  const info = playbackInfo.value
  const track = currentTrack.value
  return (
    info?.sourceBitDepth ||
    info?.decodedBitDepth ||
    track?.bitDepth ||
    outputInfo.value?.actualBitDepth ||
    24
  )
})

const sourceChannels = computed(() => {
  const info = playbackInfo.value
  return (
    info?.sourceChannels ||
    info?.decodedChannels ||
    outputInfo.value?.actualChannels ||
    2
  )
})

const sourceBitrate = computed(() => {
  const br = playbackInfo.value?.bitrate || currentTrack.value?.bitrate || 0
  return br > 0 ? Math.round(br) : 0
})

const sourceCodec = computed(() => {
  const info = playbackInfo.value
  const rawCodec = info?.codec?.trim()
  if (rawCodec && rawCodec !== '未知' && rawCodec.toLowerCase() !== 'unknown') {
    return rawCodec.toUpperCase()
  }
  const trackFormat = currentTrack.value?.format?.trim()
  if (trackFormat && trackFormat !== '未知' && trackFormat.toLowerCase() !== 'unknown') {
    return trackFormat.toUpperCase()
  }
  if (outputInfo.value?.isDsd || info?.isDsd) {
    const mode = outputInfo.value?.dsdMode || info?.dsdMode
    return mode === 'native' ? 'DSD Native' : mode === 'dop' ? 'DSD DoP' : 'DSD'
  }
  return rawCodec || 'PCM'
})

const sourceCodecBadge = computed(() => {
  const raw = sourceCodec.value.split(/\s+/)[0] || 'PCM'
  return raw.slice(0, 4).toUpperCase()
})

interface EmblemLogoSpec {
  light: string
  dark?: string
  monoInk?: boolean
  alt: string
}

const codecEmblemLogo = computed<EmblemLogoSpec | null>(() => {
  const c = sourceCodec.value.toUpperCase()
  if (c.includes('SACD')) {
    return { light: sacdLogoUrl, monoInk: true, alt: 'SACD' }
  }
  if (c.includes('DSD') || c.includes('DSF') || c.includes('DFF')) {
    return { light: dsdLogoUrl, monoInk: true, alt: 'DSD' }
  }
  if (c.includes('FLAC')) {
    return { light: flacLightLogoUrl, dark: flacDarkLogoUrl, alt: 'FLAC' }
  }
  if (c.includes('MP3') || c.includes('MPEG')) {
    return { light: mp3LogoUrl, monoInk: true, alt: 'MP3' }
  }
  if (c.includes('ALAC') || c.includes('APPLE')) {
    return { light: appleLogoUrl, monoInk: true, alt: 'ALAC' }
  }
  if (c.includes('AAC') || c.includes('M4A')) {
    return { light: aacLogoUrl, alt: 'AAC' }
  }
  if (c.includes('OPUS')) {
    return { light: opusLogoUrl, monoInk: true, alt: 'Opus' }
  }
  if (c.includes('OGG') || c.includes('VORBIS')) {
    return { light: oggVorbisLogoUrl, alt: 'Ogg Vorbis' }
  }
  if (c.includes('WAVPACK') || c === 'WV') {
    return { light: wavpackLogoUrl, monoInk: true, alt: 'WavPack' }
  }
  if (c.includes('ATMOS')) {
    return { light: dolbyAtmosLogoUrl, monoInk: true, alt: 'Dolby Atmos' }
  }
  if (c.includes('DOLBY') || c.includes('AC3') || c.includes('EAC3')) {
    return { light: dolbyDigitalLogoUrl, monoInk: true, alt: 'Dolby Digital' }
  }
  return null
})

const decoderEmblemLogo = computed<EmblemLogoSpec>(() => {
  if (outputInfo.value?.isDsd || playbackInfo.value?.isDsd) {
    return { light: dsdLogoUrl, monoInk: true, alt: 'DSD Decoder' }
  }
  return { light: ffmpegLogoUrl, dark: ffmpegDarkLogoUrl, alt: 'FFmpeg Decoder' }
})

const resamplerBadge = computed(() => {
  const out =
    effectiveStatus.value?.outputStage ??
    props.sceneState?.effectiveGraph?.outputStage ??
    props.sceneState?.graph?.outputStage ??
    dspOutputStage?.value
  const q = out?.resamplerQuality ?? 'native'
  if (q === 'soxrHq' || q === 'soxrVhq') return 'SoXR'
  return 'SwR'
})

const dspEmblemLogo = computed<EmblemLogoSpec>(() => {
  return { light: twilightEchoLogoUrl, alt: 'Twilight Echo DSP' }
})

const trackSpecLine = computed(() => {
  const parts = [sourceCodec.value, `${sourceBits.value} bit`, dspSampleRate(sourceRate.value)]
  if (sourceBitrate.value > 0) parts.push(`${sourceBitrate.value} kbps`)
  return parts.join(' ')
})

const decoderLabel = computed(() => {
  if (outputInfo.value?.isDsd || playbackInfo.value?.isDsd) {
    const mode = outputInfo.value?.dsdMode || playbackInfo.value?.dsdMode
    return mode === 'native'
      ? 'Twilight DSD Native Direct'
      : mode === 'dop'
        ? 'Twilight DSD-over-PCM'
        : 'Twilight DSD64/128 Decoder'
  }
  return 'Twilight 64-bit FFmpeg Decoder'
})

const resamplerHeadline = computed(() => {
  const out =
    effectiveStatus.value?.outputStage ??
    props.sceneState?.effectiveGraph?.outputStage ??
    props.sceneState?.graph?.outputStage ??
    dspOutputStage?.value
  if (!out) return 'Bit-Perfect 原生时钟直通'
  return describeResampler(out.resamplerQuality ?? 'native', effectiveStatus.value?.outputStage)
})

const resamplerPrecisionText = computed(() => {
  const out =
    effectiveStatus.value?.outputStage ??
    props.sceneState?.effectiveGraph?.outputStage ??
    props.sceneState?.graph?.outputStage ??
    dspOutputStage?.value
  const q = out?.resamplerQuality ?? 'native'
  if (sourceRate.value === rate.value && !effectiveStatus.value?.outputStage?.resampled) {
    return '零重采样损耗 · 采样率 1:1 锁定'
  }
  if (q === 'soxrVhq' || q === 'soxrHq') return '截断: 99.2% · 线性相位抗混叠'
  return '截断: 97.0% · 64-bit 浮点插值'
})

const outputName = computed(
  () =>
    outputInfo.value?.actualDeviceName ||
    selectedDevice.value?.label ||
    '系统默认音频输出'
)

const outputBackendLabel = computed(() => {
  const raw =
    outputInfo.value?.actualBackend ||
    outputInfo.value?.backend ||
    audioOutputOptions.value?.find((opt) => opt.id === audioOutput.value)?.label ||
    audioOutput.value ||
    'WASAPI'
  return raw.toUpperCase()
})

const outputEmblemLogo = computed<EmblemLogoSpec>(() => {
  const b = outputBackendLabel.value
  if (b.includes('ASIO')) {
    return { light: asioLogoUrl, alt: 'ASIO' }
  }
  if (b.includes('CORE')) {
    return { light: coreAudioLogoUrl, alt: 'Core Audio' }
  }
  if (b.includes('PIPEWIRE')) {
    return { light: pipewireLogoUrl, dark: pipewireDarkLogoUrl, alt: 'PipeWire' }
  }
  if (b.includes('PULSE')) {
    return { light: pulseAudioLogoUrl, alt: 'PulseAudio' }
  }
  return { light: windowsWasapiLogoUrl, alt: 'Windows WASAPI' }
})

const deviceEmblemLogo = computed<EmblemLogoSpec | null>(() => {
  const name = outputName.value.toUpperCase()
  if (name.includes('STEINBERG') || name.includes('YAMAHA') || name.includes('ASIO')) {
    return { light: steinbergLogoUrl, alt: 'Steinberg' }
  }
  if (name.includes('APPLE') || name.includes('AIRPODS') || name.includes('MACBOOK')) {
    return { light: appleLogoUrl, monoInk: true, alt: 'Apple Audio' }
  }
  if (name.includes('DOLBY') || name.includes('ATMOS')) {
    return { light: dolbyAtmosLogoUrl, monoInk: true, alt: 'Dolby Atmos' }
  }
  return null
})

const isExclusive = computed(() => !!(outputInfo.value?.exclusive ?? exclusiveMode?.value))

const buffer = computed(
  () =>
    outputInfo.value?.bufferSizeFrames ||
    playbackInfo.value?.bufferSizeFrames ||
    selectedDevice.value?.preferredBufferSize ||
    0
)
const requestedBuffer = computed(() => audioOutputConfig.value?.preferredBufferSize || 0)
const effectiveBuffer = computed(() => buffer.value || requestedBuffer.value || 512)
const bufferDurationMs = computed(() => {
  const frames = effectiveBuffer.value
  const sr = rate.value
  if (!frames || frames <= 0 || !sr || sr <= 0) return '10.7'
  return ((frames / sr) * 1000).toFixed(1)
})

const effectiveLatencyMs = computed(() => {
  const direct =
    outputInfo.value?.latencyMs ||
    outputInfo.value?.latencyInfo?.totalLatencyMs ||
    outputInfo.value?.latencyInfo?.outputLatencyMs ||
    outputInfo.value?.latencyInfo?.bufferLatencyMs ||
    playbackInfo.value?.latencyMs ||
    playbackInfo.value?.latencyInfo?.totalLatencyMs ||
    0
  if (direct > 0) return direct
  if (effectiveBuffer.value > 0 && rate.value > 0) {
    return (effectiveBuffer.value / rate.value) * 1000
  }
  return 0
})

const processMs = computed(() =>
  (effectiveStatus.value
    ? effectiveStatus.value.nodes.reduce((sum, node) => sum + (node.lastProcessMs || 0), 0)
    : 0
  ).toFixed(2)
)

const stereoImage = computed<DspStereoImageConfig>(() => {
  if (dspStereoImage?.value) return dspStereoImage.value
  const graph = props.sceneState?.effectiveGraph ?? props.sceneState?.graph
  return graph ? extractStereoImageFromGraph(graph) : DEFAULT_DSP_STEREO_IMAGE
})

const eqModeLabel = computed(() => {
  const proc = audioProcessing.value
  if (!proc.dspEnabled || proc.directMode) return '直通旁路'
  if (!proc.eqEnabled) return '已旁路'
  return proc.eqMode === 'parametric' ? '参数均衡器' : '图形均衡器'
})

const eqSpecLine = computed(() => {
  const proc = audioProcessing.value
  const count =
    proc.eqMode === 'parametric'
      ? (proc.eqBands?.filter((b) => b.enabled !== false).length ?? proc.eqBands?.length ?? 10)
      : (proc.eqBands?.length ?? 10)
  return `${count} 段 (31 Hz – 16K, Q: 1.41)`
})

const eqLimiterBalanceLine = computed(() => {
  const proc = audioProcessing.value
  const st = stereoImage.value
  const balPct = Math.round(Number(st.balance ?? 0) * 100)
  const balText = balPct === 0 ? '0%' : balPct > 0 ? `R+${balPct}%` : `L${balPct}%`
  const limText = proc.clipGuard !== false ? '限制器' : '无限制器'
  return `${limText}, 平衡 (${balText})`
})

const spatialToneLines = computed(() => {
  const proc = audioProcessing.value
  const st = stereoImage.value
  const widthPct = Math.round(Number(st.width ?? 1) * 100)
  const rawXf = Number(proc.crossfeedStrength ?? 0)
  const xfPct = proc.crossfeedEnabled ? Math.round(rawXf <= 1 ? rawXf * 100 : rawXf) : 0
  const xfCutoff = Number(proc.crossfeedCutoffHz ?? 700)
  return {
    line1: st.mono ? '声场 单声道 Mono (100%)' : `声场宽度 ${widthPct}%, 相位正常`,
    line2: `交叉馈送 ${xfCutoff} Hz, 强度 (${xfPct}%)`
  }
})

const gainValueText = computed(() => {
  const proc = audioProcessing.value
  const total = Number(proc.eqPreamp ?? 0) + Number(proc.replayGainPreamp ?? 0)
  return `${total >= 0 ? `+${total.toFixed(1)}` : total.toFixed(1)} dB`
})

const volumeControlText = computed(() => {
  const proc = audioProcessing.value
  const norm = proc.volumeNormalization ?? 'off'
  if (proc.directMode) return 'Direct 硬件直通音频控制'
  if (norm === 'loudnorm') {
    const status = loudnormStatus?.value as unknown
    const g =
      status && typeof status === 'object' && 'gainDb' in status
        ? Number((status as { gainDb?: number }).gainDb)
        : null
    return `R128 响度归一${g != null && Number.isFinite(g) ? ` (${g >= 0 ? '+' : ''}${g.toFixed(1)} dB)` : ''}`
  }
  if (norm === 'album') return 'ReplayGain 专辑增益控制'
  if (norm === 'track') return 'ReplayGain 单曲增益控制'
  return '无直接音频控制 (64-bit)'
})

const crossfadeText = computed(() => {
  const proc = audioProcessing.value
  const seconds = Number(proc.crossfadeSeconds ?? 0)
  if (seconds > 0) {
    return `平滑交叉淡入淡出 (${seconds.toFixed(1)} s)`
  }
  return proc.gapless !== false ? '无淡入淡出 / 无间隙紧密衔接' : '无淡入淡出 / 短时交叉渐隐'
})

const outputBitTransition = computed(() => {
  const outBits = outputInfo.value?.actualBitDepth || playbackInfo.value?.decodedBitDepth || 24
  return `32 bit → ${outBits} bit`
})

const outputFlagsText = computed(() => {
  const outCfg =
    props.sceneState?.effectiveGraph?.outputStage ??
    props.sceneState?.graph?.outputStage ??
    dspOutputStage?.value
  const clamp = outCfg?.safetyClamp !== false ? 'SAFETY_CLAMP' : 'NO_HEADROOM_GAIN'
  const mode = isExclusive.value ? '0x400020 EXCLUSIVE' : '0x000010 SHARED_MIX'
  return `${mode} · ${clamp}`
})

function getNodeDetail(id: string): string {
  const graphNode = activeGraphNodes.value.get(id)
  if (!graphNode) return ''
  const p = (graphNode.params ?? {}) as Record<string, unknown>
  const rt = runtimeNodesMap.value.get(id)
  const loadSuffix =
    rt && typeof rt.lastProcessMs === 'number' && rt.lastProcessMs > 0
      ? ` · ${rt.lastProcessMs.toFixed(2)} ms`
      : ''
  switch (graphNode.type) {
    case 'equalizer': {
      const bands = Array.isArray(p.bands)
        ? p.bands.filter((b: { enabled?: boolean }) => b?.enabled !== false).length
        : 0
      const pre = Number(p.preampDb ?? 0)
      return `${bands} 段 · ${pre >= 0 ? `+${pre.toFixed(1)}` : pre.toFixed(1)} dB${loadSuffix}`
    }
    case 'replayGain': {
      const gain = Number(p.gainDb ?? p.preampDb ?? 0)
      return `增益 ${gain >= 0 ? `+${gain.toFixed(1)}` : gain.toFixed(1)} dB${loadSuffix}`
    }
    case 'compressor':
      return `阈值 ${Number(p.thresholdDb ?? -18).toFixed(0)} dB · ${Number(p.ratio ?? 2).toFixed(1)}:1${loadSuffix}`
    case 'truePeakLimiter':
      return `上限 ${Number(p.ceilingDb ?? -0.3).toFixed(1)} dB${loadSuffix}`
    case 'crossfeed':
      return `${Number(p.cutoffHz ?? 700)} Hz · ${Number(p.feedDb ?? -6).toFixed(1)} dB${loadSuffix}`
    case 'stereoField':
      return `宽度 ${Math.round(Number(p.width ?? 1) * 100)}%${loadSuffix}`
    case 'convolver':
      return `湿声 ${Math.round(Number(p.wet ?? 1) * 100)}%${loadSuffix}`
    default:
      return `${dspNodeCategory(graphNode.type)}${loadSuffix}`
  }
}
</script>

<template>
  <section
    class="signal-overview"
    :class="{ 'is-bypassed': bypassed, 'is-flowing': flowing, 'is-offline': !audioEngineReady }"
    aria-label="实时音频链路"
  >
    <ol class="pipeline-timeline" aria-label="音频信号处理流水线">
      <!-- 01 · 音轨 (TRACK & SOURCE) -->
      <li class="pipeline-station station-track">
        <div class="station-axis" aria-hidden="true">
          <span class="station-emblem emblem-codec" :class="{ 'has-logo': !!codecEmblemLogo }">
            <template v-if="codecEmblemLogo">
              <img
                class="emblem-logo"
                :class="{
                  'has-dark-variant': !!codecEmblemLogo.dark,
                  'is-mono-ink': !!codecEmblemLogo.monoInk
                }"
                :src="codecEmblemLogo.light"
                :alt="codecEmblemLogo.alt"
                draggable="false"
              />
              <img
                v-if="codecEmblemLogo.dark"
                class="emblem-logo is-dark-variant"
                :src="codecEmblemLogo.dark"
                :alt="codecEmblemLogo.alt"
                draggable="false"
              />
            </template>
            <template v-else>{{ sourceCodecBadge }}</template>
          </span>
          <span class="station-shaft">
            <i class="shaft-line"></i>
            <i class="pi pi-angle-down shaft-arrow" aria-hidden="true"></i>
          </span>
        </div>
        <div class="station-body">
          <div class="station-title-row">
            <strong class="station-title">音轨</strong>
            <span class="station-tag">{{ flowing ? '实时流' : '就绪' }}</span>
          </div>
          <p class="station-primary-spec">{{ trackSpecLine }}</p>
          <p class="station-secondary-spec">{{ sourceChannels }} 声道</p>
          <button
            type="button"
            class="station-inline-link"
            :disabled="disabled"
            @click="emit('navigate', 'monitor')"
          >
            {{ audioProcessing.gapless !== false ? '无间隙' : '常规衔接' }}
          </button>
        </div>
      </li>

      <!-- 02 · 解码器 (DECODER) -->
      <li class="pipeline-station station-decoder">
        <div class="station-axis" aria-hidden="true">
          <span class="station-emblem emblem-decoder has-logo">
            <img
              class="emblem-logo"
              :class="{
                'has-dark-variant': !!decoderEmblemLogo.dark,
                'is-mono-ink': !!decoderEmblemLogo.monoInk
              }"
              :src="decoderEmblemLogo.light"
              :alt="decoderEmblemLogo.alt"
              draggable="false"
            />
            <img
              v-if="decoderEmblemLogo.dark"
              class="emblem-logo is-dark-variant"
              :src="decoderEmblemLogo.dark"
              :alt="decoderEmblemLogo.alt"
              draggable="false"
            />
          </span>
          <span class="station-shaft is-short">
            <i class="shaft-line"></i>
            <i class="pi pi-angle-down shaft-arrow" aria-hidden="true"></i>
          </span>
        </div>
        <div class="station-body">
          <div class="station-title-row">
            <strong class="station-title">解码器</strong>
          </div>
          <p class="station-primary-spec">{{ decoderLabel }}</p>
        </div>
      </li>

      <!-- 03 · 重采样 (RESAMPLER / SRC) -->
      <li class="pipeline-station station-resampler">
        <div class="station-axis" aria-hidden="true">
          <span class="station-emblem emblem-src">{{ resamplerBadge }}</span>
          <span class="station-shaft">
            <i class="shaft-line"></i>
            <i class="pi pi-angle-down shaft-arrow" aria-hidden="true"></i>
          </span>
        </div>
        <div class="station-body">
          <button
            type="button"
            class="station-title-link"
            :disabled="disabled"
            title="打开输出与重采样设置"
            @click="emit('output')"
          >
            <strong class="station-title">重采样</strong>
            <i class="pi pi-arrow-up-right" aria-hidden="true"></i>
          </button>
          <p class="station-primary-spec">{{ resamplerHeadline }}</p>
          <p class="station-secondary-spec">{{ resamplerPrecisionText }}</p>
          <p class="station-conversion-spec">
            <span>{{ dspSampleRate(sourceRate) }}</span>
            <i class="conversion-arrow" aria-hidden="true">→</i>
            <strong>{{ dspSampleRate(rate) }}</strong>
          </p>
        </div>
      </li>

      <!-- 04 · 信号处理 (DSP SIGNAL PROCESSING) -->
      <li class="pipeline-station station-dsp">
        <div class="station-axis" aria-hidden="true">
          <span class="station-emblem emblem-dsp has-logo" :class="{ active: !bypassed }">
            <img
              class="emblem-logo"
              :src="dspEmblemLogo.light"
              :alt="dspEmblemLogo.alt"
              draggable="false"
            />
          </span>
          <span class="station-shaft is-long">
            <i class="shaft-line"></i>
            <i class="pi pi-angle-down shaft-arrow" aria-hidden="true"></i>
          </span>
        </div>
        <div class="station-body">
          <div class="station-title-row">
            <strong class="station-title">信号处理</strong>
            <span class="station-tag">{{ sceneName }}</span>
          </div>
          <p class="station-primary-spec">Float64/32 bit</p>
          <p class="station-primary-spec">{{ dspSampleRate(rate) }}</p>

          <div class="dsp-subgroups">
            <!-- 均衡器 -->
            <div class="dsp-subgroup">
              <span class="subgroup-label">均衡器</span>
              <button
                type="button"
                class="subgroup-link-block"
                :disabled="disabled"
                @click="emit('navigate', 'equalizer')"
              >
                <span class="subgroup-line">
                  均衡器模式: <u>{{ eqModeLabel }}</u>
                </span>
                <span class="subgroup-line">
                  <u>{{ eqSpecLine }}</u>
                </span>
                <span class="subgroup-line">{{ eqLimiterBalanceLine }}</span>
              </button>
            </div>

            <!-- 音调与声场 -->
            <div class="dsp-subgroup">
              <span class="subgroup-label">声场与馈送</span>
              <button
                type="button"
                class="subgroup-link-block"
                :disabled="disabled"
                @click="emit('navigate', 'monitor')"
              >
                <span class="subgroup-line">
                  <u>{{ spatialToneLines.line1 }}</u>
                </span>
                <span class="subgroup-line">
                  <u>{{ spatialToneLines.line2 }}</u>
                </span>
              </button>
            </div>

            <!-- 增益 -->
            <div class="dsp-subgroup">
              <span class="subgroup-label">增益</span>
              <span class="subgroup-value">{{ gainValueText }}</span>
            </div>

            <!-- 音量控制 -->
            <div class="dsp-subgroup">
              <span class="subgroup-label">音量控制</span>
              <button
                type="button"
                class="subgroup-link-block"
                :disabled="disabled"
                @click="emit('navigate', 'monitor')"
              >
                <span class="subgroup-line">
                  <s v-if="!audioProcessing.directMode" class="dvc-strike">DVC</s>
                  <u>{{ volumeControlText }}</u>
                </span>
              </button>
            </div>

            <!-- 串行效果器链 (默认折叠) -->
            <div v-if="nodes.length" class="dsp-subgroup">
              <span class="subgroup-label">串行效果链</span>
              <button
                type="button"
                class="subgroup-collapse-toggle"
                :aria-expanded="chainExpanded"
                :title="chainExpanded ? '收起串行效果链节点' : '展开串行效果链节点'"
                @click="chainExpanded = !chainExpanded"
              >
                <span class="subgroup-line">
                  <u>{{ sceneName }} ({{ activeNodeCount }}/{{ nodes.length }} 启用)</u>
                </span>
                <i
                  class="pi"
                  :class="chainExpanded ? 'pi-chevron-up' : 'pi-chevron-down'"
                  aria-hidden="true"
                ></i>
              </button>
              <ol v-show="chainExpanded" class="overview-nodes" aria-label="当前引擎链路">
                <li v-for="(node, idx) in nodes" :key="node.id">
                  <button
                    type="button"
                    class="rail-node"
                    :class="{ 'is-active': node.active, 'is-off': node.state === '已旁路' }"
                    :disabled="disabled || !node.configured"
                    :title="node.reason || `${node.state} · 编辑 ${nodeLabel(node.type)}`"
                    @click="emit('node', node.id)"
                  >
                    <span class="rail-node-index">{{ String(idx + 1).padStart(2, '0') }}</span>
                    <i class="rail-led" aria-hidden="true"></i>
                    <span class="rail-node-main">
                      <span class="rail-node-title">{{ nodeLabel(node.type) }}</span>
                      <small v-if="getNodeDetail(node.id)" class="rail-node-summary">{{
                        getNodeDetail(node.id)
                      }}</small>
                    </span>
                    <span class="rail-node-badge">{{
                      node.active ? '运行' : node.state === '已旁路' ? '旁路' : '待命'
                    }}</span>
                  </button>
                </li>
              </ol>
            </div>

            <!-- 交叉淡入淡出 -->
            <div class="dsp-subgroup">
              <span class="subgroup-label">交叉淡入淡出</span>
              <button
                type="button"
                class="subgroup-link-block"
                :disabled="disabled"
                @click="emit('navigate', 'monitor')"
              >
                <span class="subgroup-line">
                  <u>{{ crossfadeText }}</u>
                </span>
              </button>
            </div>

            <!-- 缓冲区 -->
            <div class="dsp-subgroup">
              <span class="subgroup-label">缓冲区</span>
              <button
                type="button"
                class="subgroup-link-block"
                :disabled="disabled"
                @click="emit('output')"
              >
                <span class="subgroup-line">
                  <u>2x ({{ bufferDurationMs }} ms, {{ effectiveBuffer }} 音频帧)</u>
                </span>
              </button>
            </div>

            <!-- 延迟 -->
            <div class="dsp-subgroup">
              <span class="subgroup-label">延迟</span>
              <span class="subgroup-value"
                >{{ effectiveLatencyMs.toFixed(1) }} ms · 耗时 {{ processMs }} ms</span
              >
            </div>
          </div>
        </div>
      </li>

      <!-- 05 · 输出 (OUTPUT BACKEND) -->
      <li class="pipeline-station station-output">
        <div class="station-axis" aria-hidden="true">
          <span class="station-emblem emblem-output has-logo">
            <img
              class="emblem-logo"
              :class="{
                'has-dark-variant': !!outputEmblemLogo.dark,
                'is-mono-ink': !!outputEmblemLogo.monoInk
              }"
              :src="outputEmblemLogo.light"
              :alt="outputEmblemLogo.alt"
              draggable="false"
            />
            <img
              v-if="outputEmblemLogo.dark"
              class="emblem-logo is-dark-variant"
              :src="outputEmblemLogo.dark"
              :alt="outputEmblemLogo.alt"
              draggable="false"
            />
          </span>
          <span class="station-shaft">
            <i class="shaft-line"></i>
            <i class="pi pi-angle-down shaft-arrow" aria-hidden="true"></i>
          </span>
        </div>
        <div class="station-body">
          <button
            type="button"
            class="station-title-link"
            :disabled="disabled"
            @click="emit('output')"
          >
            <strong class="station-title">输出</strong>
            <i class="pi pi-arrow-up-right" aria-hidden="true"></i>
          </button>
          <button
            type="button"
            class="station-inline-link"
            :disabled="disabled"
            @click="emit('output')"
          >
            {{ outputBackendLabel }} Output ({{ isExclusive ? '独占模式' : '共享模式' }})
          </button>
          <p class="station-conversion-spec">
            <span>{{ outputBitTransition }}</span>
          </p>
          <p class="station-primary-spec">{{ dspSampleRate(rate) }}</p>

          <div class="dsp-subgroups output-subgroups">
            <div class="dsp-subgroup">
              <span class="subgroup-label">标志</span>
              <span class="subgroup-mono">{{ outputFlagsText }}</span>
            </div>
            <div class="dsp-subgroup">
              <span class="subgroup-label">延迟</span>
              <span class="subgroup-value">{{ effectiveLatencyMs.toFixed(1) }} ms</span>
            </div>
          </div>
        </div>
      </li>

      <!-- 06 · 输出设备 (OUTPUT DEVICE) -->
      <li class="pipeline-station station-device">
        <div class="station-axis" aria-hidden="true">
          <span class="station-emblem emblem-device" :class="{ 'has-logo': !!deviceEmblemLogo }">
            <img
              v-if="deviceEmblemLogo"
              class="emblem-logo"
              :class="{ 'is-mono-ink': !!deviceEmblemLogo.monoInk }"
              :src="deviceEmblemLogo.light"
              :alt="deviceEmblemLogo.alt"
              draggable="false"
            />
            <i v-else class="pi pi-volume-up" aria-hidden="true"></i>
          </span>
        </div>
        <div class="station-body">
          <button
            type="button"
            class="station-title-link"
            :disabled="disabled"
            @click="emit('output')"
          >
            <strong class="station-title">输出设备</strong>
            <i class="pi pi-arrow-up-right" aria-hidden="true"></i>
          </button>
          <p class="station-primary-spec">{{ outputName }}</p>
        </div>
      </li>
    </ol>
  </section>
</template>
