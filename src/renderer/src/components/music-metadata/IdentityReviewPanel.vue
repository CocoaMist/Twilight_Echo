<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useCoreConnection } from '../../stores/coreConnection.ts'
import {
  createIdentityReviewView,
  IDENTITY_CANDIDATE_PAGE_SIZE,
  identityEvidenceLabel,
  identityKindLabel,
  type IdentityCandidateState
} from './identityReviewView.ts'
import type { IdentificationCandidate } from '../../../../shared/musicIdentification.ts'
import IdentityReferences from './IdentityReferences.vue'
import IdentityHistoryPanel from './IdentityHistoryPanel.vue'
import IdentityRatingImpact from '../music-ratings/IdentityRatingImpact.vue'
import IdentityPreferenceImpact from '../music-preferences/IdentityPreferenceImpact.vue'

const props = defineProps<{ entityId: string | null; scope: string }>()
const emit = defineEmits<{ changed: [] }>()
const core = useCoreConnection()
const view = createIdentityReviewView({
  detail: (entityId, signal) => core.query('identification.detail', { entityId }, signal),
  candidates: (query, signal) => core.query('identification.candidates', query, signal),
  preview: (query, signal) => core.query('identification.preview', query, signal),
  decide: (query) => core.command('identification.decide', query),
  detach: (query) => core.command('identification.detach', query),
  start: (query) => core.command('identification.start', query),
  newId: () => crypto.randomUUID(),
  changed: async () => emit('changed')
})
const { state } = view
const historyBusy = ref(false)
const ready = computed(() => view.ready.value && !historyBusy.value)
const canConfirm = computed(() => view.canConfirm.value && !historyBusy.value)
const canReject = computed(() => view.canReject.value && !historyBusy.value)
watch([() => props.entityId, () => props.scope], ([id, scope]) => void view.setContext(id, scope), {
  immediate: true,
  flush: 'sync'
})
watch(
  [
    () => core.state.value?.entityMetadataRevision,
    () => core.state.value?.ratingsRevision,
    () => core.state.value?.catalogRevision,
    () => core.state.value?.libraryRevision,
    () => core.state.value?.epoch,
    () => core.state.value?.preferencesRevision
  ],
  (value, previous) => {
    if (value.some((item, index) => previous[index] != null && item !== previous[index]))
      view.invalidate(value[4] !== previous[4])
  },
  { flush: 'sync' }
)
onBeforeUnmount(view.dispose)
const previewPanel = ref<HTMLElement | null>(null)
const detachButton = ref<HTMLButtonElement | null>(null)
const readButton = ref<HTMLButtonElement | null>(null)
const busy = computed(
  () => state.value.loading || state.value.previewLoading || state.value.saving || historyBusy.value
)
async function historyChanged() {
  await view.refresh()
  emit('changed')
}
async function review(candidate: IdentificationCandidate) {
  if (historyBusy.value) return
  const { entityId, scope } = props
  await view.review(candidate)
  await nextTick()
  if (entityId === props.entityId && scope === props.scope && state.value.preview)
    previewPanel.value?.focus()
}
async function beginDetach() {
  if (historyBusy.value) return
  const { entityId, scope } = props
  view.beginDetach()
  await nextTick()
  if (entityId === props.entityId && scope === props.scope && state.value.detaching)
    detachButton.value?.focus()
}
async function cancel() {
  if (state.value.saving) return
  const { entityId, scope } = props
  view.cancel()
  await nextTick()
  if (entityId === props.entityId && scope === props.scope) readButton.value?.focus()
}
async function run(action: () => Promise<void>) {
  if (historyBusy.value) return
  const { entityId, scope } = props
  await action()
  await nextTick()
  if (entityId === props.entityId && scope === props.scope) readButton.value?.focus()
}
</script>

