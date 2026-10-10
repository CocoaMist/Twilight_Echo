import type { Track } from '../types/music.ts'

export function equalBpmAnalysis(left: Track['bpmAnalysis'], right: Track['bpmAnalysis']): boolean {
  if (left === right) return true
  if (!left || !right) return false
  if (
    left.bpm !== right.bpm ||
    left.confidence !== right.confidence ||
    left.source !== right.source ||
    left.analyzedAt !== right.analyzedAt ||
    left.algorithmVersion !== right.algorithmVersion ||
    left.variableTempo !== right.variableTempo ||
    left.bpmRange?.[0] !== right.bpmRange?.[0] ||
    left.bpmRange?.[1] !== right.bpmRange?.[1]
  )
    return false
  const a = left.tempoMap ?? [],
    b = right.tempoMap ?? []
  return (
    a.length === b.length &&
    a.every((segment, i) => {
      const other = b[i]
      return (
        segment.startMs === other.startMs &&
        segment.endMs === other.endMs &&
        segment.bpm === other.bpm &&
        segment.confidence === other.confidence
      )
    })
  )
}
