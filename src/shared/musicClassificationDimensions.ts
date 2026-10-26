/** Classification facts retain their musical/source level; they are not quality ratings. */
export const CLASSIFICATION_DIMENSIONS = [
  'language',
  'region',
  'projectYear',
  'releaseYear',
  'albumType',
  'versionAttribute',
  'format',
  'bitDepth',
  'sampleRate',
  'management'
] as const
export type ClassificationDimension = (typeof CLASSIFICATION_DIMENSIONS)[number]
/** OR within one dimension, AND across dimensions, all on the same source row. */
export interface ClassificationFilter {
  dimension: ClassificationDimension
  values: string[]
}
export interface ClassificationFacetQuery {
  dimension: ClassificationDimension
  facetSearch?: string
  offset?: number
  limit?: number
}
export interface ClassificationFacetItem {
  value: string
  label: string
  count: number
}

export function validClassificationDimension(value: unknown): value is ClassificationDimension {
  return (
    typeof value === 'string' &&
    CLASSIFICATION_DIMENSIONS.includes(value as ClassificationDimension)
  )
}
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && !!v.trim() && v.length <= max && !v.includes('\0')
const uint = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
export function validClassificationFilters(value: unknown): value is ClassificationFilter[] {
  return (
    Array.isArray(value) &&
    value.length <= CLASSIFICATION_DIMENSIONS.length &&
    new Set(value.map((v) => (object(v) ? v.dimension : undefined))).size === value.length &&
    value.every(
      (v) =>
        object(v) &&
        Object.keys(v).every((k) => ['dimension', 'values'].includes(k)) &&
        validClassificationDimension(v.dimension) &&
        Array.isArray(v.values) &&
        v.values.length >= 1 &&
        v.values.length <= 64 &&
        v.values.every((x) => text(x, 128)) &&
        new Set(v.values).size === v.values.length
    )
  )
}
/** Validate the facet portion of a browse query without changing its entity search/scope. */
export function validClassificationFacetQuery(value: unknown): value is ClassificationFacetQuery {
  return (
    object(value) &&
    validClassificationDimension(value.dimension) &&
    (value.facetSearch === undefined ||
      (typeof value.facetSearch === 'string' &&
        value.facetSearch.length <= 512 &&
        !value.facetSearch.includes('\0'))) &&
    (value.offset === undefined || uint(value.offset)) &&
    (value.limit === undefined ||
      (uint(value.limit) && Number(value.limit) >= 1 && Number(value.limit) <= 200))
  )
}
export function classificationDimensionAvailability(dimension: ClassificationDimension): {
  available: boolean
  reason: string | null
} {
  if (dimension === 'language')
    return { available: false, reason: '当前来源未提供歌曲语言，未知可筛选' }
  if (dimension === 'versionAttribute')
    return { available: false, reason: '当前来源未提供版本属性，未知可筛选' }
  return { available: true, reason: null }
}
const MANAGEMENT_LABELS: Record<string, string> = {
  identified: '已识别',
  unidentified: '未识别',
  release_confirmed: '发行已确认',
  release_pending: '发行未确认',
  has_introduction: '已有介绍',
  missing_introduction: '缺介绍',
  source_indexed: '来源已索引',
  source_unknown: '来源状态未知',
  source_missing: '来源缺失'
}
const TYPE_LABELS: Record<string, string> = {
  album: '专辑',
  single: '单曲',
  ep: 'EP',
  compilation: '精选集',
  broadcast: '广播',
  other: '其他'
}
export function classificationFacetLabel(
  dimension: ClassificationDimension,
  value: string
): string {
  if (value === 'unknown') return '未知'
  if (dimension === 'management') return MANAGEMENT_LABELS[value] ?? value
  if (dimension === 'albumType') return TYPE_LABELS[value] ?? value
  if (dimension === 'bitDepth') return `${value}-bit`
  if (dimension === 'sampleRate') {
    const hz = Number(value)
    return Number.isFinite(hz) && hz >= 1000 ? `${hz / 1000} kHz` : `${value} Hz`
  }
  return value
}
