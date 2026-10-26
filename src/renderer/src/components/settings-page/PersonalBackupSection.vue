<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  PERSONAL_DOMAINS,
  personalDomainLabel,
  type PersonalDomain,
  type PathMapping
} from '../../../../shared/personalBackup'
import type { CorePersonalBackupPreview } from '../../../../shared/coreBackup.ts'
import { useCoreConnection } from '../../stores/coreConnection.ts'
import { useFocusTrap, useEscapeToClose } from '../../app/useDismissLayer'
import LegacyMusicProvenanceReview from './LegacyMusicProvenanceReview.vue'

const api = window.api
const core = useCoreConnection()
const recoveryAvailable = computed(() => core.state?.value?.personalBackupRecovery === true)
const busy = ref(false),
  error = ref(''),
  message = ref(''),
  staged = ref(false)
const preview = ref<CorePersonalBackupPreview | null>(null)
const selected = ref<PersonalDomain[]>([])
const exportSelected = ref<PersonalDomain[]>([...PERSONAL_DOMAINS])
const mappings = ref<PathMapping[]>([])
const conflict = ref<'keep-local' | 'use-backup'>('keep-local')
const reviewedOptions = ref('')
const stageUncertain = ref(false)
function restoreOptions() {
  return {
    conflict: conflict.value,
    mappings: mappings.value.filter((m) => m.to).map(({ from, to }) => ({ from, to })),
    domains: [...selected.value]
  }
}
const needsReview = computed(() => preview.value?.version === 2 &&
  (stageUncertain.value || reviewedOptions.value !== JSON.stringify(restoreOptions())))
const referenceConflict = computed(() => selected.value.includes('music') &&
  (!!preview.value?.music?.referenceConflicts?.length ||
    preview.value?.music?.dependencies.includes('music:identity-reference-conflict')))
