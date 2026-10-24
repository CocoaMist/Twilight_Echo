<script setup lang="ts">
import { onBeforeUnmount } from 'vue'
import type { MusicExplorationReference } from '../../../../shared/musicExploration.ts'
import type { MusicCreditRole } from '../../../../shared/musicCredits.ts'
import { useCoreConnection } from '../../stores/coreConnection.ts'
import MusicTagsPanel from '../music-tags/MusicTagsPanel.vue'
import PersonalPreferencesPanel from '../music-preferences/PersonalPreferencesPanel.vue'
import { creditRoleLabel } from '../music-metadata/musicCreditsView.ts'
import { createMusicExplorationView, observeMusicExplorationView, EXPLORATION_PAGE_SIZE, explorationKindLabel, explorationRoles } from './musicExplorationView.ts'

const props = defineProps<{ entityId?: string; reference?: MusicExplorationReference; scope?: string }>()
const core = useCoreConnection()
const view = createMusicExplorationView({
  detail: (query, signal) => core.query('exploration.detail', query, signal),
  lookup: (query, signal) => core.query('exploration.lookup', query, signal),
  query: (query, signal) => core.query('exploration.query', query, signal),
  relations: (query, signal) => core.query('exploration.relations', query, signal),
  participation: (query, signal) => core.query('exploration.participation', query, signal),
  save: query => core.command('exploration.performance.save', query),
  delete: query => core.command('exploration.performance.delete', query)
})
const { state, ready, canSave } = view
const stop = observeMusicExplorationView(view, {
  entityId: () => props.entityId, reference: () => props.reference, scope: () => props.scope ?? 'music-exploration', snapshot: () => core.state.value
})
const isManualPerformance = (item: NonNullable<typeof state.value.relations>['items'][number]) =>
  item.entity.kind === 'performance' && item.relation.origin === 'manual'
onBeforeUnmount(() => { stop(); view.dispose() })
</script>

