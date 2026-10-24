<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import type { GenreSelection } from '../../../../shared/musicGenres.ts'
import type { UnifiedPlaybackResult } from '../../../../shared/musicUnifiedPlayback.ts'
import {
  CLASSIFICATION_DIMENSIONS,
  classificationFacetLabel,
  type ClassificationDimension
} from '../../../../shared/musicClassificationDimensions.ts'
import { useCoreConnection } from '../../stores/coreConnection.ts'
import {
  createGenreBrowseView,
  GENRE_BROWSE_PAGE_SIZE,
  GENRE_DIMENSION_LABELS,
  genreAvailabilityLabel,
  genreClassificationLabel,
  genreFilterLabel,
  genreOriginLabel,
  genreProviderLabel
} from './genreBrowseView.ts'

const emit = defineEmits<{ changed: [] }>()
const core = useCoreConnection()
const view = createGenreBrowseView({
  tree: (query, signal) => core.query('genres.tree', query, signal),
  browse: (query, signal) => core.query('genres.browse', query, signal),
  members: (query, signal) => core.query('genres.members', query, signal),
  evidence: (query, signal) => core.query('genres.evidence', query, signal),
  facets: (query, signal) => core.query('genres.facets', query, signal),
  override: async (request) => (await core.command('genres.override', request)) as GenreSelection,
  changed: () => emit('changed'),
  play: (sourceId, revision) => core.command('catalog.play', { sourceId, revision }),
  playUnified: async (request, signal) =>
    (await core.command('catalog.playUnified', request, signal)) as UnifiedPlaybackResult
})
const { state, busy, ready, canEditTarget } = view
const treeSearch = ref(''),
  search = ref(''),
  facetSearch = ref('')
watch(
  () => core.state.value?.epoch,
  (epoch) => view.setScope(String(epoch)),
  { immediate: true }
)
watch(
  () => [core.state.value?.genresRevision, core.state.value?.catalogRevision] as const,
  ([genresRevision, catalogRevision]) => view.observeRevisions({ genresRevision, catalogRevision })
)
watch(
  () => core.state.value?.libraryRevision,
  (revision, previous) => {
    if (previous != null && revision !== previous) view.invalidate()
  }
)
watch(
  () =>
    [
      core.state.value?.entityMetadataRevision,
      core.state.value?.classificationMetadataRevision,
      core.state.value?.pluginsRevision,
      core.state.value?.settingsRevision
    ] as const,
  (revisions, previous) => {
    if (
      previous &&
      revisions.some((value, index) => previous[index] != null && value !== previous[index])
    )
      view.invalidate()
  }
)
watch(
  () => state.value.treeSearch,
  (value) => {
    treeSearch.value = value
  }
)
watch(
  () => state.value.facetSearch,
  (value) => {
    facetSearch.value = value
  }
)
onBeforeUnmount(view.dispose)
</script>

