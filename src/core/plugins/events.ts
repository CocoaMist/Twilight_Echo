export interface PluginPlaybackEventSnapshot {
  source: string
  state: 'stopped' | 'playing' | 'paused'
  position: number
  duration: number
  queueIndex: number
  codec?: string
}

export interface PluginPlaybackEvent {
  name: string
  payload: unknown
}

export function derivePlaybackEvents(
  previous: PluginPlaybackEventSnapshot | null,
  current: PluginPlaybackEventSnapshot
): PluginPlaybackEvent[] {
  const events: PluginPlaybackEvent[] = [
    {
      name: 'player:progress',
      payload: {
        source: current.source,
        position: current.position,
        duration: current.duration
      }
    }
  ]

  if (!previous) {
    if (current.source) events.push({ name: 'player:track-change', payload: current })
    pushStateEvent(events, current)
    return events
  }

  if (
    previous.source !== current.source ||
    previous.queueIndex !== current.queueIndex ||
    previous.codec !== current.codec
  ) {
    events.push({ name: 'player:track-change', payload: current })
  }

  if (previous.state !== current.state) {
    pushStateEvent(events, current)
  }

  return events
}

function pushStateEvent(events: PluginPlaybackEvent[], current: PluginPlaybackEventSnapshot): void {
  if (current.state === 'playing') events.push({ name: 'player:play', payload: current })
  if (current.state === 'paused') events.push({ name: 'player:pause', payload: current })
  if (current.state === 'stopped') events.push({ name: 'player:stop', payload: current })
}