<template>
  <section class="music-exploration" aria-label="人物与作品探索" :aria-busy="state.loading || state.saving">
    <header>
      <h3>人物与作品</h3>
      <div class="actions">
        <button v-if="state.trail.length" type="button" :disabled="state.saving" @click="view.back()">返回上一层</button>
        <button type="button" :disabled="state.loading || state.saving" @click="view.refresh()">重新读取关系</button>
      </div>
    </header>
    <p v-if="state.loading" role="status">正在读取人物与作品关系…</p>
    <p v-if="state.saving" role="status">正在保存人工演绎…</p>
    <p v-if="state.blocked" role="status">关系或音乐库已变化，请重新读取；编辑内容已保留。</p>
    <p v-if="state.error" role="alert">{{ state.error }}</p>
    <p v-if="state.notice" role="status">{{ state.notice }}</p>
    <p v-if="state.detail && !state.detail.entity">此明确引用尚无已缓存的关系资料。</p>
    <template v-if="state.detail?.entity">
      <div class="entity-heading">
        <span class="kind">{{ explorationKindLabel[state.detail.entity.kind] }}</span>
        <h4>{{ state.detail.entity.title }}</h4>
        <p v-if="state.detail.entity.artist">{{ state.detail.entity.artist }}</p>
        <p class="hint">{{ state.detail.entity.inLibrary ? `${state.detail.entity.sourceCount} 个实际库内来源` : '外部目录缓存 · 尚无库内参与来源' }}</p>
      </div>
      <div class="filters">
        <label>内容范围<select :value="state.scope" :disabled="!ready" @change="view.setScope(($event.target as HTMLSelectElement).value as 'library' | 'catalog')">
          <option value="library">实际入库内容</option><option value="catalog">已缓存外部目录</option>
        </select></label>
        <label v-if="state.detail.entity.kind === 'artist'">参与角色<select :value="state.role" :disabled="!ready" @change="view.setRole(($event.target as HTMLSelectElement).value as '' | MusicCreditRole)">
          <option value="">全部角色</option><option v-for="role in explorationRoles" :key="role.value" :value="role.value">{{ role.label }}</option>
        </select></label>
        <button v-if="state.detail.entity.kind === 'work'" type="button" :disabled="!ready" @click="view.newPerformance()">建立人工演绎</button>
        <button v-if="state.detail.entity.kind === 'performance' && state.relations?.items.some(item => item.relation.kind === 'work_performance' && item.relation.origin === 'manual')" type="button" :disabled="!ready" @click="view.editPerformance(state.detail!.entity!.id)">编辑此人工演绎</button>
      </div>
      <p v-if="state.scope === 'catalog'" class="hint">仅浏览已缓存目录，不会导入歌曲或发起补全。</p>
      <p v-if="state.detail.providerTruncated || state.relations?.providerTruncated" role="status">来源提供的关系不完整；以下为已取得的部分。</p>
      <p v-if="state.relations && !state.relations.total">当前范围内没有已知关系。</p>
      <ol class="relation-list" aria-label="有序参与与作品关系">
        <li v-for="item in state.relations?.items ?? []" :key="`${item.relation.id}:${item.entity.id}`">
          <div class="relation-main">
            <span class="kind">{{ explorationKindLabel[item.entity.kind] }}</span>
            <button class="entity-link" type="button" :disabled="!ready" @click="view.navigate(item.entity)">{{ item.entity.title }}</button>
            <p v-if="item.entity.artist">{{ item.entity.artist }}</p>
            <p v-if="item.relation.credit" class="credit">
              {{ creditRoleLabel(item.relation.credit) }}<span v-if="item.relation.credit.rawRole && item.relation.credit.direction !== 'forward' && item.relation.credit.role !== 'other' && item.relation.credit.rawRole !== item.relation.credit.role"> · {{ item.relation.credit.rawRole }}</span>
              <span v-if="item.relation.credit.joinphrase"> · {{ item.relation.credit.joinphrase }}</span>
              <span v-for="(attribute, i) in item.relation.credit.attributes" :key="i"> · {{ attribute.name }}{{ attribute.value ? `：${attribute.value}` : '' }}</span>
              <span v-if="item.relation.credit.direction"> · {{ item.relation.credit.direction === 'forward' ? '正向关系' : '反向关系' }}</span>
              <span v-if="item.relation.credit.begin || item.relation.credit.end"> · {{ item.relation.credit.begin || '…' }}–{{ item.relation.credit.end || '…' }}</span>
            </p>
            <p class="hint">{{ item.entity.inLibrary ? `${item.entity.sourceCount} 个库内来源` : '外部目录缓存' }} · {{ item.relation.origin === 'manual' ? '人工关系' : '来源关系' }}<span v-if="item.relation.kind !== 'credit'"> · 顺序 {{ item.relation.order + 1 }}</span></p>
            <p v-if="item.relation.attribution" class="attribution">{{ item.relation.attribution.attribution || item.relation.attribution.provider }}<span v-if="item.relation.attribution.license"> · {{ item.relation.attribution.license }}</span></p>
          </div>
          <div class="actions">
            <button v-if="isManualPerformance(item)" type="button" :disabled="!ready" @click="view.editPerformance(item.entity.id)">编辑演绎</button>
            <button v-if="isManualPerformance(item)" type="button" :disabled="!ready" @click="view.requestDelete(item.entity.id)">删除演绎</button>
          </div>
        </li>
      </ol>
      <nav v-if="state.relations && state.relations.total > EXPLORATION_PAGE_SIZE" aria-label="参与与关系分页">
        <button type="button" :disabled="!ready || !state.relations.offset" @click="view.page(state.relations!.offset - EXPLORATION_PAGE_SIZE)">上一页关系</button>
        <span>{{ state.relations.offset + 1 }}–{{ state.relations.offset + state.relations.items.length }} / {{ state.relations.total }}</span>
        <button type="button" :disabled="!ready || state.relations.offset + state.relations.items.length >= state.relations.total" @click="view.page(state.relations!.offset + EXPLORATION_PAGE_SIZE)">下一页关系</button>
      </nav>
      <MusicTagsPanel v-if="state.detail.entity.kind === 'artist' || state.detail.entity.kind === 'work'" :key="`tags:${state.detail.entity.id}`" :entity-id="state.detail.entity.id" :scope="scope" :label="explorationKindLabel[state.detail.entity.kind]" />
      <PersonalPreferencesPanel v-if="state.detail.entity.kind === 'artist' || state.detail.entity.kind === 'work'" :key="`preferences:${state.detail.entity.id}`" :entity-id="state.detail.entity.id" :scope="scope" :label="explorationKindLabel[state.detail.entity.kind]" />
    </template>

    <section v-if="state.editor" class="performance-editor" aria-label="人工演绎编辑">
      <header><h4>{{ state.editor.id ? '编辑人工演绎' : '新建人工演绎' }}</h4><button type="button" :disabled="state.saving" @click="view.cancelEditor()">取消编辑</button></header>
      <label>演绎名称<input :value="state.editor.title" maxlength="512" :disabled="state.saving" @input="view.title(($event.target as HTMLInputElement).value)" /></label>
      <p class="hint">逐条加入明确录音并排列乐章；同一作品的不同演绎分别保存。</p>
      <ol aria-label="已选录音顺序">
        <li v-for="(item, index) in state.editor.recordings" :key="`${index}:${item.id}`">
          <span>{{ index + 1 }}. {{ item.title }}<small v-if="item.artist"> · {{ item.artist }}</small></span>
          <div class="actions"><button type="button" :disabled="!ready || index === 0" :aria-label="`上移录音 ${index + 1}`" @click="view.moveRecording(index, -1)">上移</button><button type="button" :disabled="!ready || index === state.editor.recordings.length - 1" :aria-label="`下移录音 ${index + 1}`" @click="view.moveRecording(index, 1)">下移</button><button type="button" :disabled="!ready" :aria-label="`移除录音 ${index + 1}`" @click="view.removeRecording(index)">移除</button></div>
        </li>
      </ol>
      <form class="filters" @submit.prevent="view.choose(0, true)">
        <label>查找录音<input :value="state.pickerSearch" maxlength="512" :disabled="!ready" @input="view.pickerSearch(($event.target as HTMLInputElement).value)" /></label>
        <label>录音范围<select :value="state.pickerScope" :disabled="!ready" @change="view.pickerScope(($event.target as HTMLSelectElement).value as 'library' | 'catalog')"><option value="library">实际入库录音</option><option value="catalog">已缓存目录录音</option></select></label>
        <button type="submit" :disabled="!ready || state.pickerLoading">查找录音</button>
      </form>
      <p v-if="state.pickerLoading" role="status">正在读取录音…</p>
      <p v-if="state.picker && !state.picker.total">没有匹配的明确录音。</p>
      <ul class="picker-list">
        <li v-for="item in state.picker?.items ?? []" :key="item.id"><span>{{ item.title }} · {{ item.artist || '未知艺人' }}<small> · {{ item.inLibrary ? '库内' : '目录缓存' }} · {{ item.id }}</small></span><button type="button" :disabled="!ready || state.editor.recordings.length >= 200" :aria-label="`加入录音 ${item.id}`" @click="view.addRecording(item)">加入此录音</button></li>
      </ul>
      <nav v-if="state.picker && state.picker.total > EXPLORATION_PAGE_SIZE" aria-label="录音选择分页"><button type="button" :disabled="!ready || state.pickerLoading || !state.picker.offset" @click="view.choose(state.picker!.offset - EXPLORATION_PAGE_SIZE)">上一页录音</button><span>{{ state.picker.offset + 1 }}–{{ state.picker.offset + state.picker.items.length }} / {{ state.picker.total }}</span><button type="button" :disabled="!ready || state.pickerLoading || state.picker.offset + state.picker.items.length >= state.picker.total" @click="view.choose(state.picker!.offset + EXPLORATION_PAGE_SIZE)">下一页录音</button></nav>
      <button type="button" :disabled="!canSave" @click="view.save()">保存人工演绎</button>
    </section>
    <section v-if="state.deleteId" class="delete-confirmation" aria-label="删除人工演绎确认"><p>删除此人工演绎的关系？原录音与作品仍保留。</p><div class="actions"><button type="button" :disabled="!ready || state.uncertain" @click="view.confirmDelete()">确认删除演绎</button><button type="button" :disabled="state.saving" @click="view.cancelDelete()">保留演绎</button></div></section>
    <div v-if="state.uncertain" class="unknown-receipt"><p role="status">上次提交结果未知。请先重新读取并核对关系，避免重复建立演绎。</p><button type="button" :disabled="!ready" @click="view.acknowledgeUnknown()">已核对关系，允许手动提交</button></div>
  </section>
