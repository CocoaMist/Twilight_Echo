<script setup lang="ts">
import { onBeforeUnmount } from 'vue'
import type { MusicFocusPlayResult, MusicFocusSortField } from '../../../../shared/musicFocus.ts'
import { useCoreConnection } from '../../stores/coreConnection.ts'
import FocusConditionNode from './FocusConditionNode.vue'
import {
  createMusicFocusView,
  FOCUS_FACETS,
  FOCUS_PAGE_SIZE,
  FOCUS_SAVED_PAGE_SIZE,
  focusIntentLabel,
  observeMusicFocusView,
  validFocusName
} from './musicFocusView.ts'

const props = defineProps<{ scope?: string }>()
const core = useCoreConnection()
const view = createMusicFocusView({
  query: (query, signal) => core.query('focus.query', query, signal),
  facets: (query, signal) => core.query('focus.facets', query, signal),
  saved: (query, signal) => core.query('focus.saved.list', query, signal),
  create: (query) => core.command('focus.saved.create', query),
  rename: (query) => core.command('focus.saved.rename', query),
  update: (query) => core.command('focus.saved.update', query),
  delete: (query) => core.command('focus.saved.delete', query),
  play: async (query, signal, requestId) =>
    (await core.command('focus.play', query, signal, requestId)) as MusicFocusPlayResult,
  playStatus: (query, signal) => core.query('focus.play.status', query, signal),
  genres: (query, signal) => core.query('genres.tree', query, signal),
  tags: (query, signal) => core.query('tags.list', query, signal)
})
const { state, compiled, editable, ready, savedReady, canSaveIntent } = view
const sorts: Array<{ value: MusicFocusSortField; label: string }> = [
  { value: 'title', label: '名称' },
  { value: 'artist', label: '艺人' },
  { value: 'personalRating', label: '个人评分' },
  { value: 'lastPlayed', label: '最后播放' },
  { value: 'releaseYear', label: '具体发行年' }
]
const stop = observeMusicFocusView(view, {
  scope: () => props.scope ?? 'music-focus',
  snapshot: () => core.state.value
})
onBeforeUnmount(() => {
  stop()
  view.dispose()
})
</script>

