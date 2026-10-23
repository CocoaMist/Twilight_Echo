export interface StagedTrialCandidate {
  id: string
  main?: string
  type: string[]
  enabled: boolean
}

export interface StagedPluginTrialOptions<T extends StagedTrialCandidate> {
  candidate: T
  listActiveDescriptors: () => Promise<T[]>
  startJavaScriptCandidate: () => Promise<void>
  stopJavaScriptCandidate: () => Promise<void>
  syncDspChain: (descriptors: T[]) => Promise<void>
}

/**
 * Validates runtime-bearing staged candidates before their active state is
 * changed. Pure themes have no executable trial path and remain static-only.
 */
export async function trialStagedPluginCandidate<T extends StagedTrialCandidate>(
  options: StagedPluginTrialOptions<T>
): Promise<void> {
  const { candidate } = options
  if (candidate.main) {
    await options.startJavaScriptCandidate()
    await options.stopJavaScriptCandidate()
  }
  if (!candidate.type.includes('dsp')) return

  const activeDescriptors = await options.listActiveDescriptors()
  const trialDescriptors = [
    ...activeDescriptors.filter((descriptor) => descriptor.id !== candidate.id),
    { ...candidate, enabled: true }
  ]
  try {
    await options.syncDspChain(trialDescriptors)
  } finally {
    await options.syncDspChain(activeDescriptors)
  }
}
