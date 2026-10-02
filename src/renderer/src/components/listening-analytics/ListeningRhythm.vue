<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  buildListeningDays,
  comparePeriods,
  formatDayLabel,
  formatListeningDuration,
  listeningDurationParts,
  summarizeDays,
  type AnalyticsRange
} from '@renderer/components/listening-analytics/listeningAnalyticsData'

const props = defineProps<{ activity: { days: Record<string, number> }; now: Date }>()
const range = ref<AnalyticsRange>(30)
const ranges: AnalyticsRange[] = [7, 30, 90]
const selectedIndex = ref(29)
const inspecting = ref(false)
const series = computed(() => buildListeningDays(props.activity.days, props.now, range.value))
const summary = computed(() => summarizeDays(series.value))
const previous = computed(() =>
  summarizeDays(buildListeningDays(props.activity.days, props.now, range.value, range.value))
)
const comparison = computed(() => comparePeriods(summary.value.seconds, previous.value.seconds))
const headline = computed(() => listeningDurationParts(summary.value.seconds))
const comparisonText = computed(() => {
  const result = comparison.value
  if (result.direction === 'new') return '前期暂无记录'
  if (result.direction === 'same') return summary.value.seconds ? '与前期持平' : '等待新的旋律'
  return `${result.direction === 'up' ? '多' : '少'} ${Math.abs(result.percent ?? 0).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%`
})
const ceiling = computed(() => {
  let max = 0
  for (const day of series.value) max = Math.max(max, day.seconds)
  const step = max <= 300 ? 60 : max <= 1800 ? 300 : max <= 7200 ? 1800 : 3600
  return Math.max(step * 2, Math.ceil(max / (step * 2)) * step * 2)
})
const points = computed(() =>
  series.value.map((day, index) => ({
    x: 8 + (index / (series.value.length - 1)) * 624,
    y: 156 - (day.seconds / ceiling.value) * 144
  }))
)
const line = computed(() =>
  points.value.map((point, index) => `${index ? 'L' : 'M'}${point.x},${point.y}`).join(' ')
)
const area = computed(() => `${line.value} L632,156 L8,156 Z`)
const selectedDay = computed(() => series.value[selectedIndex.value] ?? series.value.at(-1)!)
const selectedPoint = computed(() => points.value[selectedIndex.value] ?? points.value.at(-1)!)
const axisDays = computed(() => [
  series.value[0],
  series.value[Math.floor(range.value / 2)],
  series.value.at(-1)!
])

watch(range, () => {
  selectedIndex.value = range.value - 1
  inspecting.value = false
})

function inspect(event: PointerEvent): void {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const plotX = ((event.clientX - rect.left) / rect.width) * 640
  const ratio = Math.max(0, Math.min(1, (plotX - 8) / 624))
  selectedIndex.value = Math.round(ratio * (range.value - 1))
  inspecting.value = true
}

function onKeydown(event: KeyboardEvent): void {
  const shifts: Record<string, number> = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }
  if (event.key === 'Escape') {
    inspecting.value = false
    return
  }
  if (!(event.key in shifts) && event.key !== 'Home' && event.key !== 'End') return
  event.preventDefault()
  selectedIndex.value =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? range.value - 1
        : Math.max(0, Math.min(range.value - 1, selectedIndex.value + shifts[event.key]))
  inspecting.value = true
}
</script>

