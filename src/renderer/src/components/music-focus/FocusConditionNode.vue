<script setup lang="ts">
import { computed, ref } from 'vue'
import { CLASSIFICATION_DIMENSIONS } from '../../../../shared/musicClassificationDimensions.ts'
import { FOCUS_KINDS, type FocusDraftKind, type FocusDraftNode } from './musicFocusDraft.ts'
import { FOCUS_FACETS } from './musicFocusView.ts'
import FocusNumberFields from './FocusNumberFields.vue'

defineOptions({ name: 'FocusConditionNode' })

const props = defineProps<{
  node: FocusDraftNode
  disabled: boolean
  depth?: number
  choice: {
    nodeId: string
    kind: 'genre' | 'tag' | 'provider'
    search: string
    loading: boolean
    page: { offset: number; total: number; items: Array<{ id: string; name: string }> } | null
    error: string
  } | null
}>()
const emit = defineEmits<{
  field: [id: string, key: string, value: string | boolean]
  kind: [id: string, value: FocusDraftKind]
  add: [id: string, value: FocusDraftKind]
  remove: [id: string]
  lookup: [id: string, kind: 'genre' | 'tag' | 'provider', search: string, offset?: number]
  choose: [id: string, value: { id: string; name: string }]
}>()
const search = ref(''),
  addition = ref<FocusDraftKind>('source')
const isGroup = computed(() => ['all', 'any', 'not'].includes(props.node.kind))
const ownChoice = computed(() => (props.choice?.nodeId === props.node.id ? props.choice : null))
const field = (key: string, value: string | boolean) => emit('field', props.node.id, key, value)
const lookup = (offset = 0) =>
  emit('lookup', props.node.id, props.node.kind as 'genre' | 'tag', search.value, offset)
</script>

