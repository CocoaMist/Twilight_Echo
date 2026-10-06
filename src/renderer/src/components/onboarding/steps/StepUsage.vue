<script setup lang="ts">
import type { OnboardingUsage } from '../useOnboardingFlow'

const props = defineProps<{ usage: OnboardingUsage | null }>()
const emit = defineEmits<{ select: [usage: OnboardingUsage] }>()

const options: { value: OnboardingUsage; title: string; desc: string; icon: string }[] = [
  {
    value: 'local',
    title: '本地音乐',
    desc: '播放电脑上的无损收藏，HiFi 引擎按位精确输出',
    icon: 'ph ph-hard-drives'
  },
  {
    value: 'streaming',
    title: '流媒体',
    desc: '登录网易云音乐，随时探索云端曲库与每日推荐',
    icon: 'ph ph-cloud'
  },
  {
    value: 'both',
    title: '两者都要',
    desc: '本地曲库与流媒体统一管理，跨来源无缝衔接',
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
    <p class="onb-subtitle">这决定了启动时你首先看到的页面，之后可在设置中更改。</p>
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