<template>
  <section class="an-panel rhythm-panel" aria-labelledby="rhythm-title">
    <header class="an-section-head">
      <div>
        <span class="an-eyebrow">01 / YOUR RHYTHM</span>
        <h2 id="rhythm-title">聆听的节奏</h2>
      </div>
      <div class="an-segments" aria-label="聆听时长统计范围">
        <button
          v-for="option in ranges"
          :key="option"
          type="button"
          :aria-pressed="range === option"
          @click="range = option"
        >
          {{ option }} 天
        </button>
      </div>
    </header>
    <div class="rhythm-summary">
      <div class="rhythm-total">
        <strong>{{ headline.value }}</strong
        ><span>{{ headline.unit }}</span>
      </div>
      <span class="rhythm-comparison">
        <i
          :class="
            comparison.direction === 'up'
              ? 'ph ph-trend-up'
              : comparison.direction === 'down'
                ? 'ph ph-trend-down'
                : 'ph ph-minus'
          "
          aria-hidden="true"
        ></i>
        {{ comparisonText
        }}<small v-if="comparison.direction === 'up' || comparison.direction === 'down'"
          >比前 {{ range }} 天</small
        >
      </span>
    </div>
    <div class="rhythm-chart">
      <div class="rhythm-axis" aria-hidden="true">
        <span>{{ formatListeningDuration(ceiling) }}</span>
        <span>{{ formatListeningDuration(ceiling / 2) }}</span>
        <span>0</span>
      </div>
      <div class="rhythm-plot-wrap">
        <div
          class="rhythm-plot"
          role="slider"
          tabindex="0"
          aria-label="每日聆听时长，使用左右方向键查看日期"
          :aria-valuemin="1"
          :aria-valuemax="range"
          :aria-valuenow="selectedIndex + 1"
          :aria-valuetext="`${formatDayLabel(selectedDay.key)}，${formatListeningDuration(selectedDay.seconds)}`"
          @pointermove="inspect"
          @pointerleave="inspecting = false"
          @pointerdown="inspect"
          @focus="inspecting = true"
          @blur="inspecting = false"
          @keydown="onKeydown"
        >
          <svg viewBox="0 0 640 168" preserveAspectRatio="none" aria-hidden="true">
            <path class="rhythm-grid" d="M0,12 H640 M0,84 H640 M0,156 H640" />
            <path v-if="summary.seconds" class="rhythm-area" :d="area" />
            <path class="rhythm-line" :d="line" />
            <path v-if="inspecting" class="rhythm-crosshair" :d="`M${selectedPoint.x},0 V168`" />
          </svg>
          <span
            v-if="inspecting"
            class="rhythm-dot"
            :style="{ left: `${selectedPoint.x / 6.4}%`, top: `${selectedPoint.y / 1.68}%` }"
          ></span>
          <div
            v-if="inspecting"
            class="rhythm-tooltip"
            :style="{ left: `clamp(76px, ${selectedPoint.x / 6.4}%, calc(100% - 76px))` }"
          >
            <strong>{{ formatListeningDuration(selectedDay.seconds) }}</strong>
            <span
              >{{ formatDayLabel(selectedDay.key)
              }}<template v-if="selectedIndex === range - 1"> · 今天</template></span
            >
          </div>
          <p v-if="!summary.seconds && !inspecting" class="rhythm-no-data">
            这段时间，还没有留下足迹
          </p>
        </div>
        <div class="rhythm-dates" aria-hidden="true">
          <span v-for="day in axisDays" :key="day.key">{{ formatDayLabel(day.key) }}</span>
        </div>
      </div>
    </div>
    <div class="rhythm-facts">
      <div>
        <span>每天平均</span><strong>{{ formatListeningDuration(summary.averageSeconds) }}</strong>
      </div>
      <div>
        <span>有音乐的日子</span
        ><strong
          >{{ summary.activeDays }}<small> / {{ range }} 天</small></strong
        >
      </div>
      <div>
        <span>连续聆听最长</span><strong>{{ summary.longestStreak }}<small> 天</small></strong>
      </div>
    </div>
    <details class="an-data-details">
      <summary><span>每日明细</span><i class="ph ph-caret-down" aria-hidden="true"></i></summary>
      <div class="an-table-scroll">
        <table>
          <caption>
            {{
              series[0].key
            }}
            至
            {{
              series.at(-1)?.key
            }}
            · UTC
          </caption>
          <thead>
            <tr>
              <th scope="col">日期</th>
              <th scope="col">已记录时长</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="day in series" :key="day.key">
              <td>{{ day.key }}</td>
              <td>{{ formatListeningDuration(day.seconds) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </details>
    <p class="an-scope-note">仅切换本区时长 · UTC 日期，含尚未结束的今天</p>
  </section>
</template>

<style scoped>
.rhythm-panel {
  min-width: 0;
}
.rhythm-summary {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 12px 20px;
  margin: 22px 0 28px;
}
.rhythm-total {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.rhythm-total strong {
  font-size: 36px;
  line-height: 1;
  font-weight: 550;
  letter-spacing: -1.5px;
}
.rhythm-total > span {
  font-size: 12px;
  color: var(--an-muted);
}
.rhythm-comparison {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--an-secondary);
  font-size: 12px;
}
.rhythm-comparison small {
  color: var(--an-muted);
  font-size: 11px;
  margin-left: 3px;
}
.rhythm-chart {
  display: flex;
  gap: 12px;
  padding-top: 4px;
}
.rhythm-axis {
  width: 58px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  height: 168px;
  padding: 7px 0;
  box-sizing: border-box;
  color: var(--an-muted);
  font-size: 11px;
}
.rhythm-plot-wrap {
  flex: 1;
  min-width: 0;
}
.rhythm-plot {
  height: 168px;
  position: relative;
  cursor: crosshair;
  touch-action: pan-y;
  border-radius: 4px;
}
.rhythm-plot svg {
  width: 100%;
  height: 100%;
  overflow: visible;
}
.rhythm-grid {
  fill: none;
  stroke: var(--an-line);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}
.rhythm-line {
  fill: none;
  stroke: var(--an-accent);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}
.rhythm-area {
  fill: var(--an-accent);
  opacity: 0.08;
}
.rhythm-crosshair {
  stroke: var(--an-muted);
  stroke-width: 1;
  opacity: 0.5;
  vector-effect: non-scaling-stroke;
}
.rhythm-dot {
  position: absolute;
  width: 8px;
  height: 8px;
  border: 2px solid var(--an-surface);
  border-radius: 50%;
  background: var(--an-accent);
  transform: translate(-50%, -50%);
  pointer-events: none;
}
.rhythm-tooltip {
  position: absolute;
  top: -26px;
  transform: translateX(-50%);
  min-width: 110px;
  padding: 9px 12px;
  border: 1px solid var(--an-line);
  border-radius: 10px;
  background: var(--an-surface);
  box-shadow: 0 6px 18px var(--an-shadow);
  pointer-events: none;
  z-index: 2;
  display: grid;
  gap: 3px;
  text-align: center;
}
.rhythm-tooltip strong {
  font-size: 12px;
}
.rhythm-tooltip span {
  font-size: 11px;
  color: var(--an-muted);
}
.rhythm-no-data {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--an-muted);
  font-size: 12px;
  pointer-events: none;
}
.rhythm-dates {
  display: flex;
  justify-content: space-between;
  margin-top: 10px;
  font-size: 11px;
  color: var(--an-muted);
}
.rhythm-facts {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin-top: 26px;
  padding-top: 20px;
  border-top: 1px solid var(--an-line);
}
.rhythm-facts > div {
  display: grid;
  gap: 8px;
}
.rhythm-facts span {
  font-size: 11px;
  color: var(--an-muted);
}
.rhythm-facts strong {
  font-size: 14px;
  font-weight: 600;
}
.rhythm-facts small {
  color: var(--an-muted);
  font-size: 11px;
  font-weight: 400;
}
@container listening-journal (max-width: 600px) {
  .rhythm-axis {
    width: 52px;
    font-size: 10px;
  }
  .rhythm-chart {
    gap: 4px;
  }
  .rhythm-facts {
    gap: 8px;
  }
  .rhythm-facts strong {
    font-size: 12px;
  }
}
@media (forced-colors: active) {
  .rhythm-line,
  .rhythm-crosshair {
    stroke: CanvasText;
  }
  .rhythm-grid {
    stroke: GrayText;
  }
  .rhythm-area {
    display: none;
  }
  .rhythm-dot {
    background: Highlight;
  }
}
</style>
