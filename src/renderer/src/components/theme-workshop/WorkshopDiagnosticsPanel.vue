<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type {
  WorkshopDiagnostic,
  WorkshopDiagnosticReport
} from '../../../../shared/themeWorkshopDiagnostics.ts'
const props = defineProps<{
  report: WorkshopDiagnosticReport
  checking: boolean
  progress: string
  stale: boolean
  previewValid: boolean
}>()
const emit = defineEmits<{
  locate: [item: WorkshopDiagnostic]
  repair: [item: WorkshopDiagnostic]
  check: []
  cancel: []
}>()
const filter = ref('all')
const visible = computed(() =>
  props.report.diagnostics.filter(
    (item) => filter.value === 'all' || item.severity === filter.value
  )
)
const expanded = ref(false)
const page = ref(0)
const pageCount = computed(() => Math.max(1, Math.ceil(visible.value.length / 40)))
const pageItems = computed(() => visible.value.slice(page.value * 40, (page.value + 1) * 40))
watch([filter, () => props.report], () => {
  page.value = 0
})
</script>
<template>
  <section class="workshop-diagnostics" aria-label="主题实时检测">
    <div class="workshop-diagnostics-header">
      <strong role="status">{{
        checking ? '检测中' : report.errors ? `${report.errors} 个错误` : '基础检查通过'
      }}</strong
      ><span>{{ report.warnings }} 个警告</span
      ><span v-if="!previewValid" class="workshop-error">当前显示最近有效预览</span
      ><button :aria-expanded="expanded" @click="expanded = !expanded">
        {{ expanded ? '收起问题' : '查看问题' }}</button
      ><button v-if="!checking" @click="emit('check')">完整检查</button
      ><button v-else @click="emit('cancel')">取消检查</button>
    </div>
    <p v-if="progress || stale" class="workshop-hint">
      {{ progress }}{{ stale ? ' · 编辑已变化，其他场景尚未检查' : '' }}
    </p>
    <div v-if="expanded || report.errors" class="workshop-diagnostics-body">
      <select v-model="filter" aria-label="诊断级别">
        <option value="all">全部问题</option>
        <option value="error">错误</option>
        <option value="warning">警告</option>
        <option value="info">建议</option>
      </select>
      <p v-if="!visible.length">当前分类没有问题。</p>
      <article
        v-for="item in pageItems"
        :key="item.id"
        :class="['workshop-diagnostic', item.severity]"
      >
        <button class="workshop-diagnostic-location" @click="emit('locate', item)">
          <span class="workshop-badge">{{
            { error: '错误', warning: '警告', info: '建议' }[item.severity]
          }}</span
          >{{ item.message
          }}<small
            >{{
              item.location.tone === 'dark'
                ? '深色'
                : item.location.tone === 'pureWhite'
                  ? '浅色'
                  : ''
            }}
            {{ item.location.surface }}
            {{
              item.location.line ? `第 ${item.location.line} 行 · ${item.location.column} 列` : ''
            }}</small
          ></button
        ><button v-if="item.repair" @click="emit('repair', item)">
          {{
            {
              'reset-control': '恢复有效值',
              'reset-token': '恢复主题值',
              'clear-reference': '移除失效引用',
              'fix-contrast': '修正文字颜色'
            }[item.repair]
          }}
        </button>
      </article>
      <div v-if="pageCount > 1" class="workshop-inline">
        <button :disabled="page === 0" @click="page--">上一页</button
        ><span>{{ page + 1 }} / {{ pageCount }} · {{ visible.length }} 个问题</span
        ><button :disabled="page + 1 >= pageCount" @click="page++">下一页</button>
      </div>
    </div>
  </section>
</template>
