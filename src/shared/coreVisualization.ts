import type { VisualizationData, VisualizationOptions } from './audioEngineTypes.ts'

export interface CoreVisualizationSubscribe {
  subscriptionId: string
  options?: VisualizationOptions
}

/** High-frequency stream, independent from the ordered Core state snapshot. */
export interface CoreVisualizationEvent {
  kind: 'visualization'
  epoch: string
  subscriptionId: string
  sequence: number
  data: VisualizationData | null
  error?: string
}
