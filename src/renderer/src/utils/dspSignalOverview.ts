import type { DspGraphStatus, DspSceneState } from '../../../shared/dspGraph.ts'

export function dspSampleRate(rate: number | null | undefined): string {
  return rate && Number.isFinite(rate) && rate > 0
    ? `${Number((rate / 1000).toFixed(2))} kHz`
    : '— kHz'
}

export function dspSignalNodes(
  state: DspSceneState | null,
  status: DspGraphStatus | null,
  bypassed: boolean
) {
  const sceneId = status?.activeSceneId ?? state?.activeSceneId
  const graph = state?.scenes.find((scene) => scene.id === sceneId)?.graph
  const nodes = status?.nodes.length ? status.nodes : (graph?.nodes ?? [])
  return nodes.map((node) => {
    const live = status?.nodes.find((entry) => entry.id === node.id)
    const active = !bypassed && live?.active === true && !live.bypassed
    const off = bypassed || live?.bypassed === true || !node.enabled
    return {
      id: node.id,
      type: node.type,
      active,
      state: off ? '已旁路' : active ? '运行中' : live ? '待命' : '待确认',
      reason: live?.bypassReason || '',
      configured: graph?.nodes.some((entry) => entry.id === node.id) === true
    }
  })
}