<template>
  <section v-if="entityId" class="identity-review" aria-label="身份与候选复核" :aria-busy="busy">
    <header>
      <h4>身份与候选复核</h4>
      <button ref="readButton" type="button" :disabled="busy" @click="view.refresh()">
        读取最新身份
      </button>
    </header>
    <p v-if="state.loading" role="status">正在读取身份与候选…</p>
    <p v-if="state.error" role="alert">{{ state.error }}</p>
    <p v-if="state.actionError" role="alert">{{ state.actionError }}</p>
    <p v-if="state.notice" role="status">{{ state.notice }}</p>
    <template v-if="state.identity">
      <p class="identity-current">
        {{ identityKindLabel(state.identity.kind) }} ·
        {{
          state.identity.link?.state === 'confirmed'
            ? state.identity.link.confirmation?.mode === 'automatic'
              ? '已自动确认'
              : '已确认'
            : state.identity.link?.state === 'detached'
              ? '已解除关联'
              : '尚未确认'
        }}
      </p>
      <IdentityReferences :references="state.identity.references" />
      <div class="identity-actions">
        <button type="button" :disabled="!ready" @click="run(view.start)">联网重新识别</button>
        <button
          v-if="state.identity.link?.state === 'confirmed'"
          type="button"
          :disabled="!ready"
          @click="beginDetach()"
        >
          解除关联
        </button>
        <label
          >候选状态
          <select
            :value="state.filter"
            :disabled="!ready"
            @change="
              view.filter(($event.target as HTMLSelectElement).value as IdentityCandidateState)
            "
          >
            <option value="candidate">待复核</option>
            <option value="rejected">已拒绝</option>
            <option value="confirmed">已确认</option>
          </select>
        </label>
      </div>
      <p v-if="state.saving" role="status">正在提交并核对结果…</p>
      <p v-if="state.detaching" class="identity-warning">
        解除后不再使用此身份的自动资料，也不会再次自动关联到它；手动介绍和原播放来源保留。
      </p>
      <p
        v-if="
          state.detaching &&
          (state.identity.kind === 'recording' || state.identity.kind === 'release')
        "
        class="identity-warning"
      >
        若此前共享个人评分，解除后恢复此曲库条目关联前的原评分；关联期间写入的共享评分留在原身份，不会复制到此条目。
      </p>
      <p
        v-if="
          state.detaching &&
          (state.identity.kind === 'recording' || state.identity.kind === 'release')
        "
        class="identity-warning"
      >
        解除后恢复此条目关联前的喜欢或禁播；关联期间写入的共享偏好留在原身份，不会复制到此条目。
      </p>
      <p v-if="state.detaching && state.identity.kind === 'artist'" class="identity-warning">
        解除后此条目不再沿用原艺人身份的喜欢与禁播；共享偏好仍保留在原身份。
      </p>
      <div v-if="state.detaching" class="identity-actions">
        <button ref="detachButton" type="button" :disabled="!ready" @click="run(view.detach)">
          确认解除关联
        </button>
        <button type="button" :disabled="state.saving" @click="cancel()">取消</button>
      </div>
      <p v-if="state.candidates && !state.candidates.total" class="identity-hint">
        此状态下暂无已保存候选。
      </p>
      <ul v-else class="identity-candidates" aria-label="身份候选">
        <li v-for="candidate in state.candidates?.items ?? []" :key="candidate.id">
          <div class="identity-candidate-heading">
            <strong>{{ candidate.name }}</strong>
            <span>{{ candidate.provider }}</span>
            <button type="button" :disabled="!ready" @click="review(candidate)">复核此候选</button>
          </div>
          <p v-if="candidate.summary">{{ candidate.summary }}</p>
        </li>
      </ul>
      <nav
        v-if="state.candidates && state.candidates.total > IDENTITY_CANDIDATE_PAGE_SIZE"
        aria-label="身份候选分页"
      >
        <button
          type="button"
          :disabled="!ready || state.offset === 0"
          @click="view.page(Math.max(0, state.offset - IDENTITY_CANDIDATE_PAGE_SIZE))"
        >
          上一页候选
        </button>
        <span
          >{{ state.offset + 1 }}–{{ state.offset + state.candidates.items.length }} /
          {{ state.candidates.total }}</span
        >
        <button
          type="button"
          :disabled="
            !ready || state.offset + state.candidates.items.length >= state.candidates.total
          "
          @click="view.page(state.offset + IDENTITY_CANDIDATE_PAGE_SIZE)"
        >
          下一页候选
        </button>
      </nav>
      <p v-if="state.previewLoading" role="status">正在核对候选版本…</p>
      <div
        v-if="state.preview"
        ref="previewPanel"
        class="identity-preview"
        tabindex="-1"
        aria-label="候选与当前关联比较"
      >
        <h5>{{ state.preview.candidate.name }}</h5>
        <p>{{ state.preview.candidate.summary }}</p>
        <IdentityReferences :references="state.preview.candidate.references" />
        <dl class="identity-evidence">
          <div v-if="state.preview.candidate.evidence.matches.length">
            <dt>相符依据</dt>
            <dd>
              {{ state.preview.candidate.evidence.matches.map(identityEvidenceLabel).join('、') }}
            </dd>
          </div>
          <div v-if="state.preview.candidate.evidence.missing.length">
            <dt>缺少依据</dt>
            <dd>
              {{ state.preview.candidate.evidence.missing.map(identityEvidenceLabel).join('、') }}
            </dd>
          </div>
          <div v-if="state.preview.candidate.evidence.conflicts.length">
            <dt>候选矛盾</dt>
            <dd>
              {{ state.preview.candidate.evidence.conflicts.map(identityEvidenceLabel).join('、') }}
            </dd>
          </div>
          <div>
            <dt>证据来源</dt>
            <dd>{{ state.preview.candidate.evidence.provenance }}</dd>
          </div>
        </dl>
        <p v-if="state.preview.candidate.evidence.incomplete" class="identity-hint">
          来源结果或判断依据不完整，请结合当前音源核对。
        </p>
        <p v-if="state.preview.stale" role="alert">候选依据已过期，请联网重新识别后再复核。</p>
        <p v-for="conflict in state.preview.conflicts" :key="conflict" role="alert">
          {{ identityEvidenceLabel(conflict) }}
        </p>
        <p v-if="state.preview.action === 'replace'" class="identity-warning">
          确认后将替换上方当前身份；介绍、图片和人员信息会按新身份重新读取。
        </p>
        <p v-if="state.preview.candidate.suppressed" class="identity-warning">
          此身份曾被拒绝或解除；手动确认会允许再次关联。
        </p>
        <IdentityRatingImpact
          v-if="state.preview.ratingImpact"
          :impact="state.preview.ratingImpact"
          :choice="state.ratingChoice"
          :disabled="busy"
          @choose="view.chooseRating"
        />
        <IdentityPreferenceImpact
          v-if="state.preview.preferenceImpact"
          :impact="state.preview.preferenceImpact"
          :choice="state.preferenceChoice"
          :disabled="busy"
          @choose="view.choosePreference"
        />
        <div class="identity-actions">
          <button type="button" :disabled="!canConfirm" @click="run(() => view.decide('confirm'))">
            {{ state.preview.action === 'replace' ? '确认替换关联' : '确认关联' }}
          </button>
          <button type="button" :disabled="!canReject" @click="run(() => view.decide('reject'))">
            拒绝此候选
          </button>
          <button type="button" :disabled="state.saving" @click="cancel()">取消复核</button>
        </div>
      </div>
    </template>
    <IdentityHistoryPanel
      :entity-id="entityId"
      :scope="scope"
      :disabled="state.loading || state.previewLoading || state.saving"
      @busy="historyBusy = $event"
      @changed="historyChanged"
    />
  </section>
