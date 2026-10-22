import {
  recordingRemoteRef,
  recordingVersionHint,
  type RecordingIdentity
} from './recordingIdentity.ts'
import { versionSourceKey } from './trackSourceIdentity.ts'

type Provider = { count: number; refs: Map<string, number> }
type Summary = {
  count: number
  hints: Map<string, number>
  providers: Map<string, Provider>
  truthy: number
  invalid: number
  min: number
  max: number
}
type Extreme = { source: string; value: number }
type Member = {
  source: string
  hint: string
  remote: ReturnType<typeof recordingRemoteRef>
  duration: number | undefined
}
const member = (track: RecordingIdentity): Member => ({
  source: versionSourceKey(track),
  hint: recordingVersionHint(track),
  remote: recordingRemoteRef(track),
  duration: track.duration
})

/** Exact all-pairs compatibility within one unversioned recording-key bucket.
 * Identical source keys bypass hint/provider/duration checks. Keep sufficient
 * statistics per source, never the group's Track objects or a quadratic graph. */
export class RecordingCompatibilityGroup {
  count = 0
  private first: Member | undefined
  private sources!: Map<string, Summary>
  private hints!: Map<string, number>
  private providers!: Map<string, Provider>
  private truthy = 0
  private invalid = 0
  private minimum!: Extreme[]
  private maximum!: Extreme[]
  hasSource(source: string): boolean {
    return this.first ? this.first.source === source : (this.sources?.has(source) ?? false)
  }
  accepts(track: RecordingIdentity): boolean {
    if (!this.count) return true
    if (this.first) {
      const next = member(track),
        first = this.first
      if (next.source === first.source) return true
      if (
        next.hint !== first.hint ||
        (next.remote &&
          first.remote &&
          next.remote.provider === first.remote.provider &&
          next.remote.id !== first.remote.id)
      )
        return false
      return !next.duration || !first.duration || Math.abs(next.duration - first.duration) <= 8
    }
    const source = versionSourceKey(track),
      own = this.sources.get(source),
      others = this.count - (own?.count ?? 0)
    if (!others) return true
    const hint = recordingVersionHint(track)
    if ((this.hints.get(hint) ?? 0) - (own?.hints.get(hint) ?? 0) !== others) return false
    const remote = recordingRemoteRef(track)
    if (remote) {
      const total = this.providers.get(remote.provider),
        excluded = own?.providers.get(remote.provider)
      if (
        (total?.count ?? 0) - (excluded?.count ?? 0) !==
        (total?.refs.get(remote.id) ?? 0) - (excluded?.refs.get(remote.id) ?? 0)
      )
        return false
    }
    if (!track.duration) return true
    const duration = Number(track.duration)
    if (!Number.isFinite(duration)) return this.truthy - (own?.truthy ?? 0) === 0
    if (this.invalid - (own?.invalid ?? 0)) return false
    const min = this.minimum.find((item) => item.source !== source),
      max = this.maximum.find((item) => item.source !== source)
    return (
      (!min || Math.abs(duration - min.value) <= 8) && (!max || Math.abs(duration - max.value) <= 8)
    )
  }
  add(track: RecordingIdentity): void {
    const next = member(track)
    // Most dense provider buckets contain singleton groups. Allocate their
    // sufficient-statistics maps only if a second member actually joins.
    if (!this.count) {
      this.first = next
      this.count = 1
      return
    }
    if (this.first) {
      const first = this.first
      this.first = undefined
      this.sources = new Map()
      this.hints = new Map()
      this.providers = new Map()
      this.minimum = []
      this.maximum = []
      this.count = 0
      this.addMember(first)
    }
    this.addMember(next)
  }
  private addMember({ source, hint, remote, duration: rawDuration }: Member): void {
    const own = this.sources.get(source) ?? {
      count: 0,
      hints: new Map(),
      providers: new Map(),
      truthy: 0,
      invalid: 0,
      min: Infinity,
      max: -Infinity
    }
    this.sources.set(source, own)
    this.count++
    own.count++
    own.hints.set(hint, (own.hints.get(hint) ?? 0) + 1)
    this.hints.set(hint, (this.hints.get(hint) ?? 0) + 1)
    if (remote)
      for (const map of [this.providers, own.providers]) {
        const stats = map.get(remote.provider) ?? { count: 0, refs: new Map<string, number>() }
        stats.count++
        stats.refs.set(remote.id, (stats.refs.get(remote.id) ?? 0) + 1)
        map.set(remote.provider, stats)
      }
    if (!rawDuration) return
    own.truthy++
    this.truthy++
    const duration = Number(rawDuration)
    if (!Number.isFinite(duration)) {
      own.invalid++
      this.invalid++
      return
    }
    own.min = Math.min(own.min, duration)
    own.max = Math.max(own.max, duration)
    this.minimum = [
      ...this.minimum.filter((item) => item.source !== source),
      { source, value: own.min }
    ]
      .sort((a, b) => a.value - b.value)
      .slice(0, 2)
    this.maximum = [
      ...this.maximum.filter((item) => item.source !== source),
      { source, value: own.max }
    ]
      .sort((a, b) => b.value - a.value)
      .slice(0, 2)
  }
}
