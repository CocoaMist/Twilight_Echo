<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import {
  buildListeningCalendar,
  formatDayLabel,
  formatListeningDuration,
  utcDayKey
} from '@renderer/components/listening-analytics/listeningAnalyticsData'

const props = defineProps<{ activity: { days: Record<string, number> }; now: Date }>()
const calendar = computed(() => buildListeningCalendar(props.activity.days, props.now))
const selectedKey = ref(utcDayKey(props.now))
const hoverKey = ref<string | null>(null)
const grid = ref<HTMLElement | null>(null)
const showTable = ref(false)
const tablePage = ref(0)
const validDays = computed(() => calendar.value.cells.filter((cell) => cell.inRange))
const dayIndexes = computed(
  () => new Map(calendar.value.cells.map((cell, index) => [cell.key, index]))
)
const inspected = computed(
  () => calendar.value.cells[dayIndexes.value.get(hoverKey.value ?? selectedKey.value) ?? 0]
)
const months = computed(() =>
  calendar.value.months.filter(
    (month, index, all) =>
      month.column <= calendar.value.weeks - 1 &&
      (!all[index + 1] || all[index + 1].column - month.column >= 3)
  )
)
const tableDays = computed(() =>
  validDays.value
    .slice(Math.max(0, 365 - (tablePage.value + 1) * 31), 365 - tablePage.value * 31)
    .reverse()
)
const monthCount = Math.ceil(365 / 31)

watch(
  () => utcDayKey(props.now),
  (today, before) => {
    if (
      selectedKey.value === before ||
      !validDays.value.some((day) => day.key === selectedKey.value)
    )
      selectedKey.value = today
    hoverKey.value = null
  }
)

function selectDay(key: string): void {
  selectedKey.value = key
  hoverKey.value = null
}

async function navigate(event: KeyboardEvent, index: number): Promise<void> {
  if (event.key === 'Escape') {
    hoverKey.value = null
    return
  }
  const directions: Record<string, number> = {
    ArrowLeft: -7,
    ArrowRight: 7,
    ArrowUp: -1,
    ArrowDown: 1
  }
  if (!(event.key in directions) && event.key !== 'Home' && event.key !== 'End') return
  event.preventDefault()
  const first = dayIndexes.value.get(validDays.value[0].key)!
  const last = dayIndexes.value.get(validDays.value.at(-1)!.key)!
  const target =
    event.key === 'Home'
      ? first
      : event.key === 'End'
        ? last
        : Math.min(last, Math.max(first, index + directions[event.key]))
  selectedKey.value = calendar.value.cells[target].key
  hoverKey.value = null
  await nextTick()
  grid.value?.querySelector<HTMLButtonElement>(`[data-day="${selectedKey.value}"]`)?.focus()
}
</script>

