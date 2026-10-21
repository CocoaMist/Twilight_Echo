import type { DatabaseSync } from 'node:sqlite'
import type { LibraryPage, LibraryQuery } from '../../shared/libraryDatabase.ts'
import {
  createRecordingIdentityRules,
  recordingRemoteRef,
  recordingVersionHint,
  type RecordingIdentity,
  type RecordingVersion
} from '../../shared/recordingIdentity.ts'
import { RecordingCompatibilityGroup } from '../../shared/recordingGroup.ts'
import { getTrackSource, versionSourceKey } from '../../shared/trackSourceIdentity.ts'

type Row = Record<string, string | number | null>
type Group = {
  seq: number
  anchor: string
  compatibility: RecordingCompatibilityGroup
}
type Groups = Group | Group[]
const groupList = (groups: Groups | undefined): Group[] =>
  groups ? (Array.isArray(groups) ? groups : [groups]) : []
const pushGroup = <K>(map: Map<K, Groups>, key: K, group: Group): void => {
  const previous = map.get(key)
  if (!previous) map.set(key, group)
  else if (Array.isArray(previous)) previous.push(group)
  else map.set(key, [previous, group])
}
type Selected = {
  seq: number
  group: number
  duration: number
  meta: NonNullable<LibraryPage['aggregate']>['rows'][number]
}
type Selection = { rows: Selected[]; rowCount: number; memberCount: number; duration: number }
type SelectionBuild = Selection & {
  group: number
  cursor: number
  anchor: string
  all: number
  visible: number
  best?: { seq: number; track: RecordingIdentity }
  pinned?: { seq: number; track: RecordingIdentity }
}
type VariantKey = {
  seq: number
  preferred: number
  local: number
  lossless: number
  title: string
  id: string
}
type VariantRun = { keys: Array<VariantKey | undefined>; cursor: number }
type VariantBuild = { cursor: number; reading: boolean; heap: VariantRun[]; order: number[] }
const titleCollator = new Intl.Collator('zh'),
  idCollator = new Intl.Collator()
const compareVariants = (left: VariantKey, right: VariantKey) =>
  right.preferred - left.preferred ||
  right.local - left.local ||
  right.lossless - left.lossless ||
  titleCollator.compare(left.title, right.title) ||
  idCollator.compare(left.id, right.id) ||
  left.seq - right.seq
type State = {
  revision: number
  generation: number
  cursor: number
  phase: 'inputs' | 'groups' | 'ready'
  key: string
  bucket: Bucket | null
  dirty: boolean
  failed: boolean
  rules: ReturnType<typeof createRecordingIdentityRules>
  selections: Map<string, Selection>
  building: Map<string, SelectionBuild>
  variantOrders: Map<string, number[]>
  variantBuilds: Map<string, VariantBuild>
}
const text = (value: unknown) => (typeof value === 'string' ? value : '')
const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const losslessFormats = new Set([
  'flac',
  'alac',
  'wav',
  'wave',
  'aiff',
  'aif',
  'ape',
  'wv',
  'dsf',
  'dff',
  'mqa'
])
const lossless = (track: RecordingIdentity) =>
  losslessFormats.has(track.format?.trim().toLowerCase() ?? '') ||
  (typeof track.bitDepth === 'number' && track.bitDepth >= 16)

/** First-member constraints are necessary, not sufficient, for all-pairs
 * compatibility. Merge only the smallest candidate lists in insertion order,
 * then verify sufficient statistics. Dense same-provider ID/duration buckets
 * do not degenerate into scanning every preceding recording for each member. */
