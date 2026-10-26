<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'
import { useCoreConnection } from '../../stores/coreConnection.ts'
import {
  validMusicTagName,
  type MusicTagMemberKind,
  type MusicTagsPlayResult
} from '../../../../shared/musicTags.ts'
import {
  createMusicTagsView,
  MUSIC_TAGS_PAGE_SIZE,
  observeMusicTagsView,
  tagIntentLabel
} from './musicTagsView.ts'

const props = defineProps<{
  entityId?: string | null
  scope?: string
  label: string
  compact?: boolean
}>()
const core = useCoreConnection()
const view = createMusicTagsView({
  entity: (query, signal) => core.query('tags.entity', query, signal),
  list: (query, signal) => core.query('tags.list', query, signal),
  members: (query, signal) => core.query('tags.members', query, signal),
  recordings: (query, signal) => core.query('tags.recordings', query, signal),
  create: (query) => core.command('tags.create', query),
  rename: (query) => core.command('tags.rename', query),
  delete: (query) => core.command('tags.delete', query),
  memberSet: (query) => core.command('tags.member.set', query),
  play: async (query, signal) =>
    (await core.command('tags.play', query, signal)) as MusicTagsPlayResult
})
const { state, ready, canSaveIntent } = view
const memberKindLabel: Record<MusicTagMemberKind, string> = {
  recording: '歌曲',
  release: '具体发行',
  artist: '人物',
  work: '作品'
}
const stop = observeMusicTagsView(view, {
  entityId: () => props.entityId ?? null,
  scope: () => props.scope ?? '',
  snapshot: () => core.state.value
})
watch(
  [() => props.compact, () => state.value.blocked, () => state.value.loading],
  ([compact, blocked, loading]) => {
    if (compact && blocked && !loading && !state.value.saving && !state.value.intent) {
      void view.refresh()
    }
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  stop()
  view.dispose()
})
</script>

