import type { PlayMode } from '../types/settings'

const playModeLabels: Record<PlayMode, string> = {
  sequential: '顺序播放',
  listLoop: '列表循环',
  repeat: '单曲循环',
  shuffle: '随机播放',
  heart: '心动模式'
}

export function getPlayModeLabel(mode: PlayMode): string {
  return playModeLabels[mode] ?? playModeLabels.sequential
}