class Bucket {
  private count = 0
  private first?: Group
  // Most source/provider-ID entries in a dense bucket are singletons. Keep
  // the group directly until an alias actually needs an ordered list.
  private sources = new Map<string, Groups>()
  private hints = new Map<string, Groups>()
  private durations = new Map<number, Groups>()
  private providers = new Map<string | null, Groups>()
  private refs = new Map<string, Map<string, Groups>>()
  private unknownDuration: Group[] = []
  private readonly explicitVersion: boolean
  constructor(explicitVersion: boolean) {
    this.explicitVersion = explicitVersion
  }
  add(track: RecordingIdentity, seq: number): Group {
    const source = versionSourceKey(track),
      hint = recordingVersionHint(track),
      remote = recordingRemoteRef(track)
    const own = groupList(this.sources.get(source))
    let lists = [groupList(this.hints.get(hint)), own]
    const size = (items: Group[][]) => items.reduce((sum, list) => sum + list.length, 0)
    if (track.duration) {
      const duration = Number(track.duration),
        candidates = [this.unknownDuration, own]
      if (Number.isFinite(duration))
        for (const key of new Set([-1, 0, 1].map((delta) => Math.floor(duration / 8) + delta)))
          candidates.push(groupList(this.durations.get(key)))
      if (size(candidates) < size(lists)) lists = candidates
    }
    if (remote) {
      const matches = groupList(this.refs.get(remote.provider)?.get(remote.id))
      if (
        this.count -
          groupList(this.providers.get(remote.provider)).length +
          matches.length +
          own.length <
        size(lists)
      ) {
        lists = [
          matches,
          own,
          ...[...this.providers]
            .filter(([provider]) => provider !== remote.provider)
            .map(([, groups]) => groupList(groups))
        ]
      }
    }
    let group: Group | undefined
    if (this.explicitVersion) group = this.first
    else {
      const cursors = lists.map(() => 0)
      let previous = -1
      for (;;) {
        let candidate: Group | undefined,
          index = -1
        for (let i = 0; i < lists.length; i++) {
          const value = lists[i][cursors[i]]
          if (value && (!candidate || value.seq < candidate.seq)) {
            candidate = value
            index = i
          }
        }
        if (!candidate) break
        cursors[index]++
        if (candidate.seq === previous) continue
        previous = candidate.seq
        if (candidate.compatibility.accepts(track)) {
          group = candidate
          break
        }
      }
    }
    if (!group) {
      group = {
        seq,
        anchor: track.id,
        compatibility: new RecordingCompatibilityGroup()
      }
      this.count++
      this.first ??= group
      pushGroup(this.hints, hint, group)
      pushGroup(this.providers, remote?.provider ?? null, group)
      if (remote) {
        const refs = this.refs.get(remote.provider) ?? new Map<string, Groups>()
        pushGroup(refs, remote.id, group)
        this.refs.set(remote.provider, refs)
      }
      if (!track.duration) this.unknownDuration.push(group)
      else if (Number.isFinite(Number(track.duration)))
        pushGroup(this.durations, Math.floor(Number(track.duration) / 8), group)
    }
    if (!group.compatibility.hasSource(source)) {
      const previous = this.sources.get(source)
      if (!previous) this.sources.set(source, group)
      else {
        const list = groupList(previous)
        let left = 0,
          right = list.length
        while (left < right) {
          const middle = (left + right) >>> 1
          if (list[middle].seq < group.seq) left = middle + 1
          else right = middle
        }
        list.splice(left, 0, group)
        this.sources.set(source, list)
      }
    }
    group.compatibility.add(track)
    if (track.id < group.anchor) group.anchor = track.id
    return group
  }
}

/** Only identities and selected sort keys are retained. Membership and group
 * assignments live in TEMP SQL, owned by the same playlist lease. Preparation
 * closes every <=200-member transaction before the service yields its owner. */