</template>

<style scoped>
.identity-review {
  margin-top: 18px;
  padding-top: 16px;
  border-top: 1px solid var(--te-card-border);
  line-height: 1.7;
  overflow-wrap: anywhere;
}
header,
nav,
.identity-actions,
.identity-candidate-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
header {
  justify-content: space-between;
}
h4,
h5 {
  margin: 0;
  font-size: 1em;
  color: var(--te-neutral-900);
}
p {
  margin: 8px 0;
}
button,
select {
  font: inherit;
  color: var(--te-primary-600);
  border: 1px solid var(--te-card-border);
  border-radius: 6px;
  padding: 6px 10px;
  background: transparent;
}
select {
  color: var(--te-neutral-900);
  background: var(--te-card-bg, Canvas);
  margin-left: 8px;
}
button {
  cursor: pointer;
}
button:disabled,
select:disabled {
  opacity: 0.45;
  cursor: default;
}
button:not(:disabled):hover {
  background: var(--te-hover-bg);
}
button:focus-visible,
select:focus-visible,
.identity-preview:focus-visible {
  outline: 2px solid var(--te-primary-500);
  outline-offset: 3px;
}
.identity-hint,
.identity-candidates p {
  color: var(--te-neutral-500);
}
.identity-warning {
  color: var(--te-neutral-700);
  font-weight: 600;
}
.identity-candidates {
  list-style: none;
  padding: 0;
  margin: 12px 0;
}
.identity-candidates > li {
  padding: 10px 0;
  border-bottom: 1px solid var(--te-card-border);
}
.identity-candidate-heading > button {
  margin-left: auto;
}
.identity-preview {
  padding: 16px 0;
  margin-top: 16px;
  border-block: 1px solid var(--te-card-border);
}
.identity-evidence {
  margin: 12px 0;
}
.identity-evidence > div {
  margin: 8px 0;
}
dt {
  font-weight: 600;
  color: var(--te-neutral-900);
}
dd {
  margin: 0;
}
</style>