<template>
  <fieldset class="condition" :class="{ group: isGroup }" :aria-label="`Focus 条件 ${node.id}`">
    <div class="condition-heading">
      <label class="kind"
        ><span class="sr-only">条件类型</span>
        <select
          :value="node.kind"
          :disabled="disabled"
          :aria-label="`条件类型 ${node.id}`"
          @change="
            $emit('kind', node.id, ($event.target as HTMLSelectElement).value as FocusDraftKind)
          "
        >
          <option v-for="[value, label] in FOCUS_KINDS" :key="value" :value="value">
            {{ label }}
          </option>
        </select>
      </label>
      <button
        type="button"
        :disabled="disabled"
        :aria-label="`移除条件 ${node.id}`"
        @click="$emit('remove', node.id)"
      >
        移除
      </button>
    </div>
    <template v-if="isGroup">
      <p class="hint">
        {{
          node.kind === 'all'
            ? '以下条件全部满足'
            : node.kind === 'any'
              ? '以下条件满足任意一项'
              : '取当前范围内不满足以下条件的条目，包括缺值条目'
        }}
      </p>
      <p v-if="!node.children.length" class="hint">
        {{
          node.kind === 'all' ? '没有附加条件，保留当前范围的全部条目。' : '空的任一分组没有命中。'
        }}
      </p>
      <FocusConditionNode
        v-for="child in node.children"
        :key="child.id"
        :node="child"
        :disabled="disabled"
        :choice="choice"
        :depth="(depth ?? 1) + 1"
        @field="(id, key, value) => $emit('field', id, key, value)"
        @kind="(id, value) => $emit('kind', id, value)"
        @add="(id, value) => $emit('add', id, value)"
        @remove="(id) => $emit('remove', id)"
        @lookup="(id, kind, value, offset) => $emit('lookup', id, kind, value, offset)"
        @choose="(id, value) => $emit('choose', id, value)"
      />
      <div v-if="node.kind !== 'not' || !node.children.length" class="add-row">
        <label
          >添加条件<select
            :value="addition"
            :disabled="disabled || (depth ?? 1) >= 8"
            @change="addition = ($event.target as HTMLSelectElement).value as FocusDraftKind"
          >
            <option v-for="[value, label] in FOCUS_KINDS" :key="value" :value="value">
              {{ label }}
            </option>
          </select></label
        >
        <button
          type="button"
          :disabled="disabled || (depth ?? 1) >= 8"
          :aria-label="`添加到 ${node.id}`"
          @click="$emit('add', node.id, addition)"
        >
          添加
        </button>
      </div>
    </template>
    <div v-else-if="node.kind === 'source'" class="fields">
      <div class="row">
        <label
          >来源 ID<input
            :value="node.fields.provider ?? ''"
            :disabled="disabled"
            placeholder="local 为本地；留空不限"
            maxlength="128"
            @input="field('provider', ($event.target as HTMLInputElement).value)"
        /></label>
        <label
          >音频格式<input
            :value="node.fields.format ?? ''"
            :disabled="disabled"
            placeholder="如 FLAC；留空不限"
            maxlength="64"
            @input="field('format', ($event.target as HTMLInputElement).value)"
        /></label>
      </div>
      <button
        type="button"
        :disabled="disabled || ownChoice?.loading"
        @click="$emit('lookup', node.id, 'provider', '')"
      >
        浏览已有来源
      </button>
      <p v-if="ownChoice?.loading" role="status">正在读取来源…</p>
      <p v-if="ownChoice?.error" role="alert">{{ ownChoice.error }}</p>
      <ul v-if="ownChoice?.page" class="choices">
        <li v-for="item in ownChoice.page.items" :key="item.id">
          <button
            type="button"
            :disabled="disabled"
            :aria-label="`选择来源 ${item.name}`"
            @click="$emit('choose', node.id, item)"
          >
            {{ item.name }} · {{ item.id }}
          </button>
        </li>
      </ul>
      <p v-if="ownChoice?.page && !ownChoice.page.total">当前范围没有已缓存来源。</p>
      <nav v-if="ownChoice?.page && ownChoice.page.total > 20" aria-label="来源选项分页">
        <button
          type="button"
          :disabled="disabled || ownChoice.loading || !ownChoice.page.offset"
          @click="$emit('lookup', node.id, 'provider', '', Math.max(0, ownChoice.page.offset - 20))"
        >
          上一页来源
        </button>
        <button
          type="button"
          :disabled="
            disabled ||
            ownChoice.loading ||
            ownChoice.page.offset + ownChoice.page.items.length >= ownChoice.page.total
          "
          @click="$emit('lookup', node.id, 'provider', '', ownChoice.page.offset + 20)"
        >
          下一页来源
        </button>
      </nav>
      <FocusNumberFields
        :fields="node.fields"
        prefix="bitDepth."
        label="位深 (bit)"
        :disabled="disabled"
        @field="field"
      />
      <FocusNumberFields
        :fields="node.fields"
        prefix="sampleRate."
        label="采样率 (Hz)"
        :disabled="disabled"
        @field="field"
      />
      <p class="hint">这些要求必须由同一个来源满足。跨来源的要求请另建来源条件。</p>
    </div>
    <div v-else-if="node.kind === 'genre' || node.kind === 'tag'" class="fields">
      <p v-if="node.fields.id">已选：{{ node.fields.label || node.fields.id }}</p>
      <p v-else class="hint">请查找并选择{{ node.kind === 'genre' ? '流派' : '标签' }}。</p>
      <label v-if="node.kind === 'genre'" class="checkbox"
        ><input
          type="checkbox"
          :checked="!!node.fields.includeDescendants"
          :disabled="disabled"
          @change="field('includeDescendants', ($event.target as HTMLInputElement).checked)"
        />包含子流派</label
      >
      <div class="row">
        <label
          >查找{{ node.kind === 'genre' ? '流派' : '标签'
          }}<input
            :value="search"
            :disabled="disabled"
            maxlength="160"
            placeholder="输入名称，留空浏览全部"
            @input="search = ($event.target as HTMLInputElement).value"
            @keydown.enter.prevent="lookup()"
        /></label>
        <button type="button" :disabled="disabled || ownChoice?.loading" @click="lookup()">查找</button>
      </div>
      <p v-if="ownChoice?.loading" role="status">正在查找…</p>
      <p v-if="ownChoice?.error" role="alert">{{ ownChoice.error }}</p>
      <ul v-if="ownChoice?.page" class="choices">
        <li v-for="item in ownChoice.page.items" :key="item.id">
          <button
            type="button"
            :disabled="disabled"
            :aria-label="`选择 ${item.name}`"
            @click="$emit('choose', node.id, item)"
          >
            {{ item.name }}
          </button>
        </li>
      </ul>
      <p v-if="ownChoice?.page && !ownChoice.page.total">没有匹配项。</p>
      <nav v-if="ownChoice?.page && ownChoice.page.total > 20" aria-label="条件选项分页">
        <button
          type="button"
          :disabled="disabled || ownChoice.loading || !ownChoice.page.offset"
          @click="lookup(Math.max(0, ownChoice.page.offset - 20))"
        >
          上一页选项
        </button>
        <span
          >{{ ownChoice.page.offset + 1 }}–{{
            ownChoice.page.offset + ownChoice.page.items.length
          }}
          / {{ ownChoice.page.total }}</span
        >
        <button
          type="button"
          :disabled="
            disabled ||
            ownChoice.loading ||
            ownChoice.page.offset + ownChoice.page.items.length >= ownChoice.page.total
          "
          @click="lookup(ownChoice.page.offset + 20)"
        >
          下一页选项
        </button>
      </nav>
    </div>
    <div v-else-if="node.kind === 'rating'" class="fields">
      <label
        >评分模式<select
          :value="node.fields.mode"
          :disabled="disabled"
          @change="field('mode', ($event.target as HTMLSelectElement).value)"
        >
          <option value="personal">个人评分</option>
          <option value="base">资料评分</option>
          <option value="effective">有效评分（个人优先）</option>
        </select></label
      >
      <p v-if="node.fields.mode !== 'personal'" class="hint">
        当前没有获准的资料评分源。资料评分为空；有效评分使用个人评分。
      </p>
      <label v-if="node.fields.provider"
        >资料评分来源 ID<input
          :value="node.fields.provider"
          :disabled="disabled"
          @input="field('provider', ($event.target as HTMLInputElement).value)"
      /></label>
      <FocusNumberFields
        :fields="node.fields"
        label="评分"
        rating
        :disabled="disabled"
        @field="field"
      />
      <p class="hint">“无评分记录”与“低于某星级”分别筛选；缺值不满足数值比较。</p>
    </div>
    <div v-else-if="node.kind === 'year'" class="fields">
      <label
        >年份层级<select
          :value="node.fields.target"
          :disabled="disabled"
          @change="field('target', ($event.target as HTMLSelectElement).value)"
        >
          <option value="release">具体发行年</option>
          <option value="project">项目首发年</option>
        </select></label
      >
      <FocusNumberFields :fields="node.fields" label="年份" :disabled="disabled" @field="field" />
    </div>
    <div v-else-if="node.kind === 'lastPlayed'" class="fields">
      <FocusNumberFields :fields="node.fields" label="播放" :disabled="disabled" @field="field" />
      <p class="hint">选择“无播放记录”查找历史缺失条目；数值比较使用最后播放时间戳（毫秒）。</p>
    </div>
    <label v-else-if="node.kind === 'notPlayedWithinDays'"
      >最近未播放的天数<input
        type="number"
        min="0"
        max="365000"
        :value="node.fields.days"
        :disabled="disabled"
        @input="field('days', ($event.target as HTMLInputElement).value)"
      /><span class="hint">含无播放记录；按本次查询时刻的 N × 24 小时计算。</span></label
    >
    <label v-else-if="node.kind === 'automaticPlaybackBlocked'"
      >自动禁播<select
        :value="String(!!node.fields.blocked)"
        :disabled="disabled"
        @change="field('blocked', ($event.target as HTMLSelectElement).value === 'true')"
      >
        <option value="false">排除自动禁播</option>
        <option value="true">仅自动禁播</option>
      </select></label
    >
    <label v-else-if="node.kind === 'preference'"
      >收藏状态<select
        :value="node.fields.value"
        :disabled="disabled"
        @change="field('value', ($event.target as HTMLSelectElement).value)"
      >
        <option value="favorite">已收藏</option>
        <option value="ban">已禁播</option>
        <option value="none">无偏好</option>
      </select></label
    >
    <div v-else-if="node.kind === 'classification'" class="fields">
      <label
        >分类维度<select
          :value="node.fields.dimension"
          :disabled="disabled"
          @change="field('dimension', ($event.target as HTMLSelectElement).value)"
        >
          <option
            v-for="dimension in CLASSIFICATION_DIMENSIONS"
            :key="dimension"
            :value="dimension"
          >
            {{ FOCUS_FACETS.find((item) => item.value === dimension)?.label }}
          </option>
        </select></label
      >
      <label
        >分类值（每行一个，unknown 为未知）<textarea
          :value="String(node.fields.values ?? '')"
          :disabled="disabled"
          rows="2"
          @input="field('values', ($event.target as HTMLTextAreaElement).value)"
        />
      </label>
    </div>
    <label v-else-if="node.kind === 'text'"
      >名称关键词<input
        :value="node.fields.value"
        :disabled="disabled"
        maxlength="512"
        @input="field('value', ($event.target as HTMLInputElement).value)"
    /></label>
  </fieldset>