<template>
  <section class="genre-browse" aria-label="按分类浏览音乐库" :aria-busy="busy">
    <header class="browse-heading">
      <div>
        <h3>按分类探索</h3>
        <p>同一首歌或专辑的多个来源合并显示，数量按条目去重。</p>
      </div>
      <button type="button" :disabled="busy || !!state.playingId" @click="view.refresh()">
        重新读取结果
      </button>
    </header>
    <p v-if="state.error" class="error" role="alert">{{ state.error }}</p>
    <p v-if="state.notice" role="status">{{ state.notice }}</p>
    <div class="browse-columns">
      <section class="genre-tree" aria-label="选择流派">
        <form class="search-controls" @submit.prevent="view.searchTree(treeSearch)">
          <label
            >查找流派<input
              v-model="treeSearch"
              type="search"
              maxlength="512"
              :disabled="!ready"
              placeholder="名称或英文名"
          /></label>
          <button type="submit" :disabled="!ready">查找流派</button>
        </form>
        <nav class="breadcrumbs" aria-label="浏览流派层级">
          <button type="button" :disabled="!ready" @click="view.browseTree(null)">根流派</button>
          <template v-for="(ancestor, index) in state.breadcrumbs" :key="ancestor.id"
            ><span aria-hidden="true">/</span
            ><button type="button" :disabled="!ready" @click="view.breadcrumb(index)">
              {{ ancestor.name }}
            </button></template
          >
          <span v-if="state.treeSearch">/ 全层级查找</span>
        </nav>
        <button
          type="button"
          class="all-genres"
          :aria-pressed="!state.selectedGenre"
          :disabled="!ready"
          @click="view.selectGenre(null)"
        >
          全部流派
        </button>
        <p v-if="state.loadingTree" role="status">正在读取流派…</p>
        <p v-else-if="state.tree && !state.tree.total">此层级暂无流派。</p>
        <ul class="genre-nodes">
          <li v-for="node in state.tree?.items ?? []" :key="node.id">
            <button
              class="genre-name"
              type="button"
              :disabled="!ready"
              :aria-pressed="state.selectedGenre?.id === node.id"
              @click="view.selectGenre(node)"
            >
              <strong>{{ node.name }}</strong
              ><span v-if="node.nameEn !== node.name">{{ node.nameEn }}</span>
            </button>
            <button
              v-if="node.childCount"
              type="button"
              :disabled="!ready"
              :aria-label="`浏览 ${node.name} 的子流派`"
              @click="view.browseTree(node)"
            >
              子类 {{ node.childCount }} →
            </button>
            <button
              v-if="state.evidenceTarget"
              type="button"
              :disabled="
                !ready ||
                state.draftGenreIds === null ||
                state.draftGenreIds.includes(node.id) ||
                state.draftGenreIds.length >= 200
              "
              :aria-label="`将 ${node.name} 加入当前目标人工分类`"
              @click="view.addGenre(node)"
            >
              加入人工分类
            </button>
          </li>
        </ul>
        <nav
          v-if="state.tree && state.tree.total > GENRE_BROWSE_PAGE_SIZE"
          class="pagination"
          aria-label="浏览流派分页"
        >
          <button
            type="button"
            :disabled="!ready || !state.tree.offset"
            @click="view.treePage(state.tree.offset - GENRE_BROWSE_PAGE_SIZE)"
          >
            上一页流派
          </button>
          <span
            >{{ state.tree.offset + 1 }}–{{ state.tree.offset + state.tree.items.length }} /
            {{ state.tree.total }}</span
          >
          <button
            type="button"
            :disabled="!ready || state.tree.offset + state.tree.items.length >= state.tree.total"
            @click="view.treePage(state.tree.offset + GENRE_BROWSE_PAGE_SIZE)"
          >
            下一页流派
          </button>
        </nav>
      </section>
      <section class="genre-results" aria-label="分类结果">
        <div class="filter-row">
          <div class="kind-switch" role="group" aria-label="条目类型">
            <button
              type="button"
              :disabled="!ready"
              :aria-pressed="state.kind === 'recording'"
              @click="view.setFilters({ kind: 'recording' })"
            >
              歌曲
            </button>
            <button
              type="button"
              :disabled="!ready"
              :aria-pressed="state.kind === 'release'"
              @click="view.setFilters({ kind: 'release' })"
            >
              专辑
            </button>
          </div>
          <label class="inline-label"
            ><input
              type="checkbox"
              :checked="state.includeDescendants"
              :disabled="!ready || !state.selectedGenre"
              @change="
                view.setFilters({ includeDescendants: ($event.target as HTMLInputElement).checked })
              "
            />包含子流派</label
          >
          <label class="inline-label"
            >来源<select
              :value="state.source"
              :disabled="!ready"
              @change="view.setFilters({ source: ($event.target as HTMLSelectElement).value })"
            >
              <option value="">全部来源</option>
              <option
                v-for="provider in state.page?.providers ?? []"
                :key="provider"
                :value="provider"
              >
                {{ genreProviderLabel(provider) }}
              </option>
            </select></label
          >
        </div>
        <form class="search-controls result-search" @submit.prevent="view.setFilters({ search })">
          <label
            >查找{{ state.kind === 'release' ? '专辑' : '歌曲'
            }}<input
              v-model="search"
              type="search"
              maxlength="512"
              :disabled="!ready"
              placeholder="名称或艺人" /></label
          ><button type="submit" :disabled="!ready">查找音乐</button>
        </form>
        <div class="dimension-controls">
          <label class="inline-label"
            >进一步筛选<select
              :value="state.facetDimension ?? ''"
              :disabled="!ready"
              @change="
                view.chooseDimension(
                  (($event.target as HTMLSelectElement).value ||
                    null) as ClassificationDimension | null
                )
              "
            >
              <option value="">选择分类维度</option>
              <option
                v-for="dimension in CLASSIFICATION_DIMENSIONS"
                :key="dimension"
                :value="dimension"
              >
                {{ GENRE_DIMENSION_LABELS[dimension] }}
              </option>
            </select></label
          >
          <ul class="filter-chips">
            <li v-for="filter in state.filters" :key="filter.dimension">
              <span>{{ genreFilterLabel(filter) }}</span
              ><button
                type="button"
                :disabled="!ready"
                :aria-label="`移除 ${GENRE_DIMENSION_LABELS[filter.dimension]} 筛选`"
                @click="view.removeFilter(filter.dimension)"
              >
                移除
              </button>
            </li>
          </ul>
        </div>
        <section v-if="state.facetDimension" class="facet-editor" aria-label="分类维度选项">
          <form class="search-controls" @submit.prevent="view.searchFacets(facetSearch)">
            <label
              >查找{{ GENRE_DIMENSION_LABELS[state.facetDimension]
              }}<input
                v-model="facetSearch"
                type="search"
                maxlength="512"
                :disabled="!ready" /></label
            ><button type="submit" :disabled="!ready">查找选项</button>
          </form>
          <p v-if="state.facets?.reason">{{ state.facets.reason }}</p>
          <p>显示当前结果中的数量；同一维度任选其一，多维度同时满足。</p>
          <p v-if="state.loadingFacets" role="status">正在读取选项…</p>
          <ul class="facet-values">
            <li v-for="item in state.facets?.items ?? []" :key="item.value">
              <label class="inline-label"
                ><input
                  type="checkbox"
                  :checked="state.facetDraft.includes(item.value)"
                  :disabled="
                    !ready ||
                    (!state.facetDraft.includes(item.value) && state.facetDraft.length >= 64)
                  "
                  @change="view.toggleFacet(item.value)"
                /><span>{{ item.label }}（{{ item.count }}）</span></label
              >
            </li>
          </ul>
          <p v-if="state.facets && !state.facets.total">当前结果没有此维度选项。</p>
          <nav
            v-if="state.facets && state.facets.total > GENRE_BROWSE_PAGE_SIZE"
            class="pagination"
            aria-label="分类维度选项分页"
          >
            <button
              type="button"
              :disabled="!ready || !state.facets.offset"
              @click="view.facetsPage(state.facets.offset - GENRE_BROWSE_PAGE_SIZE)"
            >
              上一页选项</button
            ><span
              >{{ state.facets.offset + 1 }}–{{ state.facets.offset + state.facets.items.length }} /
              {{ state.facets.total }}</span
            ><button
              type="button"
              :disabled="
                !ready || state.facets.offset + state.facets.items.length >= state.facets.total
              "
              @click="view.facetsPage(state.facets.offset + GENRE_BROWSE_PAGE_SIZE)"
            >
              下一页选项
            </button>
          </nav>
          <ul class="filter-chips">
            <li v-for="value in state.facetDraft" :key="value">
              <span>{{ classificationFacetLabel(state.facetDimension, value) }}</span
              ><button
                type="button"
                :disabled="!ready"
                :aria-label="`取消选择 ${classificationFacetLabel(state.facetDimension, value)}`"
                @click="view.removeFacetDraft(value)"
              >
                移除
              </button>
            </li>
          </ul>
          <button type="button" :disabled="!ready" @click="view.applyFacets()">
            {{ state.facetDraft.length ? '应用所选条件' : '清除此维度条件' }}
          </button>
        </section>
        <header class="result-heading">
          <h4>{{ state.selectedGenre?.name ?? '全部音乐' }}</h4>
          <span v-if="state.page"
            >{{ state.page.total }} {{ state.kind === 'release' ? '张专辑' : '首歌曲' }}</span
          >
        </header>
        <p v-if="state.loadingPage" role="status">正在读取分类结果…</p>
        <p v-else-if="state.page && !state.page.total">当前条件下没有音乐。</p>
        <ul class="entity-list">
          <li v-for="item in state.page?.items ?? []" :key="item.id">
            <button
              type="button"
              class="entity-name"
              :disabled="!ready"
              :aria-expanded="state.selectedEntity?.id === item.id"
              @click="view.selectEntity(item)"
            >
              <strong>{{ item.title }}</strong
              ><span>{{ item.artist || '未知艺人' }}</span>
            </button>
            <div class="entity-meta">
              <span
                >{{ item.genres.items.map((genre) => genre.name).join(' · ') || '暂无流派'
                }}<template v-if="item.genres.truncated">
                  · 共 {{ item.genres.total }} 类</template
                ></span
              ><span
                >{{ genreClassificationLabel(item.classification) }} ·
                {{ item.sourceCount }} 个库内来源</span
              >
            </div>
          </li>
        </ul>
        <nav
          v-if="state.page && state.page.total > GENRE_BROWSE_PAGE_SIZE"
          class="pagination"
          aria-label="音乐条目分页"
        >
          <button
            type="button"
            :disabled="!ready || !state.page.offset"
            @click="view.page(state.page.offset - GENRE_BROWSE_PAGE_SIZE)"
          >
            上一页音乐
          </button>
          <span
            >{{ state.page.offset + 1 }}–{{ state.page.offset + state.page.items.length }} /
            {{ state.page.total }}</span
          >
          <button
            type="button"
            :disabled="!ready || state.page.offset + state.page.items.length >= state.page.total"
            @click="view.page(state.page.offset + GENRE_BROWSE_PAGE_SIZE)"
          >
            下一页音乐
          </button>
        </nav>
        <section v-if="state.selectedEntity" class="member-section" aria-label="所选条目的来源">
          <header>
            <h4>{{ state.selectedEntity.title }}</h4>
            <span v-if="state.members">{{ state.members.total }} 个符合条件的库内来源</span>
          </header>
          <p v-if="state.loadingMembers" role="status">正在读取来源…</p>
          <p v-else-if="state.members && !state.members.total">此条目在当前条件下没有库内来源。</p>
          <p v-if="state.playError" class="error" role="alert">{{ state.playError }}</p>
          <label
            >统一播放的来源顺序
            <select
              :value="state.providerPreference"
              :disabled="!ready || !!state.playingId"
              @change="
                view.setProviderPreference(
                  ($event.target as HTMLSelectElement).value as 'default' | 'local' | 'streaming'
                )
              "
            >
              <option value="default">默认顺序</option>
              <option value="local">本地优先</option>
              <option
                value="streaming"
                :disabled="(state.page?.providers.filter((id) => id !== 'local').length ?? 0) > 128"
              >
                流媒体优先
              </option>
            </select>
          </label>
          <div v-if="state.unifiedResult" role="status">
            <p>
              {{
                state.unifiedResult.status === 'played'
                  ? '已按偏好选择等价来源'
                  : '当前范围内没有可用的等价来源'
              }}
            </p>
            <ul>
              <li v-for="attempt in state.unifiedResult.attempts" :key="attempt.sourceId">
                {{ genreProviderLabel(attempt.provider) }} ·
                {{
                  state.members?.items.find((item) => item.sourceId === attempt.sourceId)?.title ||
                  '等价来源'
                }}：
                {{ attempt.status === 'selected' ? '正在播放' : attempt.message }}
              </li>
            </ul>
          </div>
          <ul class="member-list">
            <li v-for="member in state.members?.items ?? []" :key="member.sourceId">
              <div class="member-heading">
                <strong>{{ genreProviderLabel(member.provider) }} · {{ member.title }}</strong
                ><span>{{ genreAvailabilityLabel(member.availability) }}</span>
              </div>
              <p>
                歌曲：{{
                  member.sourceClassification.genres.items.map((genre) => genre.name).join(' · ') ||
                  '暂无流派'
                }}
                · {{ genreOriginLabel(member.sourceClassification.origin)
                }}<template v-if="member.sourceClassification.genres.truncated">
                  · 共 {{ member.sourceClassification.genres.total }} 类</template
                >
              </p>
              <p v-if="member.collectionClassification">
                专辑：{{
                  member.collectionClassification.genres.items
                    .map((genre) => genre.name)
                    .join(' · ') || '暂无直接分类'
                }}
                · {{ genreOriginLabel(member.collectionClassification.origin)
                }}<template v-if="member.collectionClassification.genres.truncated">
                  · 共 {{ member.collectionClassification.genres.total }} 类</template
                >
              </p>
              <div class="member-actions">
                <button
                  type="button"
                  :disabled="!ready || !!state.playingId || member.availability === 'missing'"
                  @click="view.play(member)"
                >
                  {{
                    state.playingId === member.sourceId ? '正在准备此来源…' : '播放此来源'
                  }}</button
                ><button
                  type="button"
                  :disabled="!ready || !!state.playingId"
                  @click="view.playUnified(member)"
                >
                  按偏好选源播放</button
                ><button type="button" :disabled="!ready" @click="view.showEvidence(member)">
                  歌曲分类出处</button
                ><button
                  v-if="member.collectionTarget"
                  type="button"
                  :disabled="!ready"
                  @click="view.showEvidence(member, true)"
                >
                  专辑分类出处
                </button>
              </div>
            </li>
          </ul>
          <nav
            v-if="state.members && state.members.total > GENRE_BROWSE_PAGE_SIZE"
            class="pagination"
            aria-label="库内来源分页"
          >
            <button
              type="button"
              :disabled="!ready || !state.members.offset"
              @click="view.membersPage(state.members.offset - GENRE_BROWSE_PAGE_SIZE)"
            >
              上一页来源</button
            ><span
              >{{ state.members.offset + 1 }}–{{
                state.members.offset + state.members.items.length
              }}
              / {{ state.members.total }}</span
            ><button
              type="button"
              :disabled="
                !ready || state.members.offset + state.members.items.length >= state.members.total
              "
              @click="view.membersPage(state.members.offset + GENRE_BROWSE_PAGE_SIZE)"
            >
              下一页来源
            </button>
          </nav>
        </section>
        <section v-if="state.evidenceTarget" class="evidence-section" aria-label="分类出处详情">
          <h4>{{ state.evidenceLabel }}</h4>
          <p v-if="state.loadingEvidence" role="status">正在读取分类出处…</p>
          <p v-if="state.evidence">
            当前使用：{{ genreOriginLabel(state.evidence.selection.origin)
            }}<template v-if="state.evidence.selection.override?.length === 0">
              · 已明确清空</template
            >
          </p>
          <section
            v-if="state.draftGenreIds !== null"
            class="override-editor"
            aria-label="当前来源分类编辑"
          >
            <p>人工流派仅作用于上方目标。在流派列表中点“加入人工分类”，可选择多个流派。</p>
            <ul class="draft-genres">
              <li v-for="id in state.draftGenreIds" :key="id">
                <span>{{ state.draftNames[id] ?? id }}</span
                ><button
                  type="button"
                  :disabled="!ready"
                  :aria-label="`从人工集合移除 ${state.draftNames[id] ?? id}`"
                  @click="view.removeGenre(id)"
                >
                  移除
                </button>
              </li>
            </ul>
            <p v-if="!state.draftGenreIds.length">人工集合为空，保存后将明确不使用任何流派。</p>
            <p v-if="ready && !canEditTarget">请在当前来源页重新选择分类目标后保存。</p>
            <div class="member-actions">
              <button type="button" :disabled="!canEditTarget" @click="view.saveOverride()">
                保存人工流派</button
              ><button type="button" :disabled="!canEditTarget" @click="view.clearOverride()">
                明确清空流派</button
              ><button type="button" :disabled="!canEditTarget" @click="view.resetOverride()">
                恢复自动分类
              </button>
            </div>
          </section>
          <p v-if="state.evidence && !state.evidence.total">没有原始分类证据。</p>
          <ul>
            <li v-for="item in state.evidence?.items ?? []" :key="item.key">
              <strong>{{ genreProviderLabel(item.provider) }} · {{ item.provenance }}</strong>
              <p>
                {{
                  item.values
                    .map(
                      (value) =>
                        value.value +
                        (value.ignored ? '（已忽略）' : !value.genreId ? '（未映射）' : '')
                    )
                    .join(' · ')
                }}
              </p>
            </li>
          </ul>
          <nav
            v-if="state.evidence && state.evidence.total > GENRE_BROWSE_PAGE_SIZE"
            class="pagination"
            aria-label="分类出处分页"
          >
            <button
              type="button"
              :disabled="!ready || !state.evidence.offset"
              @click="view.evidencePage(state.evidence.offset - GENRE_BROWSE_PAGE_SIZE)"
            >
              上一页出处</button
            ><span
              >{{ state.evidence.offset + 1 }}–{{
                state.evidence.offset + state.evidence.items.length
              }}
              / {{ state.evidence.total }}</span
            ><button
              type="button"
              :disabled="
                !ready ||
                state.evidence.offset + state.evidence.items.length >= state.evidence.total
              "
              @click="view.evidencePage(state.evidence.offset + GENRE_BROWSE_PAGE_SIZE)"
            >
              下一页出处
            </button>
          </nav>
        </section>
      </section>
    </div>
  </section>
