<script setup lang="ts">
import type { MusicCachePolicySettings, StreamingAudioCachePolicy } from '../../types/settings'

defineProps<{
  activeCachePath: string
  cachePolicy: MusicCachePolicySettings
  autoAnalyzeBpm: boolean
  streamingAudioCachePolicyOptions: readonly {
    value: StreamingAudioCachePolicy
    label: string
  }[]
  formattedBpmAnalysisCacheSize: string
  clearingBpmAnalysisCache: boolean
  formattedLoudnessAnalysisCacheSize: string
  clearingLoudnessAnalysisCache: boolean
  formattedCacheSize: string
  clearingCache: boolean
}>()

const emit = defineEmits<{
  chooseCacheFolder: []
  resetCacheFolder: []
  toggleCacheArtifact: [key: keyof MusicCachePolicySettings]
  setStreamingAudioCachePolicy: [event: Event]
  toggleAutoAnalyzeBpm: []
  confirmClearBpmAnalysisCache: []
  confirmClearLoudnessAnalysisCache: []
  confirmClearCache: []
}>()
</script>

<template>
  <section id="cache" class="glass-card preview-section">
    <div class="section-title-row">
      <i class="pi pi-database"></i>
      <h2>缓存</h2>
    </div>
    <div class="setting-list">
      <div class="setting-item top-align">
        <div class="setting-copy">
          <strong>缓存目录</strong>
          <span>保存图片、歌词、在线资源和可复用的流媒体缓存；用户固定的离线下载独立保留。</span>
        </div>
        <div class="path-control">
          <input aria-label="缓存目录" readonly :value="activeCachePath || '未设置'" />
          <button type="button" class="soft-button" @click="emit('chooseCacheFolder')">
            选择文件夹
          </button>
          <button type="button" class="muted-button" @click="emit('resetCacheFolder')">
            恢复默认
          </button>
        </div>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>封面缓存</strong>
          <span>复用已获取的专辑封面，减少重复读取和下载。</span>
        </div>
        <button
          type="button"
          class="toggle-switch"
          :class="{ active: cachePolicy.cover, inactive: !cachePolicy.cover }"
          role="switch"
          :aria-checked="cachePolicy.cover"
          @click="emit('toggleCacheArtifact', 'cover')"
          aria-label="封面缓存"
        ></button>
      </div>
      <div class="setting-item">
        <div class="setting-copy">
          <strong>歌词缓存</strong>
          <span>复用已获取的歌词、翻译与音源补充内容。</span>
        </div>
        <button
          type="button"
          class="toggle-switch"
          :class="{ active: cachePolicy.lyrics, inactive: !cachePolicy.lyrics }"
          role="switch"
          :aria-checked="cachePolicy.lyrics"
          @click="emit('toggleCacheArtifact', 'lyrics')"
          aria-label="歌词缓存"
        ></button>
      </div>
      <div class="setting-item">
        <div class="setting-copy">
          <strong>元数据缓存</strong>
          <span>缓存在线匹配得到的艺人、专辑和曲目信息，不覆盖本地文件身份。</span>
        </div>
        <button
          type="button"
          class="toggle-switch"
          :class="{ active: cachePolicy.metadata, inactive: !cachePolicy.metadata }"
          role="switch"
          :aria-checked="cachePolicy.metadata"
          @click="emit('toggleCacheArtifact', 'metadata')"
          aria-label="元数据缓存"
        ></button>
      </div>
      <div class="setting-item">
        <div class="setting-copy">
          <strong>流媒体音频缓存</strong>
          <span>仅在插件和平台规则允许时缓存音频；关闭后不保存音源请求得到的可复用音频。</span>
        </div>
        <select
          aria-label="流媒体音频缓存"
          class="preview-select compact-select"
          :value="cachePolicy.streamingAudio"
          @change="emit('setStreamingAudioCachePolicy', $event)"
        >
          <option
            v-for="option in streamingAudioCachePolicyOptions"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </select>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>自动分析节拍速度（BPM）</strong>
          <span>首次播放本地音频时在后台估算节拍速度，并缓存结果供下次播放直接使用。</span>
        </div>
        <button
          type="button"
          class="toggle-switch"
          :class="{ active: autoAnalyzeBpm, inactive: !autoAnalyzeBpm }"
          role="switch"
          :aria-checked="autoAnalyzeBpm"
          @click="emit('toggleAutoAnalyzeBpm')"
          aria-label="自动分析节拍速度（BPM）"
        ></button>
      </div>
      <div class="setting-item">
        <div class="setting-copy">
          <strong>BPM 分析缓存</strong>
          <span
            >当前估算：<b>{{ formattedBpmAnalysisCacheSize }}</b></span
          >
        </div>
        <button
          class="danger-soft-button solid-hover"
          type="button"
          :disabled="clearingBpmAnalysisCache"
          @click="emit('confirmClearBpmAnalysisCache')"
        >
          <i class="pi pi-trash"></i>
          {{ clearingBpmAnalysisCache ? '清理中…' : '清理 BPM 缓存' }}
        </button>
      </div>
      <div class="setting-item">
        <div class="setting-copy">
          <strong>响度分析缓存（Loudnorm）</strong>
          <span
            >当前估算：<b>{{ formattedLoudnessAnalysisCacheSize }}</b
            >。清理后下次播放会重新测量响度。</span
          >
        </div>
        <button
          class="danger-soft-button solid-hover"
          type="button"
          :disabled="clearingLoudnessAnalysisCache"
          @click="emit('confirmClearLoudnessAnalysisCache')"
        >
          <i class="pi pi-trash"></i>
          {{ clearingLoudnessAnalysisCache ? '清理中…' : '清理响度缓存' }}
        </button>
      </div>
      <hr />
      <div class="setting-item">
        <div class="setting-copy">
          <strong>缓存占用</strong>
          <span
            >当前估算：<b>{{ formattedCacheSize }}</b></span
          >
        </div>
        <button
          class="danger-soft-button solid-hover"
          type="button"
          :disabled="clearingCache"
          @click="emit('confirmClearCache')"
        >
          <i class="pi pi-trash"></i>
          {{ clearingCache ? '清理中…' : '清理缓存' }}
        </button>
      </div>
    </div>
  </section>
</template>