function musicDependencyLabel(key: string): string {
  const labels: Record<string, string> = {
    'library:missing-sources': '部分歌曲来源尚未在本机入库，将保留离线资料，待来源可用后再绑定。',
    'music:identity-reference-conflict': '存在身份引用、名称或流派层级冲突。请先修正对应对象，再更新预览。',
    'genres:dictionary': '流派字典及用户分类修改会一并核对。',
    'genres:cross-dictionary': '字典版本不同：本机内置定义保持不变，新增节点与用户修改按冲突策略恢复。别名标准化版本不支持时会阻止恢复。'
  }
  return labels[key] || ''
}
function musicConflictKindLabel(kind: string): string {
  return ({ tag: '标签', focus: 'Focus', genre: '流派', 'genre-alias': '流派别名', artist: '人物', recording: '录音',
    release: '发行', album_project: '专辑项目', work: '作品', performance: '演绎' } as Record<string, string>)[kind] || '对象'
}
const root = ref<HTMLElement | null>(null)
useFocusTrap(root, () => !!preview.value)
useEscapeToClose(
  () => !!preview.value && !busy.value,
  () => {
    preview.value = null
  }
)
async function run(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  message.value = ''
  try {
    await action()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '操作失败，请重试'
  } finally {
    busy.value = false
  }
}
function exportBackup() {
  void run(async () => {
    if (!exportSelected.value.length) throw new Error('请至少选择一个导出项目')
    const all = PERSONAL_DOMAINS.every(domain => exportSelected.value.includes(domain))
    if (await core.command('backup.export', all ? {} : { domains: [...exportSelected.value] }))
      message.value = '个人数据备份已导出'
  })
}
function importBackup() {
  void run(async () => {
    const value = (await core.command('backup.preview', {})) as CorePersonalBackupPreview | null
    preview.value = value
    selected.value = value?.rows.map((r) => r.domain) || []
    mappings.value = value?.roots.map((from) => ({ from, to: '' })) || []
    conflict.value = 'keep-local'
    stageUncertain.value = false
    reviewedOptions.value = JSON.stringify(restoreOptions())
  })
}
function recoverBackup() {
  void run(async () => {
    const value = await core.command('backup.recover', {}) as CorePersonalBackupPreview | null
    preview.value = value
    selected.value = value?.rows.map(row => row.domain) || []
    mappings.value = value?.roots.map(from => ({ from, to: '' })) || []
    conflict.value = 'keep-local'
    stageUncertain.value = false
    reviewedOptions.value = JSON.stringify(restoreOptions())
    if (!value) message.value = '没有待复核的恢复请求'
  })
}
function updatePreview() {
  void run(async () => {
    const options = restoreOptions()
    const value = await core.command('backup.repreview', { id: preview.value!.id, options }) as CorePersonalBackupPreview
    preview.value = value
    reviewedOptions.value = JSON.stringify(options)
    stageUncertain.value = false
  })
}
async function chooseMapping(mapping: PathMapping) {
  await run(async () => {
    const path = (await core.command('backup.chooseFolder', {})) as string | null
    if (path) mapping.to = path
  })
}
function restore() {
  void run(async () => {
    if (needsReview.value) throw new Error('选择已变化，请先更新预览')
    if (referenceConflict.value) throw new Error('请先处理音乐整理的引用、名称或流派层级冲突，再更新预览')
    try {
      await core.command('backup.stage', { id: preview.value!.id, options: restoreOptions() })
    } catch (e) {
      if (preview.value?.version === 2) stageUncertain.value = true
      throw e
    }
    preview.value = null
    staged.value = true
    message.value = '恢复已安排。请重启应用，启动时会先备份当前数据并执行恢复。'
  })
}
</script>
<template>
  <div data-setting-id="personal-backup" id="setting-personal-backup" class="personal-backup">
    <strong>个人数据备份与迁移</strong>
    <p>
      将收藏、评分、标签、资料关联与其他个人数据迁到新电脑。音频文件、账号登录和插件不随备份迁移；设置可单独导出。
    </p>
    <details class="export-options">
      <summary>选择导出项目（默认全部）</summary>
      <div class="domain-options">
        <label v-for="domain in PERSONAL_DOMAINS" :key="domain">
          <input v-model="exportSelected" type="checkbox" :value="domain" :disabled="busy || staged" />
          {{ personalDomainLabel(domain, 2) }}
        </label>
      </div>
      <p>总容量上限 180 MiB。超限时可减少导出项目，再次导出。</p>
    </details>
    <p>新版备份使用 v2，需新版应用读取；回退旧版本请使用升级前快照。</p>
    <p>手工图片会随音乐整理备份；出处未确认的旧正文不会导出，可在下方复核。迁移时请同时保留原库快照。</p>
    <LegacyMusicProvenanceReview />
    <p v-if="recoveryAvailable" role="status">上次恢复前音乐数据发生变化，尚未覆盖本机数据。请重新预览后确认。</p>
    <div class="buttons">
      <button type="button" :disabled="busy || staged || !exportSelected.length" @click="exportBackup">导出个人数据</button
      ><button type="button" :disabled="busy || staged" @click="importBackup">选择备份并预览</button
      ><button v-if="recoveryAvailable" type="button" :disabled="busy || staged" @click="recoverBackup">查看待复核恢复</button
      ><button v-if="staged" type="button" :disabled="busy" @click="run(() => api.app.relaunch())">
        现在重启恢复
      </button>
    </div>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="error && !preview" role="alert">{{ error }}</p>
    <Teleport to="body"
      ><div v-if="preview" class="restore-overlay">
        <section
          ref="root"
          class="restore-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="restore-title"
          tabindex="-1"
        >
          <h2 id="restore-title">恢复预览</h2>
          <p>
            备份时间：{{ new Date(preview.createdAt).toLocaleString() }} · 格式版本
            {{ preview.version }}
          </p>
          <p>
            只恢复勾选的项目；未冲突的记录会合并保留。同一歌单、队列会话、播客订阅按整条记录处理。当前播放队列和版本关系按完整文档处理。
          </p>
          <table>
            <thead>
              <tr>
                <th>恢复项目</th>
                <th>备份</th>
                <th>本机</th>
                <th>身份重叠</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in preview.rows" :key="row.domain">
                <td>
                  <label
                    ><input
                      v-model="selected"
                      type="checkbox"
                      :value="row.domain"
                      :disabled="busy"
                    />{{ personalDomainLabel(row.domain, preview.version) }}</label
                  >
                </td>
                <td>{{ row.incoming }}</td>
                <td>{{ preview.version === 2 && !selected.includes(row.domain) ? '—' : row.current }}</td>
                <td>{{ preview.version === 2 && !selected.includes(row.domain) ? '—' : row.conflicts }}</td>
              </tr>
            </tbody>
          </table>
          <section v-if="selected.includes('music') && preview.music" class="music-preview" aria-labelledby="music-preview-title">
            <h3 id="music-preview-title">收藏与音乐整理</h3>
            <p>本项数量包含资料锚点、关联与历史记录，不代表歌曲数。</p>
            <p>
              可映射实体 {{ preview.music.mappedEntities }}，待绑定实体 {{ preview.music.unbound }}，
              缺少来源 {{ preview.music.missingSources }}，重叠记录 {{ preview.music.conflicts }}。
            </p>
            <template v-for="dependency in preview.music.dependencies" :key="dependency">
              <p v-if="musicDependencyLabel(dependency)">{{ musicDependencyLabel(dependency) }}</p>
            </template>
            <details v-if="preview.music.referenceConflicts.length">
              <summary>查看冲突对象（最多 100 项）</summary>
              <ul>
                <li v-for="item in preview.music.referenceConflicts" :key="`${item.kind}:${item.incomingId}`">
                  <strong>{{ musicConflictKindLabel(item.kind) }}：{{ item.title || item.incomingId }}</strong>
                  <p class="mapping">备份对象：{{ item.incomingId }}<br />{{ ['tag', 'focus', 'genre'].includes(item.kind) ? '本机整理项' : '本机身份' }}：{{ item.targetIds.join('、') }}</p>
                </li>
              </ul>
            </details>
            <p>缺少音频时保留离线资料；仅按明确来源或外部 ID 绑定，不按同名匹配。</p>
          </section>
          <p v-for="dependency in preview.dependencies" :key="`${dependency.domain}:${dependency.requires}`">
            {{ dependency.reason }}
          </p>
          <label class="conflict"
            >冲突处理
            <select v-model="conflict" :disabled="busy">
              <option value="keep-local">保留本机记录</option>
              <option value="use-backup">使用备份记录</option>
            </select></label
          >
          <p v-if="preview.version !== 2">
            统计按日期和曲目合并，不相加，避免重复计算。预览是当前快照；重启恢复时会按所选规则与最新保存记录合并。
          </p>
          <p v-if="preview.version === 2">
            音乐整理按稳定目标和字段处理冲突；明确清空、拒绝和解除关联也会按所选规则恢复。
            只恢复“歌单”不改变现有收藏；未选择“收藏与音乐整理”会保留本机音乐整理。
          </p>
          <p v-if="preview.version === 2">预览后音乐数据再次变化时，恢复会暂停供你重新核对。统计按日期和曲目合并，不相加。</p>
          <div v-if="mappings.length">
            <h3>音乐路径映射</h3>
            <p>
              更换电脑或盘符时，为每个原目录选择新位置。原目录尚未授权时也需要重新选择。这里只更新引用，不移动音频。
            </p>
            <p v-if="preview.rootsTruncated">这里只列出前 100 个目录；未映射的来源引用仍会保留为离线资料。</p>
            <div v-for="mapping in mappings" :key="mapping.from" class="mapping">
              <span>{{ mapping.from }}</span
              ><button type="button" :disabled="busy" @click="chooseMapping(mapping)">
                {{ mapping.to || '选择此目录在本机的位置' }}
              </button>
            </div>
          </div>
          <p v-if="stageUncertain" role="alert">恢复安排结果未确认，请更新预览核对；不要重复提交。</p>
          <p v-else-if="needsReview" role="status">选择已变化，请更新预览后再确认恢复。</p>
          <p v-if="error" role="alert">{{ error }}</p>
          <div class="buttons">
            <button type="button" :disabled="busy" @click="preview = null">取消</button
            ><button v-if="preview.version === 2" type="button" :disabled="busy || !selected.length" @click="updatePreview">更新预览</button
            ><button type="button" :disabled="busy || !selected.length || needsReview || referenceConflict" @click="restore">
              确认，在下次启动时恢复
            </button>
          </div>
        </section>
      </div></Teleport
    >
  </div>