<template>
  <section class="an-panel footprint-panel" aria-labelledby="footprint-title">
    <header class="an-section-head footprint-head">
      <div>
        <span class="an-eyebrow">03 / DAYS WITH MUSIC</span>
        <h2 id="footprint-title">日子里，有音乐</h2>
      </div>
      <div class="footprint-heading-summary">
        <strong>{{ calendar.summary.activeDays }}</strong
        ><span> / 365 天留下足迹</span>
      </div>
    </header>
    <div class="footprint-layout">
      <div class="footprint-calendar">
        <div class="calendar-scroll" tabindex="0" aria-label="全年聆听日历，可横向滚动">
          <div class="calendar-inner" :style="{ '--calendar-weeks': calendar.weeks }">
            <div class="calendar-months" aria-hidden="true">
              <span
                v-for="month in months"
                :key="month.key"
                :style="{ gridColumn: `${month.column} / span 2` }"
                >{{ month.label }}</span
              >
            </div>
            <div class="calendar-weekdays" aria-hidden="true">
              <span>一</span><span></span><span>三</span><span></span><span>五</span><span></span
              ><span>日</span>
            </div>
            <div
              ref="grid"
              class="calendar-grid"
              role="group"
              aria-label="近365天聆听时长，左右键移动一周，上下键移动一天"
              @pointerleave="hoverKey = null"
            >
              <button
                v-for="(cell, index) in calendar.cells"
                :key="cell.key"
                type="button"
                class="calendar-day"
                :class="[
                  `level-${cell.level}`,
                  {
                    'is-today': cell.isToday,
                    'is-selected': cell.key === selectedKey,
                    'is-outside': !cell.inRange
                  }
                ]"
                :data-day="cell.key"
                :disabled="!cell.inRange"
                :tabindex="cell.key === selectedKey ? 0 : -1"
                :aria-hidden="!cell.inRange || undefined"
                :aria-pressed="cell.key === selectedKey"
                :aria-label="`${cell.key}，${formatListeningDuration(cell.seconds)}${cell.isToday ? '，今天' : ''}`"
                :title="`${cell.key} · ${formatListeningDuration(cell.seconds)}`"
                @pointerenter="hoverKey = cell.key"
                @focus="selectDay(cell.key)"
                @click="selectDay(cell.key)"
                @keydown="navigate($event, index)"
              ></button>
            </div>
          </div>
        </div>
        <div class="calendar-bottom">
          <span class="calendar-readout" aria-live="polite"
            ><strong
              >{{ formatDayLabel(inspected.key) }}{{ inspected.isToday ? ' · 今天' : '' }}</strong
            ><span>{{
              inspected.seconds
                ? `已记录 ${formatListeningDuration(inspected.seconds)}`
                : '暂无聆听记录'
            }}</span></span
          >
          <span class="calendar-legend" aria-label="颜色深浅表示相对聆听时长"
            ><span>少</span><i v-for="level in 5" :key="level" :class="`level-${level - 1}`"></i
            ><span>多</span></span
          >
        </div>
      </div>
      <div class="footprint-highlights">
        <div>
          <span><i class="ph ph-fire-simple" aria-hidden="true"></i> 最长连续</span
          ><strong>{{ calendar.summary.longestStreak }}<small> 天</small></strong>
        </div>
        <div>
          <span><i class="ph ph-sun-horizon" aria-hidden="true"></i> 最投入的一天</span
          ><strong class="footprint-best-day">{{
            calendar.summary.bestDay ? formatDayLabel(calendar.summary.bestDay.key) : '还在等待'
          }}</strong
          ><small v-if="calendar.summary.bestDay">{{
            formatListeningDuration(calendar.summary.bestDay.seconds)
          }}</small>
        </div>
      </div>
    </div>
    <div class="footprint-footer">
      <span>{{ validDays[0].key }} — {{ validDays.at(-1)?.key }} · UTC</span
      ><button
        type="button"
        :aria-expanded="showTable"
        aria-controls="calendar-data"
        @click="showTable = !showTable"
      >
        <i class="ph ph-table" aria-hidden="true"></i>{{ showTable ? '收起数据' : '查看每日数据' }}
      </button>
    </div>
    <div v-if="showTable" id="calendar-data">
      <div class="calendar-pagination">
        <button
          type="button"
          class="an-icon-button"
          :disabled="tablePage === 0"
          aria-label="查看较新日期"
          @click="tablePage--"
        >
          <i class="ph ph-caret-left" aria-hidden="true"></i></button
        ><span>{{ tablePage + 1 }} / {{ monthCount }}</span
        ><button
          type="button"
          class="an-icon-button"
          :disabled="tablePage === monthCount - 1"
          aria-label="查看较早日期"
          @click="tablePage++"
        >
          <i class="ph ph-caret-right" aria-hidden="true"></i>
        </button>
      </div>
      <div class="an-table-scroll">
        <table>
          <caption>
            近365天每日时长 · 最新日期在前
          </caption>
          <thead>
            <tr>
              <th scope="col">UTC 日期</th>
              <th scope="col">已记录时长</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="day in tableDays" :key="day.key">
              <td>{{ day.key }}</td>
              <td>{{ formatListeningDuration(day.seconds) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>

<style scoped>
.footprint-panel {
  margin-top: 24px;
}
.footprint-heading-summary {
  color: var(--an-muted);
  font-size: 11px;
}
.footprint-heading-summary strong {
  font-size: 24px;
  font-weight: 550;
  color: var(--an-ink);
  letter-spacing: -0.6px;
}
.footprint-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 150px;
  gap: 30px;
  margin-top: 28px;
}
.footprint-calendar {
  min-width: 0;
}
.calendar-scroll {
  overflow-x: auto;
  padding: 4px 3px 8px;
  scrollbar-width: thin;
}
.calendar-inner {
  min-width: 650px;
  display: grid;
  grid-template-columns: 14px 1fr;
  column-gap: 8px;
  row-gap: 10px;
}
.calendar-months {
  grid-column: 2;
  display: grid;
  grid-template-columns: repeat(var(--calendar-weeks), minmax(0, 1fr));
  gap: 3px;
  height: 14px;
  color: var(--an-muted);
  font-size: 10px;
}
.calendar-months span {
  white-space: nowrap;
}
.calendar-weekdays {
  display: grid;
  grid-template-rows: repeat(7, 1fr);
  gap: 3px;
  font-size: 9px;
  color: var(--an-muted);
  text-align: center;
}
.calendar-weekdays span {
  display: grid;
  place-items: center;
}
.calendar-grid {
  display: grid;
  grid-template-rows: repeat(7, 1fr);
  grid-template-columns: repeat(var(--calendar-weeks), minmax(0, 1fr));
  grid-auto-flow: column;
  gap: 3px;
}
.calendar-grid .calendar-day {
  display: block;
  width: 100%;
  aspect-ratio: 1;
  min-width: 0;
  padding: 0;
  border-radius: 2px;
  position: relative;
}
.calendar-day.is-outside {
  visibility: hidden;
}
.calendar-day.is-today::after {
  content: '';
  position: absolute;
  width: 3px;
  height: 3px;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: var(--an-ink);
  border-radius: 50%;
}
.calendar-day.is-selected {
  outline: 1px solid var(--an-ink);
  outline-offset: 1px;
}
.calendar-day:hover:not(:disabled) {
  outline: 2px solid var(--an-ink);
  outline-offset: 1px;
  z-index: 1;
}
.calendar-day.level-0,
.calendar-legend .level-0 {
  background: var(--an-heat-0);
}
.calendar-day.level-1,
.calendar-legend .level-1 {
  background: var(--an-heat-1);
}
.calendar-day.level-2,
.calendar-legend .level-2 {
  background: var(--an-heat-2);
}
.calendar-day.level-3,
.calendar-legend .level-3 {
  background: var(--an-heat-3);
}
.calendar-day.level-4,
.calendar-legend .level-4 {
  background: var(--an-accent);
}
.calendar-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-top: 12px;
  min-height: 20px;
  flex-wrap: wrap;
}
.calendar-readout {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 11px;
}
.calendar-readout strong {
  font-weight: 550;
}
.calendar-readout > span {
  color: var(--an-muted);
}
.calendar-legend {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 9px;
  color: var(--an-muted);
}
.calendar-legend > span:first-child {
  margin-right: 3px;
}
.calendar-legend > span:last-child {
  margin-left: 3px;
}
.calendar-legend i {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
}
.footprint-highlights {
  border-left: 1px solid var(--an-line);
  padding-left: 24px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 22px;
}
.footprint-highlights > div {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.footprint-highlights span {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--an-muted);
}
.footprint-highlights strong {
  font-size: 24px;
  font-weight: 550;
}
.footprint-highlights strong small {
  font-size: 11px;
  color: var(--an-muted);
  font-weight: 400;
}
.footprint-highlights .footprint-best-day {
  font-size: 16px;
}
.footprint-highlights > div > small {
  font-size: 10px;
  color: var(--an-muted);
}
.footprint-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 24px;
  padding-top: 14px;
  border-top: 1px solid var(--an-line);
  color: var(--an-muted);
  font-size: 10px;
}
.footprint-footer button {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  font-size: 11px;
  color: var(--an-secondary);
}
.calendar-pagination {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 12px;
  margin: 12px 0 4px;
  font-size: 11px;
  color: var(--an-muted);
}
@container listening-journal (max-width: 850px) {
  .footprint-layout {
    grid-template-columns: minmax(0, 1fr);
    gap: 22px;
  }
  .footprint-highlights {
    flex-direction: row;
    justify-content: flex-start;
    border-left: 0;
    padding-left: 0;
    gap: 48px;
  }
  .footprint-highlights > div {
    display: flex;
    flex-wrap: wrap;
    flex-direction: row;
    align-items: baseline;
    column-gap: 12px;
  }
}
@container listening-journal (max-width: 500px) {
  .footprint-head {
    flex-wrap: wrap;
  }
  .footprint-footer {
    align-items: flex-start;
    flex-direction: column;
  }
  .footprint-highlights {
    gap: 16px;
  }
  .footprint-highlights > div {
    flex-direction: column;
  }
}
@media (forced-colors: active) {
  .calendar-day {
    border: 1px solid GrayText;
    forced-color-adjust: none;
  }
  .calendar-day.level-0 {
    background: Canvas;
  }
  .calendar-day.level-1,
  .calendar-day.level-2,
  .calendar-day.level-3 {
    background: repeating-linear-gradient(
      45deg,
      Canvas,
      Canvas 2px,
      CanvasText 2px,
      CanvasText 3px
    );
  }
  .calendar-day.level-4 {
    background: Highlight;
  }
}
</style>
