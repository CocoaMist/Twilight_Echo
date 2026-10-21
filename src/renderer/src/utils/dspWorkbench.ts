import type { DspGraphNode, DspGraphStatus, DspScene } from '../../../shared/dspGraph.ts'

export type DspWorkspaceTab = 'equalizer' | 'chain' | 'library' | 'monitor' | 'output'
export const dspWorkspaceTabs: { id: DspWorkspaceTab; label: string; icon: string }[] = [
  { id: 'monitor', label: '检测', icon: 'pi pi-wave-pulse' },
  { id: 'equalizer', label: '均衡器', icon: 'pi pi-sliders-h' },
  { id: 'chain', label: '效果链', icon: 'pi pi-list' },
  { id: 'output', label: '输出与性能', icon: 'pi pi-microchip' },
  { id: 'library', label: '资料与插件', icon: 'pi pi-folder' }
]

export function dspApplyLabel(status: DspGraphStatus | null): string {
  if (!status) return '等待引擎'
  if (status.applyState === 'failed') return '应用失败'
  if (
    status.applyState === 'applied' &&
    status.requestedRevision !== undefined &&
    status.appliedRevision === status.requestedRevision &&
    status.revision === status.appliedRevision
  )
    return '已生效'
  return status.applyState === 'idle' ? '待命' : '等待引擎确认'
}

export function dspAssetReferences(scenes: DspScene[], assetId: string): string[] {
  return scenes
    .filter((scene) =>
      scene.graph.nodes.some(
        (node) =>
          node.params.impulseResponseAssetId === assetId ||
          node.params.correctionAssetId === assetId ||
          node.vst3?.stateAssetId === assetId
      )
    )
    .map((scene) => scene.name)
}

export function moveDspNode(nodes: DspGraphNode[], id: string, destinationId: string): boolean {
  const from = nodes.findIndex((node) => node.id === id)
  const to = nodes.findIndex((node) => node.id === destinationId)
  if (from < 0 || to < 0 || from === to) return false
  // ABI v1 is appended by the native host, not reordered within the v2 chain.
  if (
    [nodes[from], nodes[to]].some(
      (node) => node.type === 'nativePlugin' && node.pluginAbiVersion === 1
    )
  )
    return false
  const [node] = nodes.splice(from, 1)
  nodes.splice(to, 0, node)
  return true
}

export function normalizeDspSerialOrder(nodes: DspGraphNode[]): void {
  const fixed = (node: DspGraphNode) => node.type === 'nativePlugin' && node.pluginAbiVersion === 1
  nodes.splice(0, nodes.length, ...nodes.filter((node) => !fixed(node)), ...nodes.filter(fixed))
}

/** A bounded, serializable draft history. UI gestures decide when to checkpoint. */
export function createDspDraftHistory(initial: string) {
  let entries = [initial]
  let cursor = 0
  return {
    get canUndo() {
      return cursor > 0
    },
    get canRedo() {
      return cursor < entries.length - 1
    },
    reset(value: string) {
      entries = [value]
      cursor = 0
    },
    push(value: string) {
      if (entries[cursor] === value) return
      entries = entries.slice(0, cursor + 1)
      entries.push(value)
      if (entries.length > 80) entries.shift()
      cursor = entries.length - 1
    },
    undo() {
      if (cursor > 0) cursor--
      return entries[cursor]
    },
    redo() {
      if (cursor < entries.length - 1) cursor++
      return entries[cursor]
    }
  }
}

/** One in-flight diagnostic request; hiding cancels the next scheduled request. */
export function createDspDiagnosticsPoller(options: {
  read: () => Promise<void>
  visible: () => boolean
  playing: () => boolean
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  cancel?: (timer: ReturnType<typeof setTimeout>) => void
}) {
  const schedule = options.schedule ?? setTimeout
  const cancel = options.cancel ?? clearTimeout
  let timer: ReturnType<typeof setTimeout> | null = null
  let running: Promise<void> | null = null
  let stopped = true
  let generation = 0
  const clear = () => {
    if (timer !== null) cancel(timer)
    timer = null
  }
  const refresh = (): Promise<void> => {
    if (running) return running
    running = options.read().finally(() => {
      running = null
    })
    return running
  }
  async function tick(current: number): Promise<void> {
    clear()
    if (stopped || !options.visible()) return
    try {
      await refresh()
    } catch {
      /* The reader owns visible error feedback. */
    }
    if (!stopped && current === generation && options.visible())
      timer = schedule(() => void tick(current), options.playing() ? 250 : 1500)
  }
  return {
    refresh,
    async refreshAfterCurrent(): Promise<void> {
      // A read started before a write cannot acknowledge that write.
      if (running) await running.catch(() => undefined)
      return refresh()
    },
    update() {
      stopped = false
      generation++
      clear()
      if (options.visible()) void tick(generation)
    },
    stop() {
      stopped = true
      generation++
      clear()
    }
  }
}