</template>
<style scoped>
.personal-backup {
  padding: 14px 16px;
}
.personal-backup > strong {
  color: var(--te-settings-text);
  font-size: calc(var(--te-font-size-body, 14px) * 15 / 14);
  font-weight: 500;
}
.personal-backup > p {
  color: var(--te-settings-text-muted);
  font-size: calc(var(--te-font-size-body, 14px) * 12 / 14);
  opacity: 1;
}
p {
  font-size: 13px;
  line-height: 1.6;
  opacity: 0.8;
}
.buttons {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.domain-options {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 8px 16px;
  margin-top: 12px;
}
.domain-options label {
  display: flex;
  align-items: center;
  gap: 6px;
}
.export-options summary { cursor: pointer; }
.music-preview { margin-top: 16px; }
button,
select {
  font: inherit;
  padding: 6px 10px;
  cursor: pointer;
}
.restore-overlay {
  position: fixed;
  inset: 0;
  z-index: 2200;
  background: var(--te-dialog-backdrop);
  display: grid;
  place-items: center;
  padding: 24px;
}
.restore-dialog {
  width: min(740px, 100%);
  padding: 24px;
  max-height: 85dvh;
  overflow: auto;
  border-radius: 16px;
  color: var(--te-settings-text);
  background: var(--te-app-bg);
}
table {
  border-collapse: collapse;
  width: 100%;
  text-align: left;
  font-size: 13px;
}
td,
th {
  padding: 8px;
  border-bottom: 1px solid var(--te-card-border);
}
.conflict {
  display: block;
  margin-top: 16px;
}
.mapping {
  display: grid;
  gap: 8px;
  padding: 8px 0;
  overflow-wrap: anywhere;
}
button,
select {
  border: 1px solid var(--te-card-border);
  border-radius: 8px;
  background: var(--te-card-bg);
  color: var(--te-settings-text);
  padding: 7px 12px;
}
button:hover {
  background: var(--te-hover-bg);
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
button:focus-visible,
select:focus-visible,
input:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 2px;
}
</style>
