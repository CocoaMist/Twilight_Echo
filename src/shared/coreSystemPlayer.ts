import type { MiniPlayerCommand } from './miniPlayer.ts'
import type { CoreLyricsContent, CoreLyricsCurrent, CoreLyricsState } from './coreLyrics.ts'

export type CoreSystemPlaybackAction =
  | MiniPlayerCommand
  | { type: 'stop' }
  | { type: 'volume-step'; direction: 'volumeUp' | 'volumeDown' }
  | { type: 'queue-jump'; id: string; revision: number; index: number; occurrenceId: string }

export interface CorePlayerPresentation {
  current: CoreLyricsCurrent | null
  cover: string | null
  coverSource: string | null
  favorite: { available: boolean; liked: boolean; loading: boolean }
}

export interface CoreSystemLyrics {
  state: CoreLyricsState
  content: CoreLyricsContent
}
