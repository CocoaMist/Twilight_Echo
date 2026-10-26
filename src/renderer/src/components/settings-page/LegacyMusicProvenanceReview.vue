<script setup lang="ts">
import { ref, watch } from 'vue'
import type { InstalledExperience } from '../../../../shared/pluginExperience.ts'
import type { LegacyMusicProvenanceItem, LegacyMusicProvenancePage } from '../../../../shared/legacyMusicMetadata.ts'
import { useCoreConnection } from '../../stores/coreConnection.ts'

const core = useCoreConnection()
const plugins = ref<Array<{ id: string; name: string }>>([])
const pluginId = ref('')
const page = ref<LegacyMusicProvenancePage | null>(null)
const includeReviewed = ref(false)
const busy = ref(false)
const error = ref('')
const message = ref('')
const uncertain = ref(false)
const limit = 10
const epoch = () => core.state.value?.epoch
watch(epoch, () => {
  page.value = null
  plugins.value = []
  uncertain.value = true
  message.value = ''
}, { flush: 'sync' })
async function run(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  message.value = ''
  try { await action() }
  catch (e) { error.value = e instanceof Error ? e.message : '读取旧正文失败，请重新读取' }
  finally { busy.value = false }
}
async function list(offset = 0) {
  const expectedEpoch = epoch()
  const result = await core.command('extensions.music', {
    id: pluginId.value, operation: 'provenance.list', args: { offset, limit, includeReviewed: includeReviewed.value }
  }) as LegacyMusicProvenancePage
  if (expectedEpoch !== epoch()) throw new Error('Core 已重新连接，请重新读取旧正文清单')
  page.value = result
  uncertain.value = false
}
function open() {
  void run(async () => {
    const expectedEpoch = epoch()
    const experiences = await core.query('extensions.experiences', {}) as InstalledExperience[]
    if (expectedEpoch !== epoch()) throw new Error('Core 已重新连接，请重新读取旧正文清单')
    const unique = new Map<string, string>()
    for (const experience of experiences) if (experience.permissions.includes('library:write')) unique.set(experience.pluginId, experience.name)
    plugins.value = Array.from(unique, ([id, name]) => ({ id, name }))
    if (!plugins.value.some(plugin => plugin.id === pluginId.value)) pluginId.value = plugins.value[0]?.id ?? ''
    if (pluginId.value) await list()
    else { page.value = null; message.value = '没有已启用的音乐资料扩展。请先启用原资料扩展，再读取旧正文。' }
  })
}
function refresh(offset = 0) { void run(() => list(offset)) }
function changePlugin() { page.value = null; refresh() }
function expand(item: LegacyMusicProvenanceItem) {
  void run(async () => {
    const expectedEpoch = epoch()
    const result = await core.command('extensions.music', {
      id: pluginId.value, operation: 'provenance.read', args: { albumId: item.albumId, snapshotRevision: item.snapshotRevision }
    }) as { revision: number; item: LegacyMusicProvenanceItem }
    if (expectedEpoch !== epoch()) throw new Error('Core 已重新连接，请重新读取旧正文清单')
    if (result.revision !== page.value?.revision) {
      uncertain.value = true
      throw new Error('资料已变化，请重新读取清单后复核')
    }
    Object.assign(item, result.item)
  })
}
function review(item: LegacyMusicProvenanceItem, disposition: 'manual' | 'excluded') {
  if (!page.value || uncertain.value || item.truncated) return
  void run(async () => {
    const expectedEpoch = epoch()
    try {
      await core.command('extensions.music', {
        id: pluginId.value, operation: 'provenance.review', args: {
          expectedRevision: page.value!.revision, albumId: item.albumId,
          snapshotRevision: item.snapshotRevision, description: item.description, disposition
        }
      })
    } catch (e) {
      uncertain.value = true
      throw e
    }
    uncertain.value = true
    if (expectedEpoch !== epoch()) throw new Error('Core 已重新连接，请重新读取旧正文清单')
    await list(page.value!.offset)
    message.value = disposition === 'manual' ? '已确认该版本正文可随音乐整理迁移' : '已排除该版本正文，原资料仍保留在本机'
  })
}
</script>

<template>
  <details class="legacy-review">
    <summary>复核旧正文出处</summary>
    <p>旧正文可能沿用平台来源标记。仅将自己撰写或有权迁移的正文标为可迁移；平台受限正文应排除。当前正文与每个历史版本分别确认，原文不会被修改。</p>
    <button type="button" :disabled="busy" @click="open">读取旧正文清单</button>
    <template v-if="plugins.length">
      <label>资料扩展
        <select v-model="pluginId" :disabled="busy" @change="changePlugin">
          <option v-for="plugin in plugins" :key="plugin.id" :value="plugin.id">{{ plugin.name }}</option>
        </select>
      </label>
      <label><input v-model="includeReviewed" type="checkbox" :disabled="busy" @change="refresh()">包含已处理正文</label>
    </template>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="uncertain" role="alert">操作结果或资料版本待确认。请重新读取清单核对，不要重复提交。</p>
    <template v-if="page">
      <p role="status">{{ includeReviewed ? '符合条件的' : '待复核' }}正文 {{ page.total }} 条</p>
      <article v-for="item in page.items" :key="`${item.albumId}:${item.snapshotRevision}`">
        <strong>{{ item.title }}</strong>
        <p>{{ item.snapshotRevision === -1 ? '当前正文' : `历史版本 ${item.snapshotRevision}` }} · {{ item.sourceName || '旧来源未注明名称' }} · {{ item.disposition === 'manual' ? '可迁移' : item.disposition === 'excluded' ? '已排除' : '待复核' }}</p>
        <pre>{{ item.description }}</pre>
        <p v-if="item.truncated">此处为正文预览。展开全文后才能确认。</p>
        <div class="review-actions">
          <button v-if="item.truncated" type="button" :disabled="busy" @click="expand(item)">展开全文</button>
          <button type="button" :disabled="busy || uncertain || item.truncated || item.disposition === 'manual'" @click="review(item, 'manual')">确认有权迁移</button>
          <button type="button" :disabled="busy || uncertain || item.truncated || item.disposition === 'excluded'" @click="review(item, 'excluded')">排除出备份</button>
        </div>
      </article>
      <nav aria-label="旧正文清单分页">
        <button type="button" :disabled="busy || page.offset === 0" @click="refresh(Math.max(0, page.offset - limit))">上一页</button>
        <button type="button" :disabled="busy || page.offset + page.items.length >= page.total" @click="refresh(page.offset + limit)">下一页</button>
        <button type="button" :disabled="busy" @click="refresh()">重新读取清单</button>
      </nav>
    </template>
  </details>
</template>

<style scoped>
.legacy-review { margin-top: 16px; }
summary { cursor: pointer; }
p { color: var(--te-settings-text-muted); font-size: 13px; line-height: 1.6; }
label { display: inline-flex; gap: 6px; align-items: center; margin: 12px 16px 0 0; }
article { margin: 16px 0; padding: 16px 0; border-top: 1px solid var(--te-card-border); }
pre { max-height: 300px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-size: 14px; line-height: 1.7; }
.review-actions, nav { display: flex; gap: 8px; flex-wrap: wrap; }
button, select { font: inherit; padding: 7px 12px; border: 1px solid var(--te-card-border); border-radius: 8px; color: var(--te-settings-text); background: var(--te-card-bg); cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid var(--te-primary-500); outline-offset: 2px; }
</style>
