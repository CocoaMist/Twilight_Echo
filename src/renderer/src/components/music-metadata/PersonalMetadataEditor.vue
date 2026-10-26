<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue'
import type { EntityMetadataDetail, EntityMetadataLanguage } from '../../../../shared/entityMetadata.ts'
import { useCoreConnection } from '../../stores/coreConnection.ts'
import { createEntityPersonalMetadataEditor } from './entityPersonalMetadataEditor.ts'
import { parsePersonalMusicArtwork } from '../../../../shared/personalMusicArtwork.ts'

const props = defineProps<{
  scope: string
  selected: string | null
  detail: EntityMetadataDetail | null
  available: boolean
  language: EntityMetadataLanguage
  refresh: () => Promise<void>
}>()
const core = useCoreConnection()
const editor = createEntityPersonalMetadataEditor({
  scope: () => props.scope, selected: () => props.selected, detail: () => props.detail,
  available: () => props.available, language: () => props.language,
  sourcePreference: request => core.command('metadata.entity.sourcePreference', request),
  artworkOverride: request => core.command('metadata.entity.artworkOverride', request),
  refresh: () => props.refresh()
})
const { state, current, attached, needsReview, canSubmit } = editor
const displayed = computed(() => props.detail?.entityId === props.selected ? props.detail : null)
const sources = computed(() => [...new Set([...(displayed.value?.sourceOptions ?? []),
  ...(displayed.value?.sourcePreference?.provider ? [displayed.value.sourcePreference.provider] : [])])])
const selectedProvider = computed(() => state.value.mode === 'source' ? state.value.provider : displayed.value?.sourcePreference?.provider)
const sourceLabels: Record<string, string> = { wikipedia: 'Wikipedia', musicbrainz: 'MusicBrainz', ncm: '网易云音乐', qq: 'QQ 音乐' }
const sourceLabel = (provider: string) => sourceLabels[provider.replace(/^platform\./, '')] ?? provider.replace(/^platform\./, '')
function chooseFile(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]
  if (file) void editor.loadArtwork(file, () => new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = async () => {
      if (typeof reader.result !== 'string') { reject(new Error('无法读取图片')); return }
      try {
        const parsed = parsePersonalMusicArtwork(reader.result)
        if (!parsed) throw new Error('invalid bitmap')
        const image = new Image()
        image.src = reader.result
        await image.decode()
        if (image.naturalWidth !== parsed.width || image.naturalHeight !== parsed.height) throw new Error('invalid bitmap dimensions')
        resolve(reader.result)
      } catch { reject(new Error('图片无法解码，请选择有效的静态位图。')) }
    }
    reader.onerror = () => reject(new Error('无法读取图片，请重新选择'))
    reader.readAsDataURL(file)
  }))
  input.value = ''
}
onBeforeUnmount(editor.dispose)
</script>

<template>
  <div v-if="displayed || state.mode" class="personal-metadata-editor" :aria-busy="!available || state.saving || state.reading">
    <template v-if="!state.mode || state.mode === 'source'">
      <label class="source-choice">介绍资料源
        <select :value="selectedProvider ?? ''" :disabled="!current || state.saving"
          @change="editor.provider(($event.target as HTMLSelectElement).value || null)">
          <option value="">自动选择</option>
          <option v-for="provider in sources" :key="provider" :value="provider">{{ sourceLabel(provider) }}</option>
        </select>
      </label>
      <p v-if="displayed?.sourcePreference?.provider && !displayed.sourcePreference.available" role="status">
        首选资料源当前没有可用介绍，已使用其他可用资料。首选仍保留。
      </p>
      <p v-if="state.mode === 'source'">只选择此条目的已有资料，不发起联网查询。手动介绍始终优先。</p>
    </template>
    <div v-if="!state.mode || state.mode === 'value'" class="artwork-actions">
      <label class="file-choice">{{ displayed?.manualArtwork ? '替换资料图片' : '添加资料图片' }}
        <input type="file" accept="image/png,image/jpeg,image/webp" :disabled="!current || state.saving || state.reading" @change="chooseFile" />
      </label>
      <span>静态 PNG、JPEG、WebP，最大 2 MiB</span>
      <button v-if="!state.mode" type="button" :disabled="!current" @click="editor.begin('clear')">隐藏资料图片</button>
      <button v-if="!state.mode && displayed?.artworkOverride" type="button" :disabled="!current" @click="editor.begin('reset')">恢复自动图片</button>
    </div>
    <img v-if="state.mode === 'value' && state.dataUrl" class="artwork-preview" :src="state.dataUrl" alt="待保存的资料图片" />
    <p v-if="state.reading" role="status">正在读取图片…</p>
    <p v-if="state.mode === 'clear'">隐藏自动和手工资料图片。以后可恢复自动图片。</p>
    <p v-if="state.mode === 'reset'">移除手工图片或隐藏标记，重新显示已有自动图片，不发起联网查询。</p>
    <p v-if="state.mode && !attached && !displayed" role="status">当前条目尚未加载，草稿未提交。</p>
    <div v-else-if="state.mode && attached && needsReview" role="status">
      <p>请核对最新资料；草稿不会自动覆盖它。</p>
      <button type="button" :disabled="state.saving || state.reading" @click="editor.acceptLatest()">已核对，保留草稿</button>
    </div>
    <p v-if="state.error" role="alert">{{ state.error }}</p>
    <div v-if="state.mode" class="draft-actions">
      <button type="button" :disabled="!canSubmit" @click="editor.submit()">{{ state.saving ? '正在保存…' : state.mode === 'source' ? '保存资料源首选' : state.mode === 'clear' ? '确认隐藏' : state.mode === 'reset' ? '确认恢复自动图片' : '保存图片' }}</button>
      <button type="button" :disabled="state.saving" @click="editor.cancel()">取消</button>
    </div>
    <p v-if="state.notice" role="status">{{ state.notice }}</p>
  </div>
</template>

<style scoped>
.personal-metadata-editor { margin-block: 16px; line-height: 1.7; }
.source-choice, .artwork-actions, .draft-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.artwork-actions { margin-top: 12px; }
.artwork-actions > span, p { color: var(--te-neutral-500); }
select, button, input { font: inherit; }
select { color: var(--te-neutral-900); background: var(--te-bg-elevated, transparent); padding: 6px 10px; border: 1px solid color-mix(in srgb, var(--te-neutral-500) 40%, transparent); border-radius: 6px; }
button, .file-choice { color: var(--te-primary-600); background: var(--te-hover-bg); border: 0; border-radius: 6px; padding: 6px 10px; }
button { cursor: pointer; }
.file-choice { display: grid; gap: 4px; }
input { max-width: 250px; }
button:disabled { opacity: .45; cursor: default; }
button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid var(--te-primary-500); outline-offset: 3px; }
.artwork-preview { display: block; width: 144px; max-height: 180px; object-fit: contain; margin-block: 12px; border-radius: 8px; }
</style>
