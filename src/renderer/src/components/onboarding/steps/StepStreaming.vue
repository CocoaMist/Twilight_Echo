<script setup lang="ts">
import { ref } from 'vue'
import { useSettingsStore } from '@renderer/stores/useSettingsStore'
import type {
  MusicCachePolicySettings,
  NcmPlaybackQuality,
  ProxyMode,
  StreamingAudioCachePolicy
} from '@renderer/types/settings'

const props = defineProps<{
  wantsLogin: boolean
  quality: NcmPlaybackQuality
  cachePolicy: MusicCachePolicySettings
  wantsPluginMarket: boolean
}>()
const emit = defineEmits<{
  'update:wantsLogin': [value: boolean]
  'update:quality': [value: NcmPlaybackQuality]
  'update:cachePolicy': [value: MusicCachePolicySettings]
  'update:wantsPluginMarket': [value: boolean]
}>()

const qualityOptions: { value: NcmPlaybackQuality; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'standard', label: '标准' },
  { value: 'exhigh', label: '极高' },
  { value: 'lossless', label: '无损' },
  { value: 'hires', label: 'Hi-Res' }
]

const cacheOptions: { value: StreamingAudioCachePolicy; label: string; title: string }[] = [
  {
    value: 'provider',
    label: '跟随来源规则',
    title: '由音乐来源决定是否允许缓存，兼容性与体验最均衡'
  },
  { value: 'off', label: '不缓存音频', title: '每次播放都实时拉取，占用空间最小' }
]

function setAudioCachePolicy(streamingAudio: StreamingAudioCachePolicy): void {
  emit('update:cachePolicy', { ...props.cachePolicy, streamingAudio })
}

// Proxy is a rescue hatch for users whose network can't reach NCM directly;
// collapsed by default so the happy path stays uncluttered. Writes apply
// immediately so a retry from the login page picks them up.
const { settings, updateSettings } = useSettingsStore()
const proxyOpen = ref(false)

const proxyModeOptions: { value: ProxyMode; label: string }[] = [
  { value: 'auto', label: '跟随系统' },
  { value: 'custom', label: '自定义' },
  { value: 'off', label: '直连' }
]

function setProxyMode(proxyMode: ProxyMode): void {
  if (settings.value.proxyMode === proxyMode) return
  void updateSettings({ proxyMode })
}

function setProxyHost(event: Event): void {
  void updateSettings({ proxyHost: (event.target as HTMLInputElement).value.trim() })
}

function setProxyPort(event: Event): void {
  const value = parseInt((event.target as HTMLInputElement).value, 10)
  void updateSettings({ proxyPort: Number.isFinite(value) && value > 0 ? value : 0 })
}
</script>

<template>
  <section class="onb-stage" data-scene="04">
    <p class="onb-kicker">流媒体</p>
    <h1 class="onb-title">连接<em>网易云音乐</em></h1>
    <p class="onb-subtitle">
      内置的网易云音乐源已经启用。登录后即可同步歌单、收藏与每日推荐；不登录也可以浏览流媒体页面。
    </p>
    <div class="onb-cards" :class="{ 'has-selection': true }" role="radiogroup">
      <button
        type="button"
        class="onb-card"
        :class="{ 'is-selected': props.wantsLogin }"
        role="radio"
        :aria-checked="props.wantsLogin"
        @click="emit('update:wantsLogin', true)"
      >
        <span v-if="props.wantsLogin" class="onb-card-check"><i class="ph ph-check"></i></span>
        <i class="onb-card-icon ph ph-qr-code"></i>
        <span class="onb-card-title">完成后立即登录</span>
        <span class="onb-card-desc">向导结束后打开扫码登录页，一步接入你的曲库</span>
      </button>
      <button
        type="button"
        class="onb-card"
        :class="{ 'is-selected': !props.wantsLogin }"
        role="radio"
        :aria-checked="!props.wantsLogin"
        @click="emit('update:wantsLogin', false)"
      >
        <span v-if="!props.wantsLogin" class="onb-card-check"><i class="ph ph-check"></i></span>
        <i class="onb-card-icon ph ph-compass"></i>
        <span class="onb-card-title">稍后再说</span>
        <span class="onb-card-desc">先随便逛逛，需要时再从标题栏登录</span>
      </button>
    </div>
    <div class="onb-segmented" role="radiogroup" aria-label="在线播放音质">
      <button
        v-for="option in qualityOptions"
        :key="option.value"
        type="button"
        :class="{ 'is-selected': props.quality === option.value }"
        role="radio"
        :aria-checked="props.quality === option.value"
        @click="emit('update:quality', option.value)"
      >
        {{ option.label }}
      </button>
    </div>
    <div class="onb-segmented is-small" role="radiogroup" aria-label="流媒体音频缓存">
      <button
        v-for="option in cacheOptions"
        :key="option.value"
        type="button"
        :class="{ 'is-selected': props.cachePolicy.streamingAudio === option.value }"
        role="radio"
        :aria-checked="props.cachePolicy.streamingAudio === option.value"
        :title="option.title"
        @click="setAudioCachePolicy(option.value)"
      >
        {{ option.label }}
      </button>
    </div>
    <div class="onb-panel">
      <div class="onb-toggle-row">
        <div class="onb-toggle-copy">
          <strong>完成后逛逛插件市场</strong>
          <span>安装更多音乐源与主题插件，扩展你的聆听版图。</span>
        </div>
        <button
          type="button"
          class="onb-toggle"
          :class="{ 'is-on': props.wantsPluginMarket }"
          role="switch"
          :aria-checked="props.wantsPluginMarket"
          aria-label="完成后逛逛插件市场"
          @click="emit('update:wantsPluginMarket', !props.wantsPluginMarket)"
        ></button>
      </div>
      <button
        type="button"
        class="onb-disclosure"
        :aria-expanded="proxyOpen"
        @click="proxyOpen = !proxyOpen"
      >
        <i class="ph" :class="proxyOpen ? 'ph-caret-down' : 'ph-caret-right'"></i>
        网络代理（连接不上时再设置）
      </button>
      <div v-if="proxyOpen" class="onb-proxy-body">
        <div class="onb-segmented is-small" role="radiogroup" aria-label="代理模式">
          <button
            v-for="option in proxyModeOptions"
            :key="option.value"
            type="button"
            :class="{ 'is-selected': settings.proxyMode === option.value }"
            role="radio"
            :aria-checked="settings.proxyMode === option.value"
            @click="setProxyMode(option.value)"
          >
            {{ option.label }}
          </button>
        </div>
        <div v-if="settings.proxyMode === 'custom'" class="onb-proxy-inputs">
          <input
            type="text"
            class="onb-input"
            placeholder="代理地址，如 127.0.0.1"
            :value="settings.proxyHost"
            aria-label="代理地址"
            @change="setProxyHost"
          />
          <input
            type="number"
            class="onb-input onb-input-port"
            placeholder="端口"
            min="1"
            max="65535"
            :value="settings.proxyPort || ''"
            aria-label="代理端口"
            @change="setProxyPort"
          />
        </div>
      </div>
    </div>
    <p class="onb-hint">
      在线播放音质：无损与 Hi-Res 需要对应的会员权益；音频缓存默认尊重各音乐来源的规则。
    </p>
  </section>
</template>
