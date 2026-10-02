import { THEME_TOKEN_DEFINITIONS, type ThemeTokenDefinition } from '../../../../shared/theme.ts'

export const WORKSHOP_PREVIEW_SURFACES = [
  { id: 'dashboard', label: '本地首页', group: '卡片', layer: 'local.home' },
  { id: 'streaming', label: '流媒体首页', group: '卡片', layer: 'streaming.home' },
  { id: 'streaming-list', label: '流媒体歌曲列表', group: '列表', layer: 'streaming.library' },
  { id: 'library', label: '歌曲列表', group: '列表', layer: 'local.library' },
  { id: 'settings', label: '控件样本', group: '配色', layer: 'settings' },
  { id: 'player', label: '播放栏', group: '播放栏', layer: 'player' }
] as const
export const WORKSHOP_PREVIEW_STATES = [
  { id: 'normal', label: '正常' },
  { id: 'empty', label: '空内容' },
  { id: 'loading', label: '加载中' },
  { id: 'selected', label: '选中行' },
  { id: 'done', label: '完成' },
  { id: 'listening', label: '聆听' }
] as const
export const WORKSHOP_SIMPLE_GROUPS = [
  '项目',
  '配色',
  '背景',
  '字体',
  '卡片',
  '导航',
  '列表',
  '播放栏',
  '图层与蒙版',
  '素材库',
  '布局与模式'
]
export function workshopTokenGroup(token: ThemeTokenDefinition): string {
  if (token.id.startsWith('navigation.')) return '导航'
  if (token.id.startsWith('library.')) return '列表'
  if (token.id.startsWith('playback.') || token.surface === 'playerBar') return '播放栏'
  if (token.kind === 'font' || token.group === 'typography') return '字体'
  if (token.id.includes('background') || token.id === 'surface.app') return '背景'
  if (token.surface === 'card' || token.group === 'shape' || token.group === 'materials')
    return '卡片'
  return '配色'
}
export const WORKSHOP_SIMPLE_TOKENS = new Set([
  'color.primary.500',
  'color.neutral.900',
  'color.neutral.700',
  'surface.app',
  'surface.card',
  'surface.cardBorder',
  'typography.sans',
  'typography.display',
  'typography.rounded',
  ...THEME_TOKEN_DEFINITIONS.filter(
    (token) =>
      token.id.startsWith('navigation.') ||
      token.id.startsWith('library.') ||
      token.id.startsWith('playback.')
  ).map((token) => token.id)
])
