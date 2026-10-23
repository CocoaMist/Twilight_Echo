export interface CoreAbLoopState {
  revision: number
  occurrenceId: string | null
  a: number | null
  b: number | null
  mode: 'off' | 'pending' | 'native' | 'soft'
}

export interface CoreAbLoopCommand {
  revision: number
  occurrenceId: string
  action: 'a' | 'b' | 'toggle' | 'clear'
  position?: number
}
