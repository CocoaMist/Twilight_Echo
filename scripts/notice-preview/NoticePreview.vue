<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import AppNoticeHost from '../../src/renderer/src/components/AppNoticeHost.vue'
import {
  useAppNoticeStore,
  type AppNoticeKind
} from '../../src/renderer/src/stores/useAppNoticeStore'

const host = ref<InstanceType<typeof AppNoticeHost> | null>(null)
const { pushNotice, clearNotices, unreadCount } = useAppNoticeStore()
const dark = ref(true)
const reduced = ref(false)
watch(reduced, (value) => {
  document.documentElement.dataset.teMotion = value ? 'reduced' : 'full'
})
function sample(kind: AppNoticeKind): void {
  const messages = {
    success: '音乐库更新完成，已添加 12 首歌曲。',
    info: '已为你保存当前播放队列，下次打开可以继续聆听。',
    warning: '部分歌曲的封面暂时无法获取，你仍可以正常播放。',
    error: '网络连接暂时中断，请检查网络后重试。'
  }
  pushNotice({
    kind,
    message: messages[kind],
    ...(kind === 'error' ? { action: { label: '重新连接', run: () => sample('success') } } : {})
  })
}
async function replay(): Promise<void> {
  clearNotices()
  sample('success')
  sample('info')
  sample('warning')
  sample('error')
  await nextTick()
}
onMounted(async () => {
  await replay()
  await host.value?.toggleHistory()
})
</script>

<template>
  <main class="preview" :class="{ dark }">
    <header class="preview-bar">
      <span>Twilight Echo <small> / 通知栏预览</small></span
      ><button
        class="bell"
        aria-label="任务与通知"
        :aria-expanded="host?.historyOpen"
        aria-controls="app-notice-history"
        @click="host?.toggleHistory($event)"
      >
        <i class="pi pi-bell"></i><b v-if="unreadCount"></b>
      </button>
    </header>
    <section class="preview-copy">
      <span class="eyebrow">NOTIFICATION CENTER</span>
      <h1>任务与通知<br />下拉面板预览</h1>
      <p>点击右上角铃铛查看任务和通知。<br />任务操作、筛选、关闭与键盘焦点使用项目的实际组件。</p>
      <div class="preview-actions">
        <button @click="sample('success')">完成通知</button
        ><button @click="sample('info')">普通提示</button
        ><button @click="sample('warning')">警告通知</button
        ><button @click="sample('error')">错误与重试</button>
      </div>
      <div class="preview-options">
        <label><input type="checkbox" v-model="dark" /> 深色外观</label
        ><label><input type="checkbox" v-model="reduced" /> 减少动态效果</label
        ><button @click="replay">重置示例</button>
      </div>
      <small class="preview-note">此页使用当前项目的真实通知组件；示例不会写入音乐库。</small>
    </section>
    <AppNoticeHost ref="host" @library="sample('info')" />
  </main>
</template>

<style>
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif;
}
button {
  font: inherit;
  cursor: pointer;
}
.preview {
  --te-app-bg: #f7f8fc;
  --te-surface: #fff;
  --te-text: #202534;
  --te-text-secondary: #727c8e;
  --te-settings-text-muted: #626b78;
  --te-border: #a6afbe;
  --te-primary-500: #8766df;
  --te-titlebar-inset: 52px;
  min-height: 100vh;
  color: var(--te-text);
  background: radial-gradient(ellipse at 10% 75%, #e7dff9, transparent 65%), var(--te-app-bg);
}
.preview.dark {
  --te-app-bg: #15161b;
  --te-surface: #23242c;
  --te-text: #ececf4;
  --te-text-secondary: #9899ae;
  --te-settings-text-muted: #a4a5b8;
  --te-border: #717184;
  --te-primary-500: #b29aef;
  background: radial-gradient(ellipse at 10% 85%, #282239, transparent 65%), var(--te-app-bg);
}
.preview-bar {
  height: 52px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 20px 0 28px;
  border-bottom: 1px solid color-mix(in srgb, var(--te-text) 8%, transparent);
  font-size: 13px;
  letter-spacing: 0.02em;
}
.preview-bar small {
  color: var(--te-text-secondary);
  margin-left: 8px;
}
.bell {
  display: grid;
  place-items: center;
  position: relative;
  width: 36px;
  height: 32px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
}
.bell:hover,
.bell[aria-expanded='true'] {
  background: color-mix(in srgb, var(--te-primary-500) 14%, transparent);
  color: var(--te-primary-500);
}
.bell b {
  position: absolute;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  top: 5px;
  right: 7px;
  background: var(--te-primary-500);
}
.preview-copy {
  padding: 110px 48px 60px;
  max-width: 600px;
}
.eyebrow {
  font-size: 10px;
  letter-spacing: 0.22em;
  color: var(--te-primary-500);
}
h1 {
  font-size: 44px;
  font-weight: 500;
  line-height: 1.4;
  letter-spacing: -0.03em;
  margin: 20px 0;
}
.preview-copy p {
  color: var(--te-text-secondary);
  font-size: 13px;
  line-height: 1.9;
}
.preview-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 36px;
}
.preview-actions button {
  padding: 10px 14px;
  border: 1px solid color-mix(in srgb, var(--te-text) 12%, transparent);
  border-radius: 9px;
  color: var(--te-text);
  background: color-mix(in srgb, var(--te-surface) 70%, transparent);
  font-size: 12px;
}
.preview-actions button:hover {
  border-color: var(--te-primary-500);
}
.preview-options {
  display: flex;
  gap: 16px;
  align-items: center;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--te-text-secondary);
  margin-top: 24px;
}
.preview-options label {
  display: flex;
  align-items: center;
  gap: 5px;
}
.preview-options input {
  accent-color: var(--te-primary-500);
}
.preview-options button {
  border: 0;
  background: transparent;
  color: var(--te-primary-500);
  font-size: 11px;
}
.preview-note {
  display: block;
  margin-top: 42px;
  color: var(--te-text-secondary);
  font-size: 10px;
  line-height: 1.8;
}
@media (max-width: 850px) {
  .preview-copy {
    padding: 60px 28px;
    max-width: 440px;
  }
  h1 {
    font-size: 36px;
  }
}
</style>
