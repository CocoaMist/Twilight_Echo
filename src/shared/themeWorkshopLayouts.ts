import type { ThemeShellLayout, ThemeShellGrid } from './theme.ts'

const compact: ThemeShellGrid = {
  columns: ['fill'],
  rows: ['content', 'fill', 'content'],
  areas: [['titleBar'], ['content'], ['playerBar']]
}
const side = (right: boolean, topPlayer: boolean): ThemeShellLayout => ({
  navigation: 'persistent',
  desktop: {
    columns: right ? ['fill', 'standard'] : ['standard', 'fill'],
    rows: topPlayer ? ['content', 'content', 'fill'] : ['content', 'fill', 'content'],
    areas: topPlayer
      ? [
          ['titleBar', 'titleBar'],
          ['playerBar', 'playerBar'],
          right ? ['content', 'navigation'] : ['navigation', 'content']
        ]
      : [
          ['titleBar', 'titleBar'],
          right ? ['content', 'navigation'] : ['navigation', 'content'],
          ['playerBar', 'playerBar']
        ]
  },
  compact
})

export const WORKSHOP_LAYOUTS: { id: string; name: string; layout: ThemeShellLayout }[] = [
  { id: 'left', name: '左侧导航', layout: side(false, false) },
  { id: 'right', name: '右侧导航', layout: side(true, false) },
  { id: 'focus', name: '专注内容', layout: { navigation: 'hidden', desktop: compact, compact } },
  { id: 'left-top', name: '左侧导航 · 顶部播放栏', layout: side(false, true) },
  { id: 'right-top', name: '右侧导航 · 顶部播放栏', layout: side(true, true) },
  {
    id: 'minimal',
    name: '极简内容',
    layout: {
      navigation: 'hidden',
      desktop: { columns: ['fill'], rows: ['content', 'fill'], areas: [['titleBar'], ['content']] },
      compact: { columns: ['fill'], rows: ['content', 'fill'], areas: [['titleBar'], ['content']] }
    }
  }
]
