<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import type { GenreMutationResult } from '../../../../shared/musicGenres.ts'
import { useCoreConnection } from '../../stores/coreConnection.ts'
import { createGenreWorkspaceView, GENRE_WORKSPACE_PAGE_SIZE } from './genreWorkspaceView.ts'

const emit = defineEmits<{ changed: [] }>()
const core = useCoreConnection()
const view = createGenreWorkspaceView({
  tree: (query, signal) => core.query('genres.tree', query, signal),
  unmapped: (query, signal) => core.query('genres.unmapped', query, signal),
  edit: async (request) => (await core.command('genres.edit', request)) as GenreMutationResult,
  map: async (request) => (await core.command('genres.map', request)) as GenreMutationResult,
  changed: () => emit('changed')
})
const { state, busy, ready, canSave, canMap } = view
const treeSearch = ref(''),
  rawSearch = ref('')
watch(
  () => core.state.value?.epoch,
  (epoch) => view.setScope(String(epoch)),
  { immediate: true }
)
watch(
  () => core.state.value?.genresRevision,
  (revision) => view.observeRevision(revision)
)
watch(
  () => state.value.search,
  (value) => {
    treeSearch.value = value
  }
)
onBeforeUnmount(view.dispose)
</script>

<template>
  <section class="genre-workspace" aria-label="流派整理" :aria-busy="busy">
    <button
      type="button"
      class="workspace-toggle"
      :aria-expanded="state.opened"
      :disabled="state.saving"
      @click="view.toggle()"
    >
      {{ state.opened ? '收起流派整理' : '整理流派与未映射原词' }}
    </button>
    <template v-if="state.opened">
      <header class="workspace-heading">
        <p>维护层级，并把不同来源的原词归入同一流派。</p>
        <button type="button" :disabled="busy" @click="view.refresh()">重新读取分类</button>
      </header>
      <p v-if="state.error" role="alert">{{ state.error }}</p>
      <p v-if="state.notice" role="status">{{ state.notice }}</p>
      <p v-if="state.saving" role="status">正在保存分类…</p>
      <div class="workspace-columns">
        <section aria-label="流派层级" class="genre-browser">
          <header>
            <h4>流派层级</h4>
            <button type="button" :disabled="!ready" @click="view.create()">新增流派</button>
          </header>
          <form class="search-controls" @submit.prevent="view.search(treeSearch)">
            <label
              >查找流派<input
                v-model="treeSearch"
                type="search"
                maxlength="512"
                :disabled="busy"
                placeholder="名称或英文名"
            /></label>
            <button type="submit" :disabled="busy">查找</button>
            <button v-if="state.search" type="button" :disabled="busy" @click="view.search('')">
              清除查找
            </button>
          </form>
          <nav class="breadcrumbs" aria-label="流派层级路径">
            <button type="button" :disabled="busy" @click="view.browse(null)">根流派</button>
            <template v-for="(ancestor, index) in state.breadcrumbs" :key="ancestor.id">
              <span aria-hidden="true">/</span>
              <button type="button" :disabled="busy" @click="view.breadcrumb(index)">
                {{ ancestor.name }}
              </button>
            </template>
            <span v-if="state.search">/ 全层级查找</span>
          </nav>
          <p v-if="state.pickingParent" role="status">在下方选择上级，可进入子流派或查找名称。</p>
          <p v-if="state.loadingTree" role="status">正在读取流派…</p>
          <p v-if="state.treeError" role="alert">{{ state.treeError }}</p>
          <p v-else-if="state.tree && !state.tree.total">此层级暂无流派。</p>
          <ul class="genre-nodes">
            <li v-for="node in state.tree?.items ?? []" :key="node.id">
              <div class="node-heading">
                <button
                  type="button"
                  class="node-name"
                  :disabled="busy"
                  :aria-pressed="state.draft?.genreId === node.id"
                  @click="view.select(node)"
                >
                  <strong>{{ node.name }}</strong
                  ><span v-if="node.nameEn !== node.name">{{ node.nameEn }}</span>
                </button>
                <button
                  v-if="node.childCount"
                  type="button"
                  :disabled="busy"
                  :aria-label="`查看 ${node.name} 的子流派`"
                  @click="view.browse(node)"
                >
                  下一级（{{ node.childCount }}）
                </button>
              </div>
              <div class="node-actions">
                <span v-if="state.search">第 {{ node.ancestorIds.length + 1 }} 层</span>
                <span v-if="node.userModified">已自定义</span>
                <button
                  v-if="state.pickingParent"
                  type="button"
                  :disabled="!ready || !view.parentAllowed(node)"
                  @click="view.setParent(node)"
                >
                  用作上级
                </button>
                <button
                  v-if="state.selectedRaw"
                  type="button"
                  :disabled="!ready"
                  :aria-pressed="state.mapTarget?.id === node.id"
                  @click="view.chooseMapTarget(node)"
                >
                  用作映射目标
                </button>
              </div>
            </li>
          </ul>
          <nav
            v-if="state.tree && state.tree.total > GENRE_WORKSPACE_PAGE_SIZE"
            class="pagination"
            aria-label="流派分页"
          >
            <button
              type="button"
              :disabled="busy || !state.treeOffset"
              @click="view.treePage(state.treeOffset - GENRE_WORKSPACE_PAGE_SIZE)"
            >
              上一页流派
            </button>
            <span
              >{{ state.tree.offset + 1 }}–{{ state.tree.offset + state.tree.items.length }} /
              {{ state.tree.total }}</span
            >
            <button
              type="button"
              :disabled="busy || state.tree.offset + state.tree.items.length >= state.tree.total"
              @click="view.treePage(state.treeOffset + GENRE_WORKSPACE_PAGE_SIZE)"
            >
              下一页流派
            </button>
          </nav>
          <form
            v-if="state.draft"
            class="genre-editor"
            aria-label="编辑流派"
            @submit.prevent="view.save()"
          >
            <h5>
              {{
                state.draft.mode === 'update'
                  ? '编辑流派'
                  : state.draft.mode === 'createMap'
                    ? '新建并映射原词'
                    : '新增流派'
              }}
            </h5>
            <label
              >显示名称<input
                :value="state.draft.name"
                maxlength="512"
                required
                :disabled="state.saving"
                @input="view.patchDraft({ name: ($event.target as HTMLInputElement).value })"
            /></label>
            <label
              >英文名称<input
                :value="state.draft.nameEn"
                maxlength="512"
                required
                :disabled="state.saving"
                @input="view.patchDraft({ nameEn: ($event.target as HTMLInputElement).value })"
            /></label>
            <p>上级：{{ state.draft.parentLabel }}</p>
            <div class="editor-actions">
              <button type="button" :disabled="!ready" @click="view.pickParent()">选择上级</button>
              <button type="button" :disabled="!ready" @click="view.setParent(null)">
                不设上级
              </button>
              <button type="submit" :disabled="!canSave">
                {{ state.draft.mode === 'createMap' ? '创建并映射' : '保存流派' }}
              </button>
              <button type="button" :disabled="state.saving" @click="view.cancelDraft()">
                取消编辑
              </button>
            </div>
          </form>
        </section>
        <section aria-label="未映射原词" class="unmapped-browser">
          <header>
            <h4>未映射原词</h4>
            <span v-if="state.unmapped">{{ state.unmapped.total }} 项</span>
          </header>
          <form
            class="search-controls"
            @submit.prevent="view.filterRaw(rawSearch, state.includeIgnored)"
          >
            <label
              >查找原词<input
                v-model="rawSearch"
                type="search"
                maxlength="512"
                :disabled="busy"
                placeholder="保留的原始分类"
            /></label>
            <button type="submit" :disabled="busy">查找原词</button>
          </form>
          <label class="ignored-filter"
            ><input
              type="checkbox"
              :checked="state.includeIgnored"
              :disabled="busy"
              @change="view.filterRaw(rawSearch, ($event.target as HTMLInputElement).checked)"
            />显示已忽略</label
          >
          <p v-if="state.loadingUnmapped" role="status">正在读取原词…</p>
          <p v-if="state.unmappedError" role="alert">{{ state.unmappedError }}</p>
          <p v-else-if="state.unmapped && !state.unmapped.total">此筛选下没有待整理原词。</p>
          <ul class="raw-values">
            <li
              v-for="raw in state.unmapped?.items ?? []"
              :key="JSON.stringify([raw.provider, raw.normalized])"
            >
              <button
                type="button"
                :disabled="!ready"
                :aria-pressed="
                  state.selectedRaw?.provider === raw.provider &&
                  state.selectedRaw?.normalized === raw.normalized
                "
                @click="view.selectRaw(raw)"
              >
                <strong>{{ raw.value }}</strong
                ><span
                  >来源：{{ raw.provider }} · {{ raw.targetCount }} 个条目<template
                    v-if="raw.ignored"
                  >
                    · 已忽略</template
                  ></span
                >
              </button>
            </li>
          </ul>
          <nav
            v-if="state.unmapped && state.unmapped.total > GENRE_WORKSPACE_PAGE_SIZE"
            class="pagination"
            aria-label="原词分页"
          >
            <button
              type="button"
              :disabled="busy || !state.unmappedOffset"
              @click="view.rawPage(state.unmappedOffset - GENRE_WORKSPACE_PAGE_SIZE)"
            >
              上一页原词
            </button>
            <span
              >{{ state.unmapped.offset + 1 }}–{{
                state.unmapped.offset + state.unmapped.items.length
              }}
              / {{ state.unmapped.total }}</span
            >
            <button
              type="button"
              :disabled="
                busy || state.unmapped.offset + state.unmapped.items.length >= state.unmapped.total
              "
              @click="view.rawPage(state.unmappedOffset + GENRE_WORKSPACE_PAGE_SIZE)"
            >
              下一页原词
            </button>
          </nav>
          <section v-if="state.selectedRaw" class="mapping-editor" aria-label="整理所选原词">
            <h5>整理「{{ state.selectedRaw.value }}」</h5>
            <p>仅应用于来源 {{ state.selectedRaw.provider }}，不改写原始标签。</p>
            <p v-if="state.mapTarget">映射目标：{{ state.mapTarget.name }}</p>
            <p v-else>在流派列表中选择映射目标。</p>
            <div class="editor-actions">
              <button type="button" :disabled="!canMap" @click="view.map()">确认映射</button>
              <button type="button" :disabled="!ready" @click="view.create(true)">
                以原词新建流派
              </button>
              <button
                v-if="!state.selectedRaw.ignored"
                type="button"
                :disabled="!ready"
                @click="view.ignore()"
              >
                忽略此原词
              </button>
              <button v-else type="button" :disabled="!ready" @click="view.ignore(false)">
                恢复待整理
              </button>
            </div>
          </section>
        </section>
      </div>
    </template>
  </section>
