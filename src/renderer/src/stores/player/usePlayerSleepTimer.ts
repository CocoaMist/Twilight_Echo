import type { Ref } from 'vue'
import type {
  SleepTimerMode,
  SleepTimerSettings,
  SleepTimerShutdownHandoff,
  SleepTimerState
} from '../../../../shared/sleepTimer.ts'
import { createSleepTimerController, type SleepTimerBridge } from '../sleepTimerController.ts'
import { createSleepTimerFadeController } from '../sleepTimerFade.ts'

interface SleepTimerEvents {
  getState(): Promise<SleepTimerState | null>
  onState(callback: (state: SleepTimerState | null) => void): () => void
  onTrigger(callback: (state: SleepTimerState) => void): () => void
}

export interface PlayerSleepTimerOptions {
  volume: Ref<number>
  muted: Ref<boolean>
  isPlaying: Ref<boolean>
  isLoading: Ref<boolean>
  state: Ref<SleepTimerState | null>
  notice: Ref<string | null>
  getSettings: () => SleepTimerSettings
  getBridge: () => (SleepTimerBridge & Partial<SleepTimerEvents>) | null | undefined
  persistSession: () => void
  clearCrossfade: () => void
  stopVisualization: () => void
  stopRendererAudio: () => void
  stopNativeAudio: () => Promise<void>
}

export function createPlayerSleepTimer(options: PlayerSleepTimerOptions) {
  let fadeController: ReturnType<typeof createSleepTimerFadeController> | null = null
  let timerController: ReturnType<typeof createSleepTimerController> | null = null
  let pendingHandoff: ReturnType<
    ReturnType<typeof createSleepTimerFadeController>['prepareHandoff']
  > = null
  let started = false
  let disposed = false
  const subscriptions: Array<() => void> = []

  function clearIntervals(): void {
    fadeController?.clear()
  }

  function stopForSleepTimer(): void {
    options.clearCrossfade()
    options.stopVisualization()
    options.stopRendererAudio()
    void options.stopNativeAudio()
    options.isPlaying.value = false
    options.isLoading.value = false
    options.notice.value = '睡眠定时器已停止播放'
  }

  function beginSleepShutdown(state: SleepTimerState): void {
    getFadeController().begin(state)
  }

  function getFadeController(): ReturnType<typeof createSleepTimerFadeController> {
    if (!fadeController) {
      fadeController = createSleepTimerFadeController({
        getVolume: () => (options.muted.value ? 0 : options.volume.value),
        setVolume: (nextVolume) => {
          options.volume.value = nextVolume
          if (nextVolume > 0.001) options.muted.value = false
        },
        stop: stopForSleepTimer
      })
    }
    return fadeController
  }

  function getController(): ReturnType<typeof createSleepTimerController> {
    if (!timerController) {
      timerController = createSleepTimerController({
        bridge: options.getBridge(),
        getSettings: options.getSettings,
        getState: () => options.state.value,
        setState: (state) => {
          options.state.value = state
        },
        persistSession: options.persistSession,
        setNotice: (notice) => {
          options.notice.value = notice
        },
        onTriggered: beginSleepShutdown
      })
      if (disposed) timerController.dispose()
    }
    return timerController
  }

  function configure(mode: SleepTimerMode, minutes?: number): void {
    if (disposed) return
    fadeController?.clear({ restoreVolume: true })
    getController().configure(mode, minutes)
  }

  function cancel(): void {
    if (disposed) return
    fadeController?.clear({ restoreVolume: true })
    getController().cancel()
  }

  function interruptShutdown(): void {
    // Ordinary playback must not cancel an armed sleep timer. Once it has
    // fired, an explicit transport intent revokes both local and main execution.
    fadeController?.clear({ restoreVolume: true })
    if (options.state.value?.triggered) getController().cancel()
  }

  async function handoffForAfterglow(
    publish: (snapshot: {
      volume: number
      sleepShutdown?: SleepTimerShutdownHandoff
    }) => Promise<boolean>
  ): Promise<boolean> {
    if (!pendingHandoff?.isCurrent()) pendingHandoff = null
    const prepared = pendingHandoff ?? fadeController?.prepareHandoff()
    if (!prepared) return publish({ volume: options.volume.value })
    pendingHandoff = prepared
    const triggerRevision = prepared.snapshot.state.triggerRevision
    if (!triggerRevision) {
      prepared.resume()
      throw new Error('睡眠淡出缺少主进程执行身份，窗口已保留')
    }
    const sleepShutdown = {
      triggerRevision,
      startedAt: prepared.snapshot.startedAt,
      volume: prepared.snapshot.volume
    }
    try {
      const accepted = await publish({ volume: sleepShutdown.volume, sleepShutdown })
      if (accepted) prepared.accept()
      else prepared.resume()
      return accepted
    } catch (error) {
      let state: SleepTimerState | null | undefined
      let verified = false
      try {
        const bridge = options.getBridge()
        if (bridge?.getState) {
          state = await bridge.getState()
          verified = true
        }
      } catch {
        /* Keep execution frozen until explicit cancellation or another entry. */
      }
      if (
        verified &&
        state?.triggerRevision === triggerRevision &&
        state.shutdownOwner === 'main'
      ) {
        // Main accepted ownership before awaiting gain/volume ACKs. Re-read the
        // idempotent acceptance barrier before restoring the renderer's ref;
        // repeating this exact registration never replays gain or transport.
        try {
          if (await publish({ volume: sleepShutdown.volume, sleepShutdown })) {
            prepared.accept()
            return true
          }
        } catch {
          /* Main owns the execution; do not resume a second local fade. */
        }
        options.notice.value = '主进程已接管淡出，音量确认未返回，请稍后重试'
        throw error
      }
      if (verified && prepared.isCurrent()) {
        if (state?.triggerRevision === triggerRevision) prepared.resume()
        else fadeController?.clear({ restoreVolume: true })
      } else if (!verified) {
        options.notice.value = '睡眠淡出交接结果未确认，请取消定时器后重试'
      }
      throw error
    }
  }

  return {
    clearIntervals,
    getController,
    configure,
    cancel,
    interruptShutdown,
    handoffForAfterglow,
    start(): void {
      if (started || disposed) return
      started = true
      const bridge = options.getBridge()
      if (!bridge) return
      const controller = getController()
      const isCurrent = controller.capture()
      if (bridge.onState)
        subscriptions.push(
          bridge.onState((state) => {
            if (!state?.triggered) fadeController?.clear({ restoreVolume: true })
            controller.applyAuthoritativeState(state)
          })
        )
      if (bridge.onTrigger) subscriptions.push(bridge.onTrigger(controller.applyTrigger))
      void bridge
        .getState?.()
        .then((state) => {
          if (isCurrent() && state?.active) controller.applyAuthoritativeState(state)
        })
        .catch(() => {})
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      timerController?.dispose()
      clearIntervals()
      for (const stop of subscriptions.splice(0)) {
        try {
          stop()
        } catch {
          /* Release remaining subscriptions too. */
        }
      }
    }
  }
}