<template>
  <section
    class="music-tags"
    :class="{ 'is-compact': compact }"
    :aria-label="`${label}标签`"
    :aria-busy="state.loading || state.saving"
  >
    <div class="tags-inline-row">
      <header class="tags-header">
        <h4><span class="compact-hide">{{ label }}</span>标签</h4>
        <div v-if="!compact" class="actions">
          <button
            type="button"
            class="ghost-btn"
            :disabled="state.saving || state.loading"
            @click="view.refresh()"
          >
            重新读取标签
          </button>
          <button
            type="button"
            class="soft-btn"
            :disabled="state.saving"
            :aria-expanded="state.opened"
            @click="view.toggleManager()"
          >
            {{ state.opened ? '收起标签管理' : '管理标签' }}
          </button>
        </div>
      </header>
      <div class="tags-inline-body">
        <p v-if="state.loading && !compact" role="status" class="status-note">正在读取标签…</p>
        <p v-if="state.saving && !compact" role="status" class="status-note">正在保存标签…</p>
        <p v-if="state.blocked && !compact" role="status" class="status-note">
          标签或曲库已变化，请重新读取核对。
        </p>
        <p v-if="state.error" role="alert" class="alert-note">{{ state.error }}</p>
        <p v-if="state.notice && !compact" role="status" class="status-note">{{ state.notice }}</p>
        <template v-if="state.entity">
          <p v-if="!state.entity.total && !compact" class="hint">此条目还没有标签。</p>
          <ul v-else-if="state.entity.total" class="assigned-tags" aria-label="此条目已加入的标签">
            <li v-for="tag in state.entity.items" :key="tag.id" class="tag-chip-group">
              <button
                type="button"
                class="tag-chip-main"
                :disabled="!ready"
                @click="view.select(tag)"
              >
                {{ tag.name }}
              </button>
              <button
                type="button"
                class="tag-chip-remove"
                :disabled="!ready"
                :aria-label="`将当前条目移出 ${tag.name}`"
                @click="view.member(tag, false)"
              >
                移出
              </button>
            </li>
          </ul>
          <nav v-if="state.entity.total > MUSIC_TAGS_PAGE_SIZE" aria-label="此条目标签分页">
            <button
              type="button"
              :disabled="!ready || state.entity.offset === 0"
              @click="view.entityPage(Math.max(0, state.entity.offset - MUSIC_TAGS_PAGE_SIZE))"
            >
              上一页已加入标签
            </button>
            <span
              >{{ state.entity.offset + 1 }}–{{ state.entity.offset + state.entity.items.length }} /
              {{ state.entity.total }}</span
            >
            <button
              type="button"
              :disabled="
                !ready || state.entity.offset + state.entity.items.length >= state.entity.total
              "
              @click="view.entityPage(state.entity.offset + MUSIC_TAGS_PAGE_SIZE)"
            >
              下一页已加入标签
            </button>
          </nav>
        </template>
        <button
          v-if="compact"
          type="button"
          class="soft-btn compact-tag-btn"
          :disabled="state.saving"
          :aria-expanded="state.opened"
          @click="view.toggleManager()"
        >
          {{ state.opened ? '收起标签管理' : '管理标签' }}
        </button>
      </div>
    </div>

    <div v-if="state.intent" class="retained-intent">
      <p>保留的操作：{{ tagIntentLabel(state.intent) }}</p>
      <div class="actions">
        <button
          type="button"
          class="primary-btn"
          :disabled="!canSaveIntent"
          @click="view.saveIntent()"
        >
          保存保留的标签操作
        </button>
        <button type="button" :disabled="state.saving" @click="view.discardIntent()">
          放弃保留的操作
        </button>
      </div>
    </div>

    <div v-if="state.opened || state.selectedId || state.deleteTag" class="tags-workspace-grid">
      <section v-if="state.opened" class="tag-manager" aria-label="标签管理">
        <div class="manager-header">
          <h5>
            全部标签<span v-if="state.list"> · {{ state.list.total }}</span>
          </h5>
        </div>
        <form class="name-editor" @submit.prevent="view.create()">
          <label
            >新标签名称<input
              :value="state.createName"
              maxlength="80"
              placeholder="输入新标签名称…"
              :disabled="!ready"
              @input="view.setCreateName(($event.target as HTMLInputElement).value)"
          /></label>
          <button
            type="submit"
            class="primary-btn"
            :disabled="!ready || !validMusicTagName(state.createName)"
          >
            创建标签
          </button>
        </form>
        <p v-if="state.list && !state.list.total" class="hint">还没有标签，先创建一个。</p>
        <ul class="tag-list">
          <li v-for="tag in state.list?.items ?? []" :key="tag.id">
            <div class="tag-row">
              <button
                type="button"
                class="tag-name"
                :disabled="!ready"
                :aria-expanded="state.selectedId === tag.id"
                @click="view.select(tag)"
              >
                <strong>{{ tag.name }}</strong
                ><span>{{ tag.memberCount }} 个引用</span>
              </button>
              <div class="actions">
                <button
                  v-if="entityId"
                  type="button"
                  class="soft-btn"
                  :disabled="!ready"
                  :aria-label="`将当前条目加入 ${tag.name}`"
                  @click="view.member(tag, true)"
                >
                  加入当前条目
                </button>
                <button
                  type="button"
                  :disabled="!ready"
                  :aria-label="`重命名 ${tag.name}`"
                  @click="view.startRename(tag)"
                >
                  重命名
                </button>
                <button
                  type="button"
                  class="danger-btn"
                  :disabled="!ready"
                  :aria-label="`删除标签 ${tag.name}`"
                  @click="view.requestDelete(tag)"
                >
                  删除
                </button>
              </div>
            </div>
            <form
              v-if="state.renameId === tag.id"
              class="name-editor"
              @submit.prevent="view.rename()"
            >
              <label
                >标签新名称<input
                  :value="state.renameName"
                  maxlength="80"
                  :disabled="!ready"
                  @input="view.setRenameName(($event.target as HTMLInputElement).value)"
              /></label>
              <button
                type="submit"
                class="primary-btn"
                :disabled="!ready || !validMusicTagName(state.renameName)"
              >
                保存名称
              </button>
              <button type="button" :disabled="state.saving" @click="view.cancelRename()">
                取消重命名
              </button>
            </form>
          </li>
        </ul>
        <nav v-if="state.list && state.list.total > MUSIC_TAGS_PAGE_SIZE" aria-label="全部标签分页">
          <button
            type="button"
            :disabled="!ready || state.list.offset === 0"
            @click="view.listPage(Math.max(0, state.list.offset - MUSIC_TAGS_PAGE_SIZE))"
          >
            上一页标签
          </button>
          <span
            >{{ state.list.offset + 1 }}–{{ state.list.offset + state.list.items.length }} /
            {{ state.list.total }}</span
          >
          <button
            type="button"
            :disabled="!ready || state.list.offset + state.list.items.length >= state.list.total"
            @click="view.listPage(state.list.offset + MUSIC_TAGS_PAGE_SIZE)"
          >
            下一页标签
          </button>
        </nav>
      </section>

      <div v-if="state.deleteTag || state.selectedId" class="tag-detail-column">
        <section v-if="state.deleteTag" class="delete-confirmation" aria-label="删除标签确认">
          <p>
            删除“{{ state.deleteTag.name }}”？只删除标签及其引用，不删除歌曲、专辑、人物、作品或来源。
          </p>
          <div class="actions">
            <button
              type="button"
              class="danger-btn"
              :disabled="!ready"
              @click="view.confirmDelete()"
            >
              确认删除标签</button
            ><button type="button" :disabled="state.saving" @click="view.cancelDelete()">
              保留标签
            </button>
          </div>
        </section>

        <section
          v-if="state.selectedId"
          class="tag-detail"
          :aria-label="`标签 ${state.selectedName} 的内容`"
        >
          <header class="detail-header">
            <div class="detail-title-group">
              <h5>{{ state.selectedName }}</h5>
              <span v-if="state.members" class="count-pill">{{ state.members.total }} 个引用</span>
            </div>
            <button
              type="button"
              class="ghost-btn"
              :disabled="state.saving"
              @click="view.closeSelection()"
            >
              收起标签内容
            </button>
          </header>
          <p class="hint">
            专辑引用会动态包含它的库内曲目；人物与作品标签不自动展开歌曲。移除来源仍保留此处的引用。
          </p>
          <p v-if="state.members && !state.members.total" class="hint">此标签没有引用。</p>
          <ul class="member-list">
            <li v-for="member in state.members?.items ?? []" :key="member.id">
              <div class="member-meta">
                <strong>{{ member.title }}</strong
                ><span :class="{ 'is-offline': !member.inLibrary }"
                  >{{ memberKindLabel[member.kind] }} · {{ member.artist || '未知艺人' }} ·
                  {{ member.inLibrary ? `${member.sourceCount} 个库内来源` : '已不在库中' }}</span
                >
              </div>
              <button
                type="button"
                :disabled="!ready"
                :aria-label="`从此标签移出 ${member.title}`"
                @click="view.member(state.members!.tag, false, member.id)"
              >
                移出引用
              </button>
            </li>
          </ul>
          <nav
            v-if="state.members && state.members.total > MUSIC_TAGS_PAGE_SIZE"
            aria-label="标签引用分页"
          >
            <button
              type="button"
              :disabled="!ready || !state.members.offset"
              @click="view.membersPage(Math.max(0, state.members.offset - MUSIC_TAGS_PAGE_SIZE))"
            >
              上一页引用
            </button>
            <span
              >{{ state.members.offset + 1 }}–{{
                state.members.offset + state.members.items.length
              }}
              / {{ state.members.total }}</span
            >
            <button
              type="button"
              :disabled="
                !ready || state.members.offset + state.members.items.length >= state.members.total
              "
              @click="view.membersPage(state.members.offset + MUSIC_TAGS_PAGE_SIZE)"
            >
              下一页引用
            </button>
          </nav>

          <div class="recordings-section">
            <header class="recordings-heading">
              <h5>
                库内歌曲<span v-if="state.recordings">
                  · {{ state.recordings.total }} 首，按录音去重</span
                >
              </h5>
              <div class="actions">
                <button
                  type="button"
                  class="primary-btn"
                  :disabled="!ready || !state.recordings?.total || state.playing"
                  @click="view.play()"
                >
                  播放标签集合
                </button>
                <button v-if="state.playing" type="button" @click="view.cancelPlay()">
                  取消准备
                </button>
              </div>
            </header>
            <p v-if="state.playing" role="status" class="status-note">正在准备标签集合…</p>
            <p v-if="state.playError" role="alert" class="alert-note">{{ state.playError }}</p>
            <p v-if="state.playNotice" role="status" class="status-note">{{ state.playNotice }}</p>
            <p v-if="state.recordings && !state.recordings.total" class="hint">
              此标签当前没有可展开的库内歌曲。
            </p>
            <ol class="recording-list">
              <li v-for="item in state.recordings?.items ?? []" :key="item.recordingId">
                <div class="member-meta">
                  <strong>{{ item.title }}</strong
                  ><span>{{ item.artist || '未知艺人' }} · {{ item.sourceCount }} 个库内来源</span>
                </div>
                <button
                  type="button"
                  class="soft-btn"
                  :disabled="!ready || state.playing"
                  :aria-label="`从 ${item.title} 开始播放标签集合`"
                  @click="view.play(item.sourceId)"
                >
                  从此曲播放
                </button>
              </li>
            </ol>
            <nav
              v-if="state.recordings && state.recordings.total > MUSIC_TAGS_PAGE_SIZE"
              aria-label="标签库内歌曲分页"
            >
              <button
                type="button"
                :disabled="!ready || !state.recordings.offset"
                @click="
                  view.recordingsPage(Math.max(0, state.recordings.offset - MUSIC_TAGS_PAGE_SIZE))
                "
              >
                上一页库内歌曲
              </button>
              <span
                >{{ state.recordings.offset + 1 }}–{{
                  state.recordings.offset + state.recordings.items.length
                }}
                / {{ state.recordings.total }}</span
              >
              <button
                type="button"
                :disabled="
                  !ready ||
                  state.recordings.offset + state.recordings.items.length >= state.recordings.total
                "
                @click="view.recordingsPage(state.recordings.offset + MUSIC_TAGS_PAGE_SIZE)"
              >
                下一页库内歌曲
              </button>
            </nav>
          </div>
        </section>
      </div>
    </div>
  </section>