</template>

<style scoped>
.genre-workspace {
  margin: 12px 0;
  color: var(--te-text);
  font-size: 12px;
  line-height: 1.65;
  overflow-wrap: anywhere;
}
.workspace-toggle {
  font-weight: 600;
}
header,
.editor-actions,
.node-heading,
.node-actions,
.breadcrumbs,
.pagination,
.search-controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
header,
.pagination {
  justify-content: space-between;
}
h4,
h5,
p {
  margin: 8px 0;
}
h4 {
  font-size: 14px;
}
h5 {
  font-size: 12px;
}
p,
.node-actions,
.raw-values span,
.node-name span {
  color: var(--te-text-secondary);
}
.workspace-columns {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 24px;
}
.workspace-columns > section {
  min-width: 0;
}
.search-controls label {
  flex: 1;
  min-width: 120px;
}
label:not(.ignored-filter) {
  display: grid;
  gap: 4px;
}
input:not([type='checkbox']) {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  min-height: 32px;
  padding: 5px 8px;
  font: inherit;
  color: var(--te-text);
  border: 1px solid var(--notice-border);
  border-radius: 7px;
  background: transparent;
}
.ignored-filter {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 10px 0;
}
.breadcrumbs {
  margin: 10px 0;
}
ul {
  list-style: none;
  margin: 8px 0;
  padding: 0;
}
li {
  padding: 6px 0;
  border-bottom: 1px solid var(--notice-border);
}
.node-heading {
  justify-content: space-between;
}
.node-name,
.raw-values button {
  text-align: left;
  display: grid;
  gap: 2px;
}
.node-name {
  flex: 1;
  min-width: 0;
}
.raw-values button {
  width: 100%;
}
.node-actions {
  padding: 4px 0;
}
.genre-editor,
.mapping-editor {
  border-top: 1px solid var(--notice-border);
  margin-top: 14px;
  padding-top: 8px;
}
.genre-editor label {
  margin: 8px 0;
}
button {
  max-width: 100%;
  min-height: 30px;
  padding: 5px 9px;
  font: inherit;
  color: var(--te-text);
  border: 0;
  border-radius: 7px;
  background: color-mix(in srgb, var(--te-primary-500) 10%, transparent);
  cursor: pointer;
  overflow-wrap: anywhere;
}
button[aria-pressed='true'] {
  background: color-mix(in srgb, var(--te-primary-500) 26%, transparent);
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
button:focus-visible,
input:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 2px;
}
@media (max-width: 760px) {
  .workspace-columns {
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
  }
}
</style>
