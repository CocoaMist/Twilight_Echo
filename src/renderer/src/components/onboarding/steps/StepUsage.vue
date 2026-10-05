<script setup lang="ts">
import type { OnboardingUsage } from '../useOnboardingFlow'

const props = defineProps<{ usage: OnboardingUsage | null }>()
const emit = defineEmits<{ select: [usage: OnboardingUsage] }>()

const options: { value: OnboardingUsage; title: string; desc: string; icon: string }[] = [
  {
    value: 'local',
    title: '本地音乐',
    desc: '电脑上的音乐文件',
    icon: 'ph ph-hard-drives'
  },
  {
    value: 'streaming',
    title: '流媒体',
    desc: '在线曲库、歌单和推荐',
    icon: 'ph ph-cloud'
  },
  {
    value: 'both',
    title: '两者都要',
    desc: '本地音乐和在线音乐',
    icon: 'ph ph-intersect'
  }
]

function isSelected(value: OnboardingUsage): boolean {
  return props.usage === value
}
</script>

<template>
  <section class="onb-stage" data-scene="02">
    <p class="onb-kicker">听歌习惯</p>
    <h1 class="onb-title">你平时更常听<em>哪里的音乐</em>？</h1>
    <p class="onb-subtitle">用于选择启动主页。</p>
    <div class="onb-cards" :class="{ 'has-selection': usage !== null }" role="radiogroup">
      <button
        v-for="option in options"
        :key="option.value"
        type="button"
        class="onb-card"
        :class="{ 'is-selected': isSelected(option.value) }"
        role="radio"
        :aria-checked="isSelected(option.value)"
        @click="emit('select', option.value)"
      >
        <span v-if="isSelected(option.value)" class="onb-card-check">
          <i class="ph ph-check"></i>
        </span>
        <i class="onb-card-icon" :class="option.icon"></i>
        <span class="onb-card-title">{{ option.title }}</span>
        <span class="onb-card-desc">{{ option.desc }}</span>
      </button>
    </div>
  </section>
</template>
