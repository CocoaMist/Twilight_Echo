import {
  validMusicFocusQuery,
  type MusicFocusNode,
  type MusicFocusNumber,
  type MusicFocusQuery,
  type MusicFocusSortField
} from '../../../../shared/musicFocus.ts'

export const FOCUS_KINDS = [
  ['source', '来源与音频格式'],
  ['genre', '流派'],
  ['rating', '星级'],
  ['year', '年份'],
  ['tag', '标签'],
  ['notPlayedWithinDays', '最近未播放'],
  ['lastPlayed', '播放记录'],
  ['automaticPlaybackBlocked', '自动禁播'],
  ['preference', '收藏状态'],
  ['classification', '其他分类'],
  ['text', '名称查找'],
  ['all', '全部满足 (AND)'],
  ['any', '任一满足 (OR)'],
  ['not', '不满足 (NOT)']
] as const
export type FocusDraftKind = (typeof FOCUS_KINDS)[number][0]
export interface FocusDraftNode {
  id: string
  kind: FocusDraftKind
  fields: Record<string, string | boolean>
  children: FocusDraftNode[]
}
export interface FocusDraft {
  entity: MusicFocusQuery['entity']
  scope: 'library' | 'catalog'
  root: FocusDraftNode
  sort: Array<{ field: MusicFocusSortField; direction: 'asc' | 'desc' }>
}
let nextId = 0
export function newFocusNode(kind: FocusDraftKind = 'source'): FocusDraftNode {
  return {
    id: `condition-${++nextId}`,
    kind,
    fields:
      kind === 'rating'
        ? { mode: 'personal', gte: '4', exists: 'any' }
        : kind === 'year'
          ? { target: 'release', gte: '2000', exists: 'any' }
          : kind === 'genre'
            ? { id: '', label: '', includeDescendants: true }
            : kind === 'tag'
              ? { id: '', label: '' }
              : kind === 'notPlayedWithinDays'
                ? { days: '90' }
                : kind === 'lastPlayed'
                  ? { exists: 'missing' }
                  : kind === 'automaticPlaybackBlocked'
                    ? { blocked: false }
                    : kind === 'preference'
                      ? { value: 'favorite' }
                      : kind === 'classification'
                        ? { dimension: 'language', values: 'unknown' }
                        : kind === 'source'
                          ? { provider: 'local' }
                          : { value: '' },
    children: kind === 'not' ? [newFocusNode()] : []
  }
}
function numberFields(value: MusicFocusNumber, prefix = ''): FocusDraftNode['fields'] {
  return {
    ...Object.fromEntries(
      ['eq', 'gte', 'lte'].map((key) => [
        `${prefix}${key}`,
        value[key as 'eq' | 'gte' | 'lte'] == null ? '' : String(value[key as 'eq' | 'gte' | 'lte'])
      ])
    ),
    [`${prefix}exists`]: value.exists === undefined ? 'any' : value.exists ? 'present' : 'missing'
  }
}
export function focusNodeDraft(value: MusicFocusNode): FocusDraftNode {
  const kind = Object.keys(value)[0] as FocusDraftKind,
    node = newFocusNode(kind)
  if ('all' in value || 'any' in value)
    node.children = ('all' in value ? value.all : value.any).map(focusNodeDraft)
  else if ('not' in value) node.children = [focusNodeDraft(value.not)]
  else if ('source' in value)
    node.fields = {
      provider: value.source.provider ?? '',
      format: value.source.format ?? '',
      ...numberFields(value.source.bitDepth ?? {}, 'bitDepth.'),
      ...numberFields(value.source.sampleRate ?? {}, 'sampleRate.')
    }
  else if ('genre' in value)
    node.fields = { ...value.genre, includeDescendants: value.genre.includeDescendants ?? false }
  else if ('rating' in value)
    node.fields = {
      mode: value.rating.mode,
      provider: value.rating.provider ?? '',
      ...numberFields({
        gte: value.rating.gteStars,
        lte: value.rating.lteStars,
        exists: value.rating.exists
      })
    }
  else if ('year' in value) node.fields = { target: value.year.target, ...numberFields(value.year) }
  else if ('lastPlayed' in value) node.fields = numberFields(value.lastPlayed)
  else if ('tag' in value) node.fields = { id: value.tag.id }
  else if ('notPlayedWithinDays' in value) node.fields = { days: String(value.notPlayedWithinDays) }
  else if ('automaticPlaybackBlocked' in value)
    node.fields = { blocked: value.automaticPlaybackBlocked }
  else if ('preference' in value) node.fields = { value: value.preference }
  else if ('classification' in value)
    node.fields = {
      dimension: value.classification.dimension,
      values: value.classification.values.join('\n')
    }
  else if ('text' in value) node.fields = { value: value.text }
  return node
}
export const focusDraft = (query?: MusicFocusQuery): FocusDraft => ({
  entity: query?.entity ?? 'recording',
  scope: query?.scope ?? 'library',
  root: query?.where ? focusNodeDraft(query.where) : newFocusNode('all'),
  sort: query?.sort?.map((item) => ({ ...item })) ?? [{ field: 'title', direction: 'asc' }]
})
function parseNumber(fields: FocusDraftNode['fields'], prefix = ''): MusicFocusNumber {
  const value: MusicFocusNumber = {}
  if (fields[`${prefix}exists`] === 'missing') return { exists: false }
  if (fields[`${prefix}exists`] === 'present') value.exists = true
  for (const key of ['eq', 'gte', 'lte'] as const) {
    const raw = fields[`${prefix}${key}`]
    if (raw != null && String(raw).trim()) {
      if (!Number.isFinite(Number(raw)) || Number(raw) < 0)
        throw new Error('比较数值必须是非负数。')
      value[key] = Number(raw)
    }
  }
  return value
}
export function focusNodeQuery(node: FocusDraftNode): MusicFocusNode {
  const f = node.fields,
    text = (key: string) => String(f[key] ?? '').trim()
  switch (node.kind) {
    case 'all':
      return { all: node.children.map(focusNodeQuery) }
    case 'any':
      return { any: node.children.map(focusNodeQuery) }
    case 'not':
      if (!node.children.length) throw new Error('“不满足”分组需要一个条件。')
      return { not: focusNodeQuery(node.children[0]) }
    case 'genre':
      return { genre: { id: text('id'), includeDescendants: !!f.includeDescendants } }
    case 'tag':
      return { tag: { id: text('id') } }
    case 'source': {
      const bitDepth = parseNumber(f, 'bitDepth.'),
        sampleRate = parseNumber(f, 'sampleRate.')
      return {
        source: {
          ...(text('provider') ? { provider: text('provider') } : {}),
          ...(text('format') ? { format: text('format') } : {}),
          ...(Object.keys(bitDepth).length ? { bitDepth } : {}),
          ...(Object.keys(sampleRate).length ? { sampleRate } : {})
        }
      }
    }
    case 'rating': {
      const n = parseNumber(f)
      return {
        rating: {
          target: 'self',
          mode: text('mode') as 'personal' | 'base' | 'effective',
          ...(text('provider') ? { provider: text('provider') } : {}),
          ...(n.gte == null ? {} : { gteStars: n.gte }),
          ...(n.lte == null ? {} : { lteStars: n.lte }),
          ...(n.exists == null ? {} : { exists: n.exists })
        }
      }
    }
    case 'year':
      return { year: { target: text('target') as 'release' | 'project', ...parseNumber(f) } }
    case 'lastPlayed':
      return { lastPlayed: parseNumber(f) }
    case 'notPlayedWithinDays':
      return { notPlayedWithinDays: Number(text('days') || NaN) }
    case 'automaticPlaybackBlocked':
      return { automaticPlaybackBlocked: !!f.blocked }
    case 'preference':
      return { preference: text('value') as 'none' | 'favorite' | 'ban' }
    case 'classification':
      return {
        classification: {
          dimension: text('dimension') as Extract<
            MusicFocusNode,
            { classification: unknown }
          >['classification']['dimension'],
          values: text('values')
            .split('\n')
            .map((item) => item.trim())
            .filter(Boolean)
        }
      }
    case 'text':
      return { text: text('value') }
  }
}
export function compileFocusDraft(draft: FocusDraft): {
  query: MusicFocusQuery | null
  error: string
} {
  try {
    const query: MusicFocusQuery = {
      version: 1,
      entity: draft.entity,
      scope: draft.scope,
      ...(draft.root.kind === 'all' && !draft.root.children.length
        ? {}
        : { where: focusNodeQuery(draft.root) }),
      ...(draft.sort.length ? { sort: draft.sort.map((item) => ({ ...item })) } : {})
    }
    if (!validMusicFocusQuery(query))
      return {
        query: null,
        error: '请补全条件；最多 8 层、64 个条件，星级范围为 0–5，排序项不可重复。'
      }
    return { query, error: '' }
  } catch (error) {
    return { query: null, error: error instanceof Error ? error.message : String(error) }
  }
}
export function changeFocusNode(
  root: FocusDraftNode,
  id: string,
  change: (node: FocusDraftNode) => FocusDraftNode
): FocusDraftNode {
  if (root.id === id) return change(root)
  return { ...root, children: root.children.map((child) => changeFocusNode(child, id, change)) }
}
export function removeFocusNode(root: FocusDraftNode, id: string): FocusDraftNode {
  if (root.id === id) return newFocusNode('all')
  return {
    ...root,
    children: root.children
      .filter((child) => child.id !== id)
      .map((child) => removeFocusNode(child, id))
  }
}