</template>

<style scoped>
.genre-browse {
  margin: 18px 0 24px;
  color: var(--te-text);
  font-size: 12px;
  line-height: 1.65;
  overflow-wrap: anywhere;
}
.browse-heading,
.result-heading,
.member-section header,
.member-heading,
.filter-row,
.search-controls,
.breadcrumbs,
.pagination,
.member-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.browse-heading,
.result-heading,
.member-section header,
.member-heading,
.pagination {
  justify-content: space-between;
}
h3 {
  font-size: 19px;
  margin: 0;
}
h4 {
  font-size: 14px;
  margin: 0;
}
p {
  margin: 6px 0;
  color: var(--te-text-secondary);
}
.browse-heading {
  margin-bottom: 18px;
}
.browse-columns {
  display: grid;
  grid-template-columns: minmax(170px, 0.65fr) minmax(0, 2fr);
  gap: 28px;
}
.browse-columns > section {
  min-width: 0;
}
.genre-tree {
  border-right: 1px solid var(--notice-border);
  padding-right: 20px;
}
.search-controls label {
  display: grid;
  gap: 4px;
  flex: 1;
  min-width: 90px;
}
input:not([type='checkbox']),
select {
  box-sizing: border-box;
  max-width: 100%;
  min-width: 0;
  min-height: 32px;
  padding: 5px 8px;
  font: inherit;
  color: var(--te-text);
  border: 1px solid var(--notice-border);
  border-radius: 7px;
  background: var(--te-bg-elevated, transparent);
}
input:not([type='checkbox']) {
  width: 100%;
}
.breadcrumbs {
  margin: 12px 0;
}
.inline-label {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.filter-row {
  justify-content: space-between;
}
.result-search {
  margin: 12px 0;
}
.kind-switch {
  display: flex;
  gap: 4px;
}
.result-heading {
  margin: 18px 0 8px;
}
ul {
  list-style: none;
  padding: 0;
  margin: 8px 0;
}
li {
  padding: 9px 0;
  border-bottom: 1px solid var(--notice-border);
}
.genre-nodes li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 4px;
}
.genre-name,
.entity-name {
  text-align: left;
  display: grid;
  min-width: 0;
  gap: 2px;
}
.genre-name {
  flex: 1;
}
.entity-name {
  width: 100%;
  background: transparent;
  padding: 0;
}
.entity-name strong {
  font-size: 14px;
}
.genre-name span,
.entity-name span,
.entity-meta,
.member-heading span,
.pagination span,
.result-heading > span {
  color: var(--te-text-secondary);
}
.entity-meta {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  column-gap: 12px;
  padding-top: 4px;
}
.pagination {
  margin: 12px 0;
}
.member-section,
.evidence-section {
  margin-top: 20px;
  border-top: 1px solid var(--notice-border);
  padding-top: 16px;
}
.override-editor {
  margin: 12px 0;
  padding: 10px 0;
  border-block: 1px solid var(--notice-border);
}
.draft-genres {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.draft-genres li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  border: 0;
}
.facet-editor {
  margin: 12px 0;
  padding: 12px;
  background: color-mix(in srgb, var(--te-primary-500) 4%, transparent);
  border-radius: 8px;
}
.filter-chips,
.facet-values {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.filter-chips li,
.facet-values li {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 0;
  padding: 0;
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
button[aria-pressed='true'],
button[aria-expanded='true'] {
  background: color-mix(in srgb, var(--te-primary-500) 26%, transparent);
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
button:focus-visible,
input:focus-visible,
select:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 2px;
}
.error {
  color: var(--te-danger, var(--te-text));
}
@media (max-width: 760px) {
  .browse-columns {
    grid-template-columns: minmax(0, 1fr);
    gap: 18px;
  }
  .genre-tree {
    border-right: 0;
    padding-right: 0;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--notice-border);
  }
}
</style>
