import type { MiniPlayerStateSnapshot } from './miniPlayer.ts'
import type { MotionPreference } from './motion.ts'

export type TrayNavigationTarget = 'local' | 'streaming' | 'settings'

export interface TrayPlayerBootstrap {
  state: MiniPlayerStateSnapshot
  motionPreference: MotionPreference
}

export function normalizeTrayNavigationTarget(value: unknown): TrayNavigationTarget | null {
  return value === 'local' || value === 'streaming' || value === 'settings' ? value : null
}