<template>
  <section
    class="music-focus"
    aria-label="Focus 音乐库筛选"
    :aria-busy="state.loading || state.saving"
  >
    <header class="focus-heading">
      <div>
        <h3>Focus</h3>
        <p>组合音乐库条件，或打开保存的查询。</p>
      </div>
      <button
        type="button"
        :disabled="state.saving"
        :aria-expanded="state.opened"
        @click="view.toggle()"
      >
        {{ state.opened ? '收起 Focus' : '展开 Focus' }}
      </button>
    </header>
    <div v-if="state.opened" class="focus-body">
      <div class="focus-workspace">
        <section class="query-editor" aria-label="Focus 条件编辑">
          <div class="row">
            <label
              >查询条目<select
                :value="state.draft.entity"
                :disabled="!editable"
                @change="
                  view.edit((draft) => ({
                    ...draft,
                    entity: ($event.target as HTMLSelectElement).value as 'recording' | 'release'
                  }))
                "
              >
                <option value="recording">录音</option>
                <option value="release">具体发行</option>
              </select></label
            >
            <label
              >查询范围<select
                :value="state.draft.scope"
                :disabled="!editable"
                @change="
                  view.edit((draft) => ({
                    ...draft,
                    scope: ($event.target as HTMLSelectElement).value as 'library' | 'catalog'
                  }))
                "
              >
                <option value="library">音乐库</option>
                <option value="catalog">已缓存目录</option>
              </select></label
            >
          </div>
          <p v-if="state.draft.scope === 'catalog'" class="hint">
            只查询已缓存目录；目录范围不提供集合播放。
          </p>
          <FocusConditionNode
            :node="state.draft.root"
            :disabled="!editable"
            :choice="state.choice"
            @field="view.setField"
            @kind="view.setKind"
            @add="view.add"
            @remove="view.remove"
            @lookup="view.lookup"
            @choose="view.choose"
          />
          <fieldset class="sort-editor">
            <legend>排序优先级</legend>
            <div v-for="(sort, index) in state.draft.sort" :key="index" class="row">
              <label
                >第 {{ index + 1 }} 项<select
                  :value="sort.field"
                  :disabled="!editable"
                  @change="
                    view.edit((draft) => ({
                      ...draft,
                      sort: draft.sort.map((item, i) =>
                        i === index
                          ? {
                              ...item,
                              field: ($event.target as HTMLSelectElement)
                                .value as MusicFocusSortField
                            }
                          : item
                      )
                    }))
                  "
                >
                  <option v-for="option in sorts" :key="option.value" :value="option.value">
                    {{ option.label }}
                  </option>
                </select></label
              >
              <label
                >顺序<select
                  :value="sort.direction"
                  :disabled="!editable"
                  @change="
                    view.edit((draft) => ({
                      ...draft,
                      sort: draft.sort.map((item, i) =>
                        i === index
                          ? {
                              ...item,
                              direction: ($event.target as HTMLSelectElement).value as
                                | 'asc'
                                | 'desc'
                            }
                          : item
                      )
                    }))
                  "
                >
                  <option value="asc">升序</option>
                  <option value="desc">降序</option>
                </select></label
              >
              <button
                type="button"
                :disabled="!editable"
                :aria-label="`移除排序 ${index + 1}`"
                @click="
                  view.edit((draft) => ({
                    ...draft,
                    sort: draft.sort.filter((_, i) => i !== index)
                  }))
                "
              >
                移除
              </button>
            </div>
            <button
              type="button"
              :disabled="!editable || state.draft.sort.length >= 5"
              @click="
                view.edit((draft) => ({
                  ...draft,
                  sort: [
                    ...draft.sort,
                    {
                      field: sorts.find(
                        (item) => !draft.sort.some((sort) => sort.field === item.value)
                      )!.value,
                      direction: 'asc'
                    }
                  ]
                }))
              "
            >
              添加排序
            </button>
          </fieldset>
          <p v-if="compiled.error" role="alert">{{ compiled.error }}</p>
          <div class="actions query-actions">
            <button
              type="button"
              class="primary"
              :disabled="!editable || state.loading || !compiled.query"
              @click="view.evaluate()"
            >
              刷新 Focus 结果
            </button>
            <span v-if="state.selectedId">当前查询：{{ state.selectedName }}</span>
          </div>
          <p v-if="state.blocked" role="status">
            查询依据已变化，旧结果与数量已撤下；条件已保留，请刷新。
          </p>
          <p v-if="state.loading" role="status">正在计算 Focus 结果与分面…</p>
          <p v-if="state.error" role="alert">{{ state.error }}</p>
          <p v-if="state.notice" role="status">{{ state.notice }}</p>
        </section>

        <aside class="saved-queries" aria-label="保存的 Focus 查询">
          <header>
            <h4>
              保存的查询<span v-if="state.saved"> · {{ state.saved.total }}</span>
            </h4>
            <button
              type="button"
              :disabled="state.saving || state.savedLoading"
              @click="view.readSaved()"
            >
              重新读取查询
            </button>
          </header>
          <form class="row" @submit.prevent="view.create()">
            <label
              >新查询名称<input
                :value="state.name"
                :disabled="!editable"
                maxlength="80"
                placeholder="如：高分爵士 · 最近少听"
                @input="view.setName(($event.target as HTMLInputElement).value)" /></label
            ><button
              type="submit"
              :disabled="!savedReady || !validFocusName(state.name) || !compiled.query"
            >
              保存为新查询
            </button>
          </form>
          <div v-if="state.selectedId" class="selection-actions">
            <p>{{ state.selectedName }}</p>
            <div class="actions">
              <button
                type="button"
                :disabled="!savedReady || !state.selectedSaved || !compiled.query"
                @click="view.update()"
              >
                更新此查询条件</button
              ><button type="button" :disabled="!editable" @click="view.closeSaved()">
                取消当前选择
              </button>
            </div>
            <p v-if="state.saved && !state.selectedSaved" class="hint">
              请在列表中找到并重新打开此查询，再更新条件。
            </p>
          </div>
          <form class="row saved-search" @submit.prevent="view.readSaved()">
            <label
              >查找保存的查询<input
                :value="state.savedSearch"
                :disabled="!editable"
                maxlength="160"
                @input="view.setSavedSearch(($event.target as HTMLInputElement).value)" /></label
            ><button type="submit" :disabled="!editable || state.savedLoading">查找查询</button>
          </form>
          <p v-if="state.savedLoading" role="status">正在读取保存的查询…</p>
          <p v-if="state.savedBlocked" role="status">
            请重新读取保存的查询；保留的条件不会被覆盖。
          </p>
          <p v-if="state.savedError" role="alert">{{ state.savedError }}</p>
          <p v-if="state.saved && !state.saved.total">
            没有匹配的保存查询。空音乐库也可以保存条件。
          </p>
          <ul class="saved-list">
            <li v-for="item in state.saved?.items ?? []" :key="item.id">
              <div class="saved-row">
                <button
                  type="button"
                  class="saved-name"
                  :disabled="!savedReady"
                  :aria-pressed="state.selectedId === item.id"
                  :aria-label="`打开查询 ${item.name}`"
                  @click="view.openSaved(item)"
                >
                  {{ item.name
                  }}<span
                    >{{ item.query.entity === 'recording' ? '录音' : '具体发行' }} ·
                    {{ item.query.scope === 'catalog' ? '已缓存目录' : '音乐库' }}</span
                  >
                </button>
                <div class="actions">
                  <button
                    type="button"
                    :disabled="!savedReady"
                    :aria-label="`重命名查询 ${item.name}`"
                    @click="view.startRename(item)"
                  >
                    重命名</button
                  ><button
                    type="button"
                    :disabled="!savedReady"
                    :aria-label="`删除查询 ${item.name}`"
                    @click="view.requestDelete(item)"
                  >
                    删除
                  </button>
                </div>
              </div>
              <form v-if="state.renameId === item.id" class="row" @submit.prevent="view.rename()">
                <label
                  >查询新名称<input
                    :value="state.renameName"
                    :disabled="!editable"
                    maxlength="80"
                    @input="view.setRenameName(($event.target as HTMLInputElement).value)" /></label
                ><button type="submit" :disabled="!savedReady || !validFocusName(state.renameName)">
                  保存名称</button
                ><button type="button" :disabled="!editable" @click="view.cancelRename()">
                  取消重命名
                </button>
              </form>
            </li>
          </ul>
          <nav
            v-if="state.saved && state.saved.total > FOCUS_SAVED_PAGE_SIZE"
            aria-label="保存查询分页"
          >
            <button
              type="button"
              :disabled="!savedReady || !state.saved.offset"
              @click="view.savedPage(Math.max(0, state.saved.offset - FOCUS_SAVED_PAGE_SIZE))"
            >
              上一页查询</button
            ><span
              >{{ state.saved.offset + 1 }}–{{ state.saved.offset + state.saved.items.length }} /
              {{ state.saved.total }}</span
            ><button
              type="button"
              :disabled="
                !savedReady || state.saved.offset + state.saved.items.length >= state.saved.total
              "
              @click="view.savedPage(state.saved.offset + FOCUS_SAVED_PAGE_SIZE)"
            >
              下一页查询
            </button>
          </nav>
          <section v-if="state.intent" class="retained" aria-label="保留的查询操作">
            <p>保留的操作：{{ focusIntentLabel(state.intent) }}</p>
            <div class="actions">
              <button type="button" :disabled="!canSaveIntent" @click="view.saveIntent()">
                保存保留的查询操作</button
              ><button type="button" :disabled="!editable" @click="view.discardIntent()">
                放弃保留的操作
              </button>
            </div>
          </section>
          <section v-if="state.deleteItem" class="retained" aria-label="删除查询确认">
            <p>删除“{{ state.deleteItem.name }}”？只删除保存的查询，不删除音乐或整理数据。</p>
            <div class="actions">
              <button type="button" :disabled="!savedReady" @click="view.confirmDelete()">
                确认删除查询</button
              ><button type="button" :disabled="!editable" @click="view.cancelDelete()">
                保留查询
              </button>
            </div>
          </section>
        </aside>
      </div>

      <section v-if="state.page" class="focus-results" aria-label="Focus 当前结果">
        <header>
          <h4>
            当前结果 · {{ state.page.total }}
            {{ state.evaluated?.entity === 'release' ? '个发行' : '个录音' }}
          </h4>
          <div class="actions">
            <button
              type="button"
              :disabled="
                !ready ||
                !state.page.total ||
                state.evaluated?.scope === 'catalog' ||
                state.playing ||
                state.playUncertain
              "
              @click="view.play()"
            >
              播放 Focus 集合</button
            ><button v-if="state.playing" type="button" @click="view.cancelPlay()">
              取消 Focus 准备
            </button>
          </div>
        </header>
        <p class="hint">
          结果数量、分面与播放共用本次快照。播放成功后，后续改条件不会重排当前队列。
        </p>
        <div class="results-layout">
          <div>
            <p v-if="!state.page.total">当前条件没有结果。</p>
            <ol class="result-list">
              <li v-for="item in state.page.items" :key="item.id">
                <div>
                  <strong>{{ item.title }}</strong
                  ><span
                    >{{ item.artist || '未知艺人' }} · {{ item.sourceCount }} 个匹配来源{{
                      item.inLibrary ? '' : ' · 不在音乐库'
                    }}</span
                  ><span
                    >{{ item.personalRating == null ? '未评分' : `${item.personalRating} 星` }} ·
                    {{
                      item.lastPlayed == null
                        ? '无播放记录'
                        : `最后播放 ${new Date(item.lastPlayed).toLocaleDateString()}`
                    }}{{ item.releaseYear == null ? '' : ` · ${item.releaseYear}` }}</span
                  >
                </div>
                <button
                  v-if="item.sourceId && item.playable && state.evaluated?.scope !== 'catalog'"
                  type="button"
                  :disabled="!ready || state.playing || state.playUncertain"
                  :aria-label="`从 ${item.title} 播放 Focus 集合`"
                  @click="view.play(item.sourceId)"
                >
                  从此项播放</button
                ><span v-else class="hint">不提供播放</span>
              </li>
            </ol>
            <nav v-if="state.page.total > FOCUS_PAGE_SIZE" aria-label="Focus 结果分页">
              <button
                type="button"
                :disabled="!ready || !state.page.offset"
                @click="view.page(Math.max(0, state.page.offset - FOCUS_PAGE_SIZE))"
              >
                上一页结果</button
              ><span
                >{{ state.page.offset + 1 }}–{{ state.page.offset + state.page.items.length }} /
                {{ state.page.total }}</span
              ><button
                type="button"
                :disabled="
                  !ready || state.page.offset + state.page.items.length >= state.page.total
                "
                @click="view.page(state.page.offset + FOCUS_PAGE_SIZE)"
              >
                下一页结果
              </button>
            </nav>
          </div>
          <aside class="facet-panel" aria-label="当前结果分面">
            <label
              >当前结果中的数量<select
                :value="state.facet"
                :disabled="state.loading || state.saving"
                @change="
                  view.chooseFacet(($event.target as HTMLSelectElement).value as typeof state.facet)
                "
              >
                <option v-for="facet in FOCUS_FACETS" :key="facet.value" :value="facet.value">
                  {{ facet.label }}
                </option>
              </select></label
            >
            <ul>
              <li v-for="item in state.facets?.items ?? []" :key="item.value">
                <span>{{ item.label }}</span
                ><strong>{{ item.count }}</strong>
              </li>
            </ul>
            <p v-if="state.facets && !state.facets.total">没有可汇总的值。</p>
            <nav
              v-if="state.facets && state.facets.total > FOCUS_PAGE_SIZE"
              aria-label="Focus 分面分页"
            >
              <button
                type="button"
                :disabled="!ready || !state.facets.offset"
                @click="
                  view.chooseFacet(state.facet, Math.max(0, state.facets.offset - FOCUS_PAGE_SIZE))
                "
              >
                上一页分面</button
              ><button
                type="button"
                :disabled="
                  !ready || state.facets.offset + state.facets.items.length >= state.facets.total
                "
                @click="view.chooseFacet(state.facet, state.facets.offset + FOCUS_PAGE_SIZE)"
              >
                下一页分面
              </button>
            </nav>
          </aside>
        </div>
      </section>
      <p v-if="state.playing" role="status">正在准备 Focus 集合…</p>
      <p v-if="state.playError" role="alert">{{ state.playError }}</p>
      <p v-if="state.playNotice" role="status">{{ state.playNotice }}</p>
      <button
        v-if="state.playReceipt && !state.playing"
        type="button"
        :disabled="state.playChecking"
        @click="view.reconcilePlay()"
      >
        {{ state.playChecking ? '正在查询播放结果…' : '查询本次播放结果' }}
      </button>
      <button
        v-if="state.playUncertain && state.playStatus?.status === 'unknown'"
        type="button"
        :disabled="state.playChecking"
        @click="view.acknowledgePlay()"
      >
        我已人工核对当前队列
      </button>
    </div>
  </section>
