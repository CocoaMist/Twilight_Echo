<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from 'vue'
import type {
  EntityMetadataDetail,
  EntityMetadataLanguage,
  EntityMetadataOverride
} from '../../../../shared/entityMetadata.ts'
import { useCoreConnection } from '../../stores/coreConnection.ts'
import { createEntityIntroductionEditor } from './entityIntroductionEditor.ts'

const props = defineProps<{
  scope: string
  selected: string | null
  detail: EntityMetadataDetail | null
  available: boolean
  language: EntityMetadataLanguage
  refresh: () => Promise<void>
}>()
const core = useCoreConnection()
const editor = createEntityIntroductionEditor({
  scope: () => props.scope,
  selected: () => props.selected,
  detail: () => props.detail,
  available: () => props.available,
  language: () => props.language,
  override: (request) => core.command('metadata.entity.override', request),
  refresh: () => props.refresh()
})
const { state, current, attached, needsReview, valid, canSubmit } = editor
const textarea = ref<HTMLTextAreaElement | null>(null)
const confirmButton = ref<HTMLButtonElement | null>(null)
const editButton = ref<HTMLButtonElement | null>(null)
async function focusControl(scope: string, selected: string | null) {
  await nextTick()
  if (props.scope !== scope || props.selected !== selected) return
  const control =
    state.value.mode === 'value'
      ? textarea.value
      : state.value.mode
        ? confirmButton.value
        : editButton.value
  control?.focus()
}
function begin(mode: EntityMetadataOverride['mode']) {
  editor.begin(mode)
  if (state.value.mode === mode) void focusControl(props.scope, props.selected)
}
function cancel() {
  if (state.value.saving) return
  editor.cancel()
  void focusControl(props.scope, props.selected)
}
async function submit() {
  if (!canSubmit.value) return
  const { scope, selected } = props
  await editor.submit()
  if (!state.value.mode) void focusControl(scope, selected)
}
onBeforeUnmount(editor.dispose)
</script>

<template>
  <div class="introduction-editor">
    <div v-if="!state.mode" class="editor-actions">
      <template v-if="current">
        <button ref="editButton" type="button" @click="begin('value')">编辑介绍</button>
        <button type="button" @click="begin('clear')">清空介绍</button>
        <button v-if="current.override" type="button" @click="begin('reset')">恢复自动</button>
      </template>
      <span v-if="state.notice" role="status">{{ state.notice }}</span>
    </div>
    <form v-else class="editor-form" :aria-busy="state.saving" @submit.prevent="submit">
      <template v-if="state.mode === 'value'">
        <label class="editor-label"
          >手动介绍
          <textarea
            ref="textarea"
            :value="state.value"
            rows="7"
            maxlength="20000"
            :disabled="state.saving"
            placeholder="填写自己的介绍；保存后优先显示，不会被后台补全覆盖。"
            @input="editor.value(($event.target as HTMLTextAreaElement).value)"
          />
        </label>
        <div class="editor-language">
          <label
            >介绍语言
            <select
              :value="state.language"
              :disabled="state.saving"
              @change="
                editor.language(
                  ($event.target as HTMLSelectElement).value as EntityMetadataLanguage
                )
              "
            >
              <option value="zh-Hans">简体中文</option>
              <option value="zh-Hant">繁體中文</option>
              <option value="en">English</option>
            </select>
          </label>
          <span>{{ state.value.length.toLocaleString() }} / 20,000</span>
        </div>
        <p v-if="state.value && !valid" role="alert">
          请输入有效介绍；要隐藏介绍，请取消后选择“清空介绍”。
        </p>
      </template>
      <p v-else-if="state.mode === 'clear'">
        清空后不再显示自动或历史介绍。以后可用“恢复自动”重新显示已有资料。
      </p>
      <p v-else>移除手动介绍或清空标记，重新显示已有自动或历史资料。此操作不会发起联网查询。</p>
      <p v-if="!attached" role="status">当前条目尚未加载或已不在此分组；草稿尚未提交。</p>
      <div v-else-if="needsReview" class="editor-review" role="status">
        <p>资料已重新读取。请核对上方最新内容；草稿不会自动覆盖它。</p>
        <button type="button" :disabled="state.saving" @click="editor.acceptLatest()">
          已核对最新资料，保留草稿
        </button>
      </div>
      <p v-if="state.error" role="alert">{{ state.error }}</p>
      <div class="editor-actions">
        <button ref="confirmButton" type="submit" class="editor-primary" :disabled="!canSubmit">
          {{
            state.saving
              ? '正在保存…'
              : state.mode === 'clear'
                ? '确认清空'
                : state.mode === 'reset'
                  ? '确认恢复自动'
                  : '保存介绍'
          }}
        </button>
        <button type="button" :disabled="state.saving" @click="cancel">取消</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.introduction-editor {
  margin-top: 12px;
}
.editor-form {
  max-width: 840px;
  padding-top: 16px;
  border-top: 1px solid color-mix(in srgb, var(--te-neutral-500) 16%, transparent);
}
.editor-label {
  display: grid;
  gap: 10px;
  color: var(--te-neutral-900);
}
textarea,
select {
  font: inherit;
  color: var(--te-neutral-900);
  background: var(--te-bg-elevated, transparent);
  border: 1px solid color-mix(in srgb, var(--te-neutral-500) 40%, transparent);
  border-radius: 8px;
  padding: 10px;
}
textarea {
  resize: vertical;
  min-height: 160px;
  width: 100%;
  box-sizing: border-box;
  line-height: 1.75;
}
.editor-language {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  margin: 12px 0;
}
.editor-language label {
  display: flex;
  gap: 10px;
  align-items: center;
}
.editor-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
p {
  line-height: 1.7;
}
button {
  font: inherit;
  color: var(--te-primary-600);
  border: 0;
  padding: 8px 12px;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
}
button:not(:disabled):hover,
.editor-primary {
  background: color-mix(in srgb, var(--te-primary-500) 12%, transparent);
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
button:focus-visible,
textarea:focus-visible,
select:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 3px;
}
</style>