export class LibraryDatabaseAggregateViews {
  private states = new Map<string, State>()
  private generation = 0
  private readonly sql: DatabaseSync
  private readonly transaction: <T>(action: () => T) => T
  private readonly statement: (query: string) => ReturnType<DatabaseSync['prepare']>
  constructor(
    sql: DatabaseSync,
    transaction: <T>(action: () => T) => T,
    statement: (query: string) => ReturnType<DatabaseSync['prepare']>
  ) {
    this.sql = sql
    this.transaction = transaction
    this.statement = statement
  }
  initialize(): void {
    this.sql
      .exec(`CREATE TEMP TABLE aggregate_inputs(view_id TEXT NOT NULL,seq INTEGER NOT NULL,generation INTEGER NOT NULL,
      recording_key TEXT NOT NULL,identity TEXT NOT NULL,source TEXT NOT NULL,source_key TEXT NOT NULL,group_seq INTEGER,PRIMARY KEY(view_id,seq));
      CREATE INDEX aggregate_input_order ON aggregate_inputs(view_id,generation,recording_key,seq);
      CREATE INDEX aggregate_group_order ON aggregate_inputs(view_id,generation,group_seq,seq) WHERE group_seq IS NOT NULL;
      CREATE INDEX aggregate_source_identity ON aggregate_inputs(view_id,generation,group_seq,source_key) WHERE group_seq IS NOT NULL;
      CREATE TEMP TABLE aggregate_groups(view_id TEXT NOT NULL,seq INTEGER NOT NULL,generation INTEGER NOT NULL,anchor TEXT NOT NULL,PRIMARY KEY(view_id,seq));`)
  }
  drop(id: string): void {
    this.states.delete(id)
  }
  hasRows(id: string): boolean {
    return !!this.statement(
      'SELECT 1 FROM aggregate_inputs WHERE view_id=? UNION ALL SELECT 1 FROM aggregate_groups WHERE view_id=? LIMIT 1'
    ).get(id, id)
  }
  cleanup(id: string, limit: number, generation?: number): number {
    let removed = 0
    for (const table of ['aggregate_inputs', 'aggregate_groups']) {
      if (removed >= limit) break
      removed += Number(
        this.statement(
          `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE view_id=? ${generation === undefined ? '' : 'AND generation<>?'} LIMIT ?)`
        ).run(
          ...(generation === undefined ? [id, limit - removed] : [id, generation, limit - removed])
        ).changes
      )
    }
    return removed
  }
  get needsMaintenance(): boolean {
    return [...this.states.values()].some((state) => state.dirty)
  }
  maintenance(): void {
    const entry = [...this.states].find(([, state]) => state.dirty)
    if (!entry) return
    const [id, state] = entry
    const removed = this.transaction(() => this.cleanup(id, 200, state.generation))
    if (removed < 200) state.dirty = false
  }
  prepare(id: string, revision: number, versions: RecordingVersion[]): boolean {
    let state = this.states.get(id)
    if (!state || state.revision !== revision || state.failed) {
      const preferences = new Map(
        versions.flatMap((version) => version.sources.map((source) => [source, version] as const))
      )
      state = {
        revision,
        generation: ++this.generation,
        cursor: -1,
        key: '',
        phase: 'inputs',
        bucket: null,
        dirty: true,
        failed: false,
        rules: createRecordingIdentityRules((key) => preferences.get(key)),
        selections: new Map(),
        building: new Map(),
        variantOrders: new Map(),
        variantBuilds: new Map()
      }
      this.states.set(id, state)
    }
    if (state.phase === 'ready') return true
    const current = state
    try {
      if (current.phase === 'inputs') {
        const payload = 'COALESCE(m.snapshot,t.payload)'
        const fields = [
          'filePath',
          'fileName',
          'title',
          'artist',
          'album',
          'duration',
          'format',
          'bitDepth',
          'subTrack',
          'cueRange',
          'ncmSongId'
        ]
        const rows = this.statement(
          `SELECT m.seq,json_object('id',m.id,'source',m.provider,${fields.map((field) => `'${field}',json_extract(${payload},'$.${field}')`).join(',')}) AS identity
          FROM playlist_members m LEFT JOIN tracks t ON t.id=m.local_id WHERE m.view_id=? AND m.seq>? ORDER BY m.seq LIMIT 200`
        ).all(id, current.cursor) as Row[]
        this.transaction(() => {
          const inputs = rows.map((row) => {
            const track = this.identity(text(row.identity))
            return {
              seq: Number(row.seq),
              key: current.rules.getRecordingTrackKey(track),
              identity: JSON.stringify(track),
              source: getTrackSource(track),
              sourceKey: versionSourceKey(track)
            }
          })
          this.statement(
            `INSERT INTO aggregate_inputs
            SELECT ?,json_extract(value,'$.seq'),?,json_extract(value,'$.key'),json_extract(value,'$.identity'),
              json_extract(value,'$.source'),json_extract(value,'$.sourceKey'),NULL FROM json_each(?) WHERE 1
            ON CONFLICT(view_id,seq) DO UPDATE SET generation=excluded.generation,recording_key=excluded.recording_key,
              identity=excluded.identity,source=excluded.source,source_key=excluded.source_key,group_seq=NULL`
          ).run(id, current.generation, JSON.stringify(inputs))
        })
        if (rows.length) current.cursor = Number(rows.at(-1)!.seq)
        if (rows.length < 200) {
          current.phase = 'groups'
          current.cursor = -1
        }
      } else {
        const rows = this.statement(
          `SELECT rowid,seq,recording_key,identity FROM aggregate_inputs WHERE view_id=? AND generation=?
          AND (recording_key,seq)>(?,?) ORDER BY recording_key,seq LIMIT 200`
        ).all(id, current.generation, current.key, current.cursor) as Row[]
        this.transaction(() => {
          const changed = new Map<number, Group>()
          const assignments: Record<string, number> = Object.create(null)
          for (const row of rows) {
            const key = text(row.recording_key)
            if (key !== current.key) {
              current.key = key
              current.bucket = new Bucket(key.startsWith('version:'))
            }
            const group = current.bucket!.add(
              JSON.parse(text(row.identity)) as RecordingIdentity,
              Number(row.seq)
            )
            changed.set(group.seq, group)
            assignments[String(row.rowid)] = group.seq
          }
          // These private rowids were selected above in the same synchronous
          // turn. Seek only this window; UPDATE FROM can choose a full-generation
          // scan for every batch even when the input has only 200 assignments.
          const assignmentJson = JSON.stringify(assignments)
          this.statement(
            `UPDATE aggregate_inputs SET group_seq=json_extract(?, '$.'||rowid)
            WHERE rowid IN (SELECT CAST(key AS INTEGER) FROM json_each(?))`
          ).run(assignmentJson, assignmentJson)
          this.statement(
            `INSERT INTO aggregate_groups
            SELECT ?,json_extract(value,'$.seq'),?,json_extract(value,'$.anchor') FROM json_each(?) WHERE 1
            ON CONFLICT(view_id,seq) DO UPDATE SET generation=excluded.generation,anchor=excluded.anchor`
          ).run(
            id,
            current.generation,
            JSON.stringify([...changed.values()].map(({ seq, anchor }) => ({ seq, anchor })))
          )
        })
        if (rows.length) current.cursor = Number(rows.at(-1)!.seq)
        if (rows.length < 200) {
          current.phase = 'ready'
          current.bucket = null
          current.dirty = true
        }
      }
      return current.phase === 'ready'
    } catch (error) {
      current.failed = true
      current.bucket = null
      current.selections.clear()
      current.building.clear()
      throw error
    }
  }
  private identity(json: string): RecordingIdentity {
    const track = JSON.parse(json) as RecordingIdentity & { fileName?: unknown }
    // Match the displayed libraryTrack fallback fields for legacy partial rows;
    // grouping/search/variant order must use what the paged caller actually sees.
    const fileName =
      typeof track.fileName === 'string'
        ? track.fileName
        : text(track.filePath).split(/[\\/]/).pop() || track.id
    track.title = typeof track.title === 'string' ? track.title : fileName
    track.artist = typeof track.artist === 'string' ? track.artist : '未知艺术家'
    track.album = typeof track.album === 'string' ? track.album : '未知专辑'
    track.duration = number(track.duration)
    delete track.fileName
    for (const key of Object.keys(track))
      if (track[key as keyof RecordingIdentity] === null)
        delete (track as unknown as Record<string, unknown>)[key]
    return track
  }
  private ready(id: string): State {
    const state = this.states.get(id)
    if (!state || state.failed || state.phase !== 'ready')
      throw new Error('Aggregate playlist projection is not ready')
    return state
  }
  private compare(left: RecordingIdentity, right: RecordingIdentity, state: State): number {
    const preferred = (track: RecordingIdentity) =>
      state.rules.preferredSourceKey(track) === versionSourceKey(track) ? 1 : 0
    return (
      preferred(right) - preferred(left) ||
      Number(getTrackSource(right) === 'local') - Number(getTrackSource(left) === 'local') ||
      Number(lossless(right)) - Number(lossless(left)) ||
      titleCollator.compare(left.title, right.title) ||
      idCollator.compare(left.id, right.id)
    )
  }
  private selectionKey(query: LibraryQuery): string {
    return JSON.stringify([
      query.aggregate!.hiddenSources ?? [],
      query.aggregate!.variantPreferences ?? {},
      query.search?.trim().toLowerCase() ?? ''
    ])
  }
  prepareSelection(query: LibraryQuery): boolean {
    const id = query.playlistView!,
      state = this.ready(id),
      options = query.aggregate!,
      keyword = query.search?.trim().toLowerCase() ?? ''
    const key = this.selectionKey(query)
    const cached = state.selections.get(key)
    if (cached) {
      state.selections.delete(key)
      state.selections.set(key, cached)
      return true
    }
    const hidden = new Set(options.hiddenSources ?? []),
      preferences = options.variantPreferences ?? {}
    let build = state.building.get(key)
    if (!build) {
      if (state.building.size >= 4) throw new Error('Too many aggregate selection queries')
      build = {
        rows: [],
        rowCount: 0,
        memberCount: 0,
        duration: 0,
        group: -1,
        cursor: -1,
        anchor: '',
        all: 0,
        visible: 0
      }
      state.building.set(key, build)
    }
    const current = build
    const present = this
      .statement(`SELECT 1 FROM aggregate_inputs WHERE view_id=? AND generation=? AND group_seq=? AND source_key=?
      AND source NOT IN (SELECT value FROM json_each(?)) LIMIT 1`)
    const hiddenJson = JSON.stringify([...hidden])
    const finish = () => {
      const { pinned, best, anchor, group, all, visible } = current
      const selected = pinned ?? best
      if (!selected) return
      current.rowCount++
      const track = selected.track
      if (
        keyword &&
        !`${track.title} ${track.artist} ${track.album ?? ''}`.toLowerCase().includes(keyword)
      )
        return
      const preferred = state.rules.preferredSourceKey(track)
      const duration = Math.max(0, number(track.duration))
      current.duration += duration
      current.rows.push({
        seq: selected.seq,
        group,
        duration,
        meta: {
          rowId: String(group),
          anchorTrackId: anchor,
          variantCount: all,
          visibleVariantCount: visible,
          variantPinned: !!pinned,
          preferenceUnavailable:
            !pinned &&
            !!preferred &&
            !present.get(id, state.generation, group, preferred, hiddenJson)
        }
      })
    }
    try {
      const rows = this.statement(
        `SELECT i.seq,i.group_seq,i.identity,i.source,g.anchor FROM aggregate_inputs i
      JOIN aggregate_groups g ON g.view_id=i.view_id AND g.seq=i.group_seq AND g.generation=i.generation
      WHERE i.view_id=? AND i.generation=? AND i.group_seq IS NOT NULL AND (i.group_seq,i.seq)>(?,?) ORDER BY i.group_seq,i.seq LIMIT 200`
      ).all(id, state.generation, current.group, current.cursor) as Row[]
      for (const row of rows) {
        const next = Number(row.group_seq)
        if (next !== current.group) {
          finish()
          current.group = next
          current.anchor = text(row.anchor)
          current.all = 0
          current.visible = 0
          current.best = undefined
          current.pinned = undefined
        }
        current.cursor = Number(row.seq)
        current.memberCount++
        current.all++
        if (hidden.has(text(row.source))) continue
        current.visible++
        const track = JSON.parse(text(row.identity)) as RecordingIdentity,
          candidate = { seq: Number(row.seq), track }
        if (!current.best || this.compare(track, current.best.track, state) < 0)
          current.best = candidate
        if (
          Object.hasOwn(preferences, current.anchor) &&
          preferences[current.anchor] === row.source &&
          (!current.pinned || this.compare(track, current.pinned.track, state) < 0)
        )
          current.pinned = candidate
      }
      if (rows.length === 200) return false
      finish()
      const result = {
        rows: current.rows,
        rowCount: current.rowCount,
        memberCount: current.memberCount,
        duration: current.duration
      }
      state.building.delete(key)
      state.selections.set(key, result)
      while (state.selections.size > 3)
        state.selections.delete(state.selections.keys().next().value!)
      return true
    } catch (error) {
      state.building.delete(key)
      throw error
    }
  }
  selection(query: LibraryQuery): Selection {
    while (!this.prepareSelection(query)) {
      /* Synchronous internal compatibility. */
    }
    return this.ready(query.playlistView!).selections.get(this.selectionKey(query))!
  }
  private variantKey(query: LibraryQuery): string {
    return JSON.stringify([query.aggregate!.variantRow, query.aggregate!.hiddenSources ?? []])
  }
  prepareVariants(query: LibraryQuery): boolean {
    const id = query.playlistView!,
      state = this.ready(id),
      group = Number(query.aggregate!.variantRow)
    if (
      !this.statement(
        'SELECT 1 FROM aggregate_groups WHERE view_id=? AND seq=? AND generation=?'
      ).get(id, group, state.generation)
    )
      throw new Error('Aggregate recording row no longer exists')
    const hidden = new Set(query.aggregate!.hiddenSources ?? [])
    const key = this.variantKey(query)
    const cached = state.variantOrders.get(key)
    if (cached) {
      state.variantOrders.delete(key)
      state.variantOrders.set(key, cached)
      return true
    }
    let build = state.variantBuilds.get(key)
    if (!build) {
      if (state.variantBuilds.size >= 4) throw new Error('Too many aggregate variant queries')
      build = { cursor: -1, reading: true, heap: [], order: [] }
      state.variantBuilds.set(key, build)
    }
    const heap = build.heap,
      less = (left: VariantRun, right: VariantRun) =>
        compareVariants(left.keys[left.cursor]!, right.keys[right.cursor]!) < 0
    const push = (run: VariantRun) => {
      let index = heap.length
      heap.push(run)
      while (index > 0) {
        const parent = (index - 1) >>> 1
        if (!less(run, heap[parent])) break
        heap[index] = heap[parent]
        index = parent
      }
      heap[index] = run
    }
    try {
      if (build.reading) {
        const rows = this.statement(
          `SELECT seq,identity,source FROM aggregate_inputs
            WHERE view_id=? AND generation=? AND group_seq=? AND seq>? ORDER BY seq LIMIT 200`
        ).all(id, state.generation, group, build.cursor) as Row[]
        const keys: VariantKey[] = []
        for (const row of rows) {
          if (hidden.has(text(row.source))) continue
          const track = JSON.parse(text(row.identity)) as RecordingIdentity
          keys.push({
            seq: Number(row.seq),
            preferred: state.rules.preferredSourceKey(track) === versionSourceKey(track) ? 1 : 0,
            local: row.source === 'local' ? 1 : 0,
            lossless: lossless(track) ? 1 : 0,
            title: track.title,
            id: track.id
          })
        }
        if (keys.length) push({ keys: keys.sort(compareVariants), cursor: 0 })
        if (rows.length) build.cursor = Number(rows.at(-1)!.seq)
        build.reading = rows.length === 200
        return false
      }
      // Merge sorted <=200-key runs with a heap, yielding after 200 output IDs.
      // No full identity array or one uninterruptible million-member sort.
      for (let count = 0; count < 200 && heap.length; count++) {
        const first = heap[0],
          last = heap.pop()!
        if (heap.length) {
          let index = 0
          while (index * 2 + 1 < heap.length) {
            let child = index * 2 + 1
            if (child + 1 < heap.length && less(heap[child + 1], heap[child])) child++
            if (!less(heap[child], last)) break
            heap[index] = heap[child]
            index = child
          }
          heap[index] = last
        }
        build.order.push(first.keys[first.cursor]!.seq)
        first.keys[first.cursor++] = undefined
        if (first.cursor < first.keys.length) push(first)
      }
      if (heap.length) return false
    } catch (error) {
      state.variantBuilds.delete(key)
      throw error
    }
    state.variantOrders.set(key, build.order)
    state.variantBuilds.delete(key)
    while (state.variantOrders.size > 3)
      state.variantOrders.delete(state.variantOrders.keys().next().value!)
    return true
  }
  variants(query: LibraryQuery): number[] {
    while (!this.prepareVariants(query)) {
      /* Internal synchronous compatibility. */
    }
    return this.ready(query.playlistView!).variantOrders.get(this.variantKey(query))!
  }
}