</template>

<style scoped>
.music-focus {
  margin: 16px 0;
  padding: 16px;
  border: 1px solid var(--te-card-border);
  border-radius: 10px;
  background: var(--te-card-bg);
  color: var(--te-neutral-900);
  font-size: 14px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
header,
.row,
.actions,
nav,
.saved-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
header,
.saved-row {
  justify-content: space-between;
}
h3,
h4 {
  margin: 0;
  color: var(--te-neutral-900);
}
h3 {
  font-size: 20px;
}
h4 {
  font-size: 16px;
}
p {
  margin: 8px 0;
}
.focus-heading p {
  margin: 2px 0 0;
  color: var(--te-neutral-500);
}
.focus-workspace {
  display: grid;
  grid-template-columns: minmax(0, 1.5fr) minmax(270px, 1fr);
  gap: 24px;
  margin-top: 16px;
}
.query-editor,
.saved-queries,
.facet-panel {
  min-width: 0;
}
.saved-queries {
  padding-left: 20px;
  border-left: 1px solid var(--te-card-border);
}
.row {
  align-items: end;
  margin-top: 10px;
}
label {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.row label {
  flex: 1;
  min-width: 100px;
}
button,
input,
select {
  box-sizing: border-box;
  max-width: 100%;
  padding: 7px 10px;
  font: inherit;
  color: var(--te-neutral-900);
  background: var(--te-card-bg);
  border: 1px solid var(--te-card-border);
  border-radius: 6px;
}
input,
select {
  min-width: 0;
  width: 100%;
}
button {
  color: var(--te-primary-600);
  cursor: pointer;
}
button.primary {
  background: var(--te-primary-600);
  color: var(--te-on-primary, #fff);
}
button:hover:not(:disabled),
button[aria-pressed='true'] {
  background: var(--te-hover-bg);
}
button:focus-visible,
input:focus-visible,
select:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 2px;
}
:disabled {
  opacity: 0.5;
  cursor: default;
}
.sort-editor {
  min-width: 0;
  margin: 14px 0;
  padding: 10px;
  border: 1px solid var(--te-card-border);
  border-radius: 8px;
}
.sort-editor > button {
  margin-top: 10px;
}
.hint,
nav span,
.query-actions > span {
  color: var(--te-neutral-500);
}
ul,
ol {
  list-style: none;
  padding: 0;
  margin: 10px 0;
}
.saved-list > li {
  border-bottom: 1px solid var(--te-card-border);
  padding: 10px 0;
}
.saved-name {
  display: grid;
  gap: 2px;
  flex: 1;
  text-align: left;
  min-width: 0;
}
.saved-name span {
  color: var(--te-neutral-500);
}
.saved-search,
.selection-actions,
.retained {
  padding-top: 10px;
  margin-top: 12px;
  border-top: 1px solid var(--te-card-border);
}
.focus-results {
  margin-top: 22px;
  padding-top: 18px;
  border-top: 1px solid var(--te-card-border);
}
.results-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(200px, 0.4fr);
  gap: 24px;
}
.result-list li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 0;
  border-bottom: 1px solid var(--te-card-border);
}
.result-list li > div {
  display: grid;
  flex: 1;
  min-width: 120px;
}
.result-list span {
  color: var(--te-neutral-500);
}
.facet-panel {
  padding-top: 10px;
}
.facet-panel li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 0;
}
nav {
  margin-top: 10px;
}
@media (max-width: 1000px) {
  .focus-workspace,
  .results-layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .saved-queries {
    padding: 16px 0 0;
    border-left: 0;
    border-top: 1px solid var(--te-card-border);
  }
}
</style>
