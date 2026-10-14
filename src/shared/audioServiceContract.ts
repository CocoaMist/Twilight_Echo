export const AUDIO_SERVICE_PROTOCOL_VERSION = 2

export const REQUIRED_AUDIO_SERVICE_DSP_METHODS = ['ApplyDspState', 'GetDspGraphStatus'] as const

export interface DspStatePayload {
  revision: number
  processing: Record<string, unknown>
  sceneId?: string | null
  graph: object
  /**
   * A complete scene graph is authoritative and may remove nodes. Slider and
   * other coalesced controls omit this flag so their graph payload is treated
   * as a field-level patch.
   */
  graphUpdateMode?: 'replace'
  bypassReason?: string
  requiresPcmFallback?: boolean
  dsdPcmFallbackApplied?: boolean
}

export function mergeDspStatePayload(
  current: DspStatePayload | null,
  incoming: DspStatePayload
): DspStatePayload {
  const merged: DspStatePayload = {
    ...(current ?? incoming),
    ...incoming,
    revision: incoming.revision,
    processing: {
      ...(current?.processing ?? {}),
      ...incoming.processing
    },
    graph:
      incoming.graphUpdateMode === 'replace'
        ? cloneGraph(incoming.graph)
        : mergeDspGraph(current?.graph, incoming.graph)
  }
  // `replace` describes this update, never a sticky property of later patches.
  if (incoming.graphUpdateMode !== 'replace') delete merged.graphUpdateMode
  return merged
}

type DspRecord = Record<string, unknown>

function asRecord(value: unknown): DspRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as DspRecord
}

function mergeRecord(current: unknown, incoming: unknown): DspRecord {
  return {
    ...(asRecord(current) ?? {}),
    ...(asRecord(incoming) ?? {})
  }
}

function cloneGraph(graph: object): DspRecord {
  const source = asRecord(graph) ?? {}
  const nodes = Array.isArray(source.nodes)
    ? source.nodes.map((node) => cloneDspGraphNode(node))
    : source.nodes
  return {
    ...source,
    ...(nodes === undefined ? {} : { nodes }),
    ...(asRecord(source.outputStage) ? { outputStage: { ...asRecord(source.outputStage) } } : {})
  }
}

function cloneDspGraphNode(node: unknown): unknown {
  const source = asRecord(node)
  if (!source) return node
  return {
    ...source,
    ...(asRecord(source.params) ? { params: { ...asRecord(source.params) } } : {}),
    ...(asRecord(source.vst3) ? { vst3: { ...asRecord(source.vst3) } } : {})
  }
}

function mergeDspGraph(currentGraph: object | undefined, incomingGraph: object): DspRecord {
  const current = asRecord(currentGraph) ?? {}
  const incoming = asRecord(incomingGraph) ?? {}
  const merged: DspRecord = {
    ...current,
    ...incoming
  }
  const currentNodes = Array.isArray(current.nodes) ? current.nodes : []
  const incomingNodes = Array.isArray(incoming.nodes) ? incoming.nodes : null
  if (incomingNodes) {
    merged.nodes = mergeDspGraphNodes(currentNodes, incomingNodes)
  } else if (Array.isArray(current.nodes)) {
    merged.nodes = currentNodes.map((node) => cloneDspGraphNode(node))
  }
  if (asRecord(current.outputStage) || asRecord(incoming.outputStage)) {
    merged.outputStage = mergeRecord(current.outputStage, incoming.outputStage)
  }
  return merged
}

function mergeDspGraphNodes(currentNodes: unknown[], incomingNodes: unknown[]): unknown[] {
  const merged = currentNodes.map((node) => cloneDspGraphNode(node))
  const indexes = new Map<string, number>()
  for (const [index, node] of merged.entries()) {
    const id = asRecord(node)?.id
    if (typeof id === 'string' && id) indexes.set(id, index)
  }
  for (const incomingNode of incomingNodes) {
    const node = asRecord(incomingNode)
    const id = node?.id
    if (typeof id !== 'string' || !id || !indexes.has(id)) {
      if (typeof id === 'string' && id) indexes.set(id, merged.length)
      merged.push(cloneDspGraphNode(incomingNode))
      continue
    }
    const index = indexes.get(id)!
    const current = asRecord(merged[index]) ?? {}
    merged[index] = {
      ...current,
      ...node,
      params: mergeRecord(current.params, node.params),
      ...(asRecord(current.vst3) || asRecord(node.vst3)
        ? { vst3: mergeRecord(current.vst3, node.vst3) }
        : {})
    }
  }
  return merged
}

export interface AudioServiceCapabilities {
  protocolVersion: number
  methods: string[]
  dspGraphRevisionAck: boolean
  nativeRuntime?: Record<string, string>
}

export function createAudioServiceCapabilities(methods: string[]): AudioServiceCapabilities {
  return {
    protocolVersion: AUDIO_SERVICE_PROTOCOL_VERSION,
    methods: [...methods],
    dspGraphRevisionAck: true
  }
}

export function validateAudioServiceCapabilities(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'audio service did not publish capabilities'
  }
  const capabilities = value as Partial<AudioServiceCapabilities>
  if (capabilities.protocolVersion !== AUDIO_SERVICE_PROTOCOL_VERSION) {
    return `unsupported audio service protocol: ${String(capabilities.protocolVersion ?? 'missing')}`
  }
  if (!Array.isArray(capabilities.methods)) {
    return 'audio service capability method list is missing'
  }
  const missing = REQUIRED_AUDIO_SERVICE_DSP_METHODS.filter(
    (method) => !capabilities.methods?.includes(method)
  )
  if (missing.length > 0) {
    return `audio service is missing required DSP methods: ${missing.join(', ')}`
  }
  if (capabilities.dspGraphRevisionAck !== true) {
    return 'audio service does not support DSP graph revision ACK'
  }
  return null
}