</template>

<style scoped>
.condition {
  min-width: 0;
  margin: 10px 0 0;
  padding: 12px 14px;
  border: 1px solid var(--te-card-border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--te-neutral-500, #888) 3%, transparent);
}
.group {
  border-left: 4px solid var(--te-primary-500);
  background: color-mix(in srgb, var(--te-primary-500, #3b82f6) 4%, transparent);
}
.condition-heading,
.row,
.add-row,
nav,
.choices {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 8px;
}
.condition-heading {
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
label {
  display: grid;
  gap: 4px;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
}
.kind {
  flex: 1;
}
.row label {
  flex: 1;
  min-width: 150px;
}
.fields {
  display: grid;
  gap: 10px;
}
.checkbox {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--te-card-border);
  width: fit-content;
}
.checkbox input {
  width: auto;
}
.add-row {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed var(--te-card-border);
}
.add-row label {
  flex: 1;
}
button,
input,
select,
textarea {
  box-sizing: border-box;
  max-width: 100%;
  padding: 6px 10px;
  font: inherit;
  color: var(--te-neutral-900);
  background: var(--te-card-bg);
  border: 1px solid var(--te-card-border);
  border-radius: 8px;
}
input,
select,
textarea {
  min-width: 0;
  width: 100%;
}
button {
  cursor: pointer;
  color: var(--te-primary-600);
  font-weight: 500;
}
button:hover:not(:disabled) {
  background: var(--te-hover-bg);
}
:disabled {
  opacity: 0.48;
  cursor: default;
}
button:focus-visible,
input:focus-visible,
select:focus-visible,
textarea:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 2px;
}
.hint,
nav span {
  color: var(--te-neutral-500);
  font-size: 12px;
  margin: 0;
}
.choices {
  list-style: none;
  margin: 4px 0;
  padding: 0;
}
.choices button {
  border-radius: 999px;
  padding: 4px 12px;
  font-size: 12px;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
@media (max-width: 640px) {
  .condition {
    padding: 10px;
  }
}
</style>