</template>

<style scoped>
.music-exploration { line-height: 1.65; overflow-wrap: anywhere; color: var(--te-neutral-900); }
header, .actions, .filters, nav { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
header { justify-content: space-between; }
h3, h4, p { margin: 8px 0; }
h3 { font-size: 1.2em; } h4 { font-size: 1.05em; }
.entity-heading { padding: 8px 0; } .entity-heading h4 { font-size: 1.4em; }
.hint, .attribution, small, .kind { color: var(--te-neutral-500); }
.kind { font-size: 0.9em; }
.relation-list, .picker-list { padding: 0; list-style: none; }
.relation-list > li, .picker-list > li, .performance-editor li { display: flex; flex-wrap: wrap; align-items: start; justify-content: space-between; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--te-card-border); }
.relation-main { flex: 1; min-width: min(220px, 100%); }
.relation-main p { margin: 3px 0; }
button, input, select { padding: 6px 10px; font: inherit; color: inherit; border: 1px solid var(--te-card-border); border-radius: 6px; background: transparent; }
button { cursor: pointer; color: var(--te-primary-600); } button:disabled { opacity: 0.45; cursor: default; }
button:not(:disabled):hover { background: var(--te-hover-bg); }
button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--te-primary-500); outline-offset: 3px; }
.entity-link { margin-left: 8px; padding: 0; border: 0; font-weight: 600; text-align: left; }
label { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; } input { min-width: 0; max-width: 100%; }
.performance-editor, .delete-confirmation, .unknown-receipt { margin-top: 20px; padding-top: 12px; border-top: 1px solid var(--te-card-border); }
.performance-editor > label input { flex: 1; } .performance-editor ol { padding-left: 20px; }
nav { margin: 12px 0; }
</style>
