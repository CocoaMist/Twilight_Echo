<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
import { useCoreConnection } from '../../stores/coreConnection.ts'
import { useSettingsStore } from '../../stores/useSettingsStore.ts'
import {
  createMusicMetadataSettings,
  metadataReason,
  metadataSourceOptions
} from './musicMetadataSettings.ts'
import type { EntityMetadataLanguage } from '../../../../shared/entityMetadata.ts'
import SettingsGroup from './SettingsGroup.vue'

const core = useCoreConnection()
const { settings, updateSettings } = useSettingsStore()
const preferences = computed(() => settings.value.musicIdentification)
const model = createMusicMetadataSettings({
  current: () => preferences.value,
  save: (musicIdentification) => updateSettings({ musicIdentification }),
  policy: (signal) => core.query('metadata.entity.policy', {}, signal)
})
const state = model.state
const sources = computed(() => metadataSourceOptions(state.value.policy, preferences.value.sources))
const dormant = computed(
  () =>
    (preferences.value.newImports || preferences.value.history) &&
    !state.value.loading &&
    state.value.policy &&
    !sources.value.some((s) => preferences.value.sources.includes(s.provider) && s.available)
)
watch(
  [
    () => core.state.value?.epoch,
    () => core.state.value?.entityMetadataRevision,
    () => core.state.value?.settingsRevision,
    () => core.state.value?.pluginsRevision
  ],
  () => void model.refresh(),
  { immediate: true }
)
onBeforeUnmount(model.dispose)
</script>

<template>
  <SettingsGroup
    id="music-metadata"
    title="音乐库资料"
    :summary="`新入库${preferences.newImports ? '已开启' : '未开启'} · 历史回填${preferences.history ? '已开启' : '未开启'} · ${preferences.sources.length} 个资料源`"
    :attention="state.error || state.policyError"
    description="本地与已加入音乐库的平台歌曲共用资料。先核对身份，再补介绍及可用资料；不按同名强行关联。"
  >
    <p id="music-metadata-privacy" class="metadata-privacy">
      开启后，会向所选资料源发送歌曲、艺人和专辑名称、已有外部
      ID、必要的曲序与时长；不上传音频、本地文件路径或播放历史。手动介绍不会被自动覆盖。
    </p>
    <div class="setting-list" :aria-busy="state.saving">
      <div
        id="setting-metadata-new-imports"
        data-setting-id="metadata-new-imports"
        class="setting-item"
      >
        <div class="setting-copy">
          <strong>自动补全新入库资料</strong><span>处理之后新加入的本地与平台歌曲。默认关闭。</span>
        </div>
        <button
          type="button"
          class="toggle-switch"
          role="switch"
          aria-label="自动补全新入库资料"
          aria-describedby="music-metadata-privacy"
          :aria-checked="preferences.newImports"
          :class="{ active: preferences.newImports, inactive: !preferences.newImports }"
          :disabled="state.saving"
          @click="model.scope('newImports')"
        />
      </div>
      <div id="setting-metadata-history" data-setting-id="metadata-history" class="setting-item">
        <div class="setting-copy">
          <strong>回填已有音乐库资料</strong
          ><span>在后台分批处理已有歌曲；关闭后撤销对应自动需求，保留已存资料。</span>
        </div>
        <button
          type="button"
          class="toggle-switch"
          role="switch"
          aria-label="回填已有音乐库资料"
          aria-describedby="music-metadata-privacy"
          :aria-checked="preferences.history"
          :class="{ active: preferences.history, inactive: !preferences.history }"
          :disabled="state.saving"
          @click="model.scope('history')"
        />
      </div>
      <div id="setting-metadata-language" data-setting-id="metadata-language" class="setting-item">
        <div class="setting-copy">
          <strong>资料首选语言</strong><span>缺少首选语言时显示实际可用语言，不自动翻译。</span>
        </div>
        <select
          class="preview-select"
          aria-label="资料首选语言"
          :value="preferences.language ?? ''"
          :disabled="state.saving"
          @change="
            model.language(
              (($event.target as HTMLSelectElement).value || undefined) as
                | EntityMetadataLanguage
                | undefined
            )
          "
        >
          <option value="">跟随界面语言</option>
          <option value="zh-Hans">简体中文</option>
          <option value="zh-Hant">繁體中文</option>
          <option value="en">English</option>
        </select>
      </div>
      <div
        id="setting-metadata-sources"
        data-setting-id="metadata-sources"
        class="metadata-sources"
      >
        <div class="metadata-sources-heading">
          <strong>资料源</strong>
          <button
            type="button"
            class="soft-button"
            :disabled="state.loading"
            @click="model.refresh()"
          >
            检查可用性
          </button>
        </div>
        <p v-if="state.loading" role="status">正在读取资料源能力…</p>
        <p v-if="state.policy?.reason">
          {{
            state.policy.reason === 'metadata_disabled'
              ? metadataReason(state.policy.reason) + '。自动设置保留，当前不执行。'
              : '公共资料服务：' + metadataReason(state.policy.reason) + '。平台按自身能力执行。'
          }}
        </p>
        <label v-for="source in sources" :key="source.provider" class="metadata-source">
          <input
            type="checkbox"
            :checked="preferences.sources.includes(source.provider)"
            :disabled="
              state.saving ||
              (!preferences.sources.includes(source.provider) && (state.loading || !source.available))
            "
            @change="model.source(source.provider, ($event.target as HTMLInputElement).checked)"
          />
          <span
            ><strong>{{ source.label }}</strong>
            <span
              v-for="description in source.descriptions"
              :key="description"
              class="metadata-source-detail"
              >{{ description }}</span
            >
            <span
              v-if="source.provider === 'musicbrainz' && state.policy && !state.policy.introduction"
              class="metadata-source-detail"
              >公共百科介绍未启用；结构化资料与图片按各自能力执行。</span
            >
          </span>
        </label>
        <p v-if="dormant" role="status">
          所选资料源当前均不可用，自动任务暂不执行。可更换资料源，或在能力恢复后继续。
        </p>
        <p v-else-if="!preferences.sources.length">尚未选择资料源，自动任务暂不执行。</p>
      </div>
    </div>
    <p v-if="state.error || state.policyError" role="alert">
      {{ state.error || `资料源读取失败：${state.policyError}` }}
    </p>
    <p v-else-if="state.saving || state.notice" role="status">
      {{ state.saving ? '正在保存…' : state.notice }}
    </p>
  </SettingsGroup>
</template>

<style scoped>
.metadata-privacy {
  line-height: 1.75;
  color: var(--text-secondary);
}
.metadata-sources {
  padding-top: 16px;
  border-top: 1px solid var(--te-card-border);
}
.metadata-sources-heading {
  display: flex;
  gap: 16px;
  align-items: center;
  justify-content: space-between;
}
.metadata-source {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px 0;
  cursor: pointer;
}
.metadata-source input {
  margin-top: 4px;
  accent-color: var(--te-primary-500);
}
.metadata-source input:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 3px;
}
.metadata-source-detail {
  display: block;
  color: var(--text-secondary);
  line-height: 1.65;
  margin-top: 4px;
  overflow-wrap: anywhere;
}
.metadata-source strong {
  overflow-wrap: anywhere;
}
button:disabled {
  cursor: default;
  opacity: 0.5;
}
</style>
