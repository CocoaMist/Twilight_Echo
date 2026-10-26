/**
 * 播放进度采样策略（纯函数，便于单测）。
 *
 * 当前原生播放或委托队列使用原生 time-pos。未激活的本机引擎采样不能
 * 覆盖冷恢复的暂停进度或外部投放设备的时钟。
 */
export function shouldApplyNativeTimePosition(state: {
  nativePlaybackActive: boolean
  nativeQueueDelegated: boolean
}): boolean {
  return state.nativePlaybackActive || state.nativeQueueDelegated
}