</template>

<style scoped>
.music-tags {
  display: flex;
  flex-direction: column;
  justify-content: center;
  margin-top: 10px;
  padding: 10px 16px;
  border: 1px solid var(--te-card-border);
  border-radius: 12px;
  background: var(--te-card-bg);
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.tags-header,
.detail-header,
.detail-title-group,
.actions,
nav,
.name-editor,
.assigned-tags,
.tag-chip-group,
.tag-row,
.member-list li,
.recording-list li,
.recordings-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.tags-header,
.detail-header,
.tag-row,
.member-list li,
.recording-list li,
.recordings-heading {
  justify-content: space-between;
}
h4,
h5 {
  margin: 0;
  color: var(--te-neutral-900);
  font-size: 14px;
  font-weight: 700;
}
p {
  margin: 2px 0 0;
}
button,
input {
  max-width: 100%;
  box-sizing: border-box;
  padding: 6px 11px;
  font: inherit;
  font-size: 12.5px;
  border: 1px solid var(--te-card-border);
  border-radius: 8px;
  background: transparent;
}
button {
  color: var(--te-neutral-800, var(--te-neutral-900));
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}
.ghost-btn {
  border-color: transparent;
  color: var(--te-primary-600);
}
.soft-btn {
  color: var(--te-primary-600);
  border-color: color-mix(in srgb, var(--te-primary-500) 30%, var(--te-card-border));
}
.primary-btn {
  color: var(--te-primary-600);
  background: color-mix(in srgb, var(--te-primary-500) 14%, transparent);
  border-color: color-mix(in srgb, var(--te-primary-500) 45%, var(--te-card-border));
  font-weight: 600;
}
.danger-btn {
  color: var(--te-danger, #d9534f);
  border-color: color-mix(in srgb, var(--te-danger, #d9534f) 35%, var(--te-card-border));
}
input {
  min-width: 0;
  width: 100%;
  color: var(--te-neutral-900);
  background: var(--te-bg-elevated, transparent);
}
button:disabled,
input:disabled {
  opacity: 0.45;
  cursor: default;
}
button:not(:disabled):hover,
button[aria-expanded='true'] {
  background: var(--te-hover-bg);
  color: var(--te-primary-600);
}
button:focus-visible,
input:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 2px;
}
ul,
ol {
  margin: 8px 0;
  padding: 0;
  list-style: none;
}
.assigned-tags {
  margin-top: 8px;
}
.tag-chip-group {
  gap: 0;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--te-primary-500) 35%, var(--te-card-border));
  background: color-mix(in srgb, var(--te-primary-500) 8%, transparent);
  overflow: hidden;
}
.tag-chip-main {
  border: 0;
  border-radius: 0;
  padding: 4px 10px;
  font-weight: 500;
  color: var(--te-primary-600);
}
.tag-chip-remove {
  border: 0;
  border-left: 1px solid color-mix(in srgb, var(--te-primary-500) 25%, var(--te-card-border));
  border-radius: 0;
  padding: 4px 8px;
  font-size: 11.5px;
  color: var(--te-neutral-500);
}
.retained-intent {
  margin: 8px 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--te-primary-500) 8%, transparent);
}
.tags-workspace-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 16px;
  margin-top: 12px;
}
.tag-manager,
.tag-detail,
.delete-confirmation {
  padding: 12px;
  border-radius: 10px;
  border: 1px solid var(--te-card-border);
  background: color-mix(in srgb, var(--te-neutral-500) 4%, transparent);
}
.delete-confirmation {
  margin-bottom: 12px;
  border-color: color-mix(in srgb, var(--te-danger, #d9534f) 40%, var(--te-card-border));
}
.name-editor {
  margin-top: 10px;
  align-items: flex-end;
}
.name-editor label {
  display: grid;
  gap: 4px;
  flex: 1;
  min-width: 140px;
  font-size: 12px;
  color: var(--te-neutral-600, var(--te-neutral-500));
}
.tag-name {
  display: grid;
  gap: 2px;
  text-align: left;
  border-color: transparent;
  padding: 4px 8px;
}
.tag-list li,
.member-list li,
.recording-list li {
  padding: 7px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--te-card-border) 65%, transparent);
}
.tag-list li:last-child,
.member-list li:last-child,
.recording-list li:last-child {
  border-bottom: 0;
}
.count-pill {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 999px;
  color: var(--te-neutral-500);
  background: color-mix(in srgb, var(--te-neutral-500) 10%, transparent);
}
.tag-name span,
.hint,
.member-list span,
.recording-list span,
nav span {
  color: var(--te-neutral-500);
  font-size: 12.5px;
}
.member-list span.is-offline {
  color: var(--te-warning, #d97706);
}
.member-meta {
  display: grid;
  min-width: 0;
  flex: 1;
  gap: 2px;
}
.recordings-section {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--te-card-border);
}
.status-note {
  font-size: 12px;
  color: var(--te-neutral-500);
}
.alert-note {
  font-size: 12px;
  color: var(--te-danger, #d9534f);
}
nav {
  margin-top: 10px;
}
.music-tags.is-compact {
  display: block;
  margin-top: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
}
.music-tags.is-compact .compact-hide {
  display: none;
}
.music-tags.is-compact .tags-inline-row {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  min-height: 28px;
}
.music-tags.is-compact h4 {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--te-neutral-500);
}
.music-tags.is-compact .tags-inline-body {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.music-tags.is-compact .assigned-tags {
  margin: 0;
}
.music-tags.is-compact .compact-tag-btn {
  padding: 2px 11px;
  font-size: 12px;
  border-radius: 999px;
}
</style>
