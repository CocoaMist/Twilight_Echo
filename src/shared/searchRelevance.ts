import { normalizeSearchText } from './trackSearchText.ts'
import { getPinyinInitials, isCjkChar } from './pinyinInitials.ts'

export interface SearchableTrackFields {
  title: string
  artist: string
  album: string
  fileName?: string
  normTitle?: string
  normArtist?: string
  normAlbum?: string
  titleInitials?: string
  artistInitials?: string
  albumInitials?: string
  normFileName?: string
}

export interface SearchPersonalSignals {
  favorite?: boolean
  banned?: boolean
  playCount?: number
  lastPlayed?: number
}

export interface SearchRelevanceOptions {
  searchFileName?: boolean
  signals?: SearchPersonalSignals
  typoPenaltyFactor?: number
}

export interface SearchRelevanceBreakdown {
  exact: number
  prefix: number
  phrase: number
  ftsBm25: number
  favorite: number
  playCount: number
  typoPenaltyFactor: number
  total: number
}

export interface PreparedSearchFields {
  rawTitle: string
  rawArtist: string
  rawAlbum: string
  normTitle: string
  normArtist: string
  normAlbum: string
  titleInitials: string
  artistInitials: string
  albumInitials: string
  normFileName: string
  titleWords: string[]
  artistWords: string[]
  albumWords: string[]
}

export interface PreparedSearchQuery {
  raw: string
  fullNormalized: string
  tokens: string[]
  isMultiToken: boolean
  typoPenaltyFactor: number
}

export interface SymSpellSuggestion {
  term: string
  distance: number
  frequency: number
  score: number
}

export interface SymSpellQuerySuggestion {
  originalQuery: string
  correctedQuery: string
  tokens: string[]
  totalDistance: number
  penaltyFactor: number
}

export const FIELD_BOOST = {
  title: 5.0,
  artist: 3.0,
  titleInitials: 2.0,
  album: 1.5,
  artistInitials: 1.4,
  albumInitials: 1.0,
  fileName: 0.5
} as const

export const FIELD_AVG_LEN = {
  title: 10,
  artist: 8,
  album: 12,
  initials: 5,
  fileName: 14
} as const

const BM25_K1 = 1.2
const BM25_B = 0.2
const PHRASE_COMPOUND_RATE = 1.05

const CJK_EXTENDED_PATTERN =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u
const PURE_DIGITS_PATTERN = /^\d+$/
const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from'])

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

export function tokenizeWords(text: string): string[] {
  if (!text) return []
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/gu)
    .filter(Boolean)
}

export function prepareSearchQuery(query: string, typoPenaltyFactor = 1): PreparedSearchQuery {
  const raw = query.trim()
  const fullNormalized = normalizeSearchText(raw)
  const tokens = raw
    ? raw
        .split(/\s+/u)
        .map((part) => normalizeSearchText(part))
        .filter(Boolean)
    : []
  return {
    raw,
    fullNormalized,
    tokens,
    isMultiToken: tokens.length >= 2,
    typoPenaltyFactor
  }
}

export function prepareSearchFields(input: SearchableTrackFields): PreparedSearchFields {
  const rawTitle = input.title ?? ''
  const rawArtist = input.artist ?? ''
  const rawAlbum = input.album ?? ''

  const normTitle = input.normTitle !== undefined ? input.normTitle : normalizeSearchText(rawTitle)
  const normArtist =
    input.normArtist !== undefined ? input.normArtist : normalizeSearchText(rawArtist)
  const normAlbum = input.normAlbum !== undefined ? input.normAlbum : normalizeSearchText(rawAlbum)

  const titleInitials =
    input.titleInitials !== undefined ? input.titleInitials : getPinyinInitials(rawTitle)
  const artistInitials =
    input.artistInitials !== undefined ? input.artistInitials : getPinyinInitials(rawArtist)
  const albumInitials =
    input.albumInitials !== undefined ? input.albumInitials : getPinyinInitials(rawAlbum)

  const normFileName =
    input.normFileName !== undefined
      ? input.normFileName
      : input.fileName
        ? normalizeSearchText(input.fileName)
        : ''

  return {
    rawTitle,
    rawArtist,
    rawAlbum,
    normTitle,
    normArtist,
    normAlbum,
    titleInitials,
    artistInitials,
    albumInitials,
    normFileName,
    titleWords: tokenizeWords(rawTitle),
    artistWords: tokenizeWords(rawArtist),
    albumWords: tokenizeWords(rawAlbum)
  }
}

export function prepareSearchFieldsFromBlob(
  blob: string,
  separator: string,
  raw: { title: string; artist: string; album: string; fileName?: string },
  normFileName?: string
): PreparedSearchFields {
  const [
    normTitle = '',
    normArtist = '',
    normAlbum = '',
    titleInitials = '',
    artistInitials = '',
    albumInitials = ''
  ] = blob.split(separator)

  return prepareSearchFields({
    title: raw.title,
    artist: raw.artist,
    album: raw.album,
    fileName: raw.fileName,
    normTitle,
    normArtist,
    normAlbum,
    titleInitials,
    artistInitials,
    albumInitials,
    normFileName
  })
}

function fieldMatchesToken(
  fields: PreparedSearchFields,
  token: string,
  searchFileName: boolean
): boolean {
  if (!token) return false
  return (
    fields.normTitle.includes(token) ||
    fields.normArtist.includes(token) ||
    fields.normAlbum.includes(token) ||
    fields.titleInitials.includes(token) ||
    fields.artistInitials.includes(token) ||
    fields.albumInitials.includes(token) ||
    (searchFileName && fields.normFileName.includes(token))
  )
}

export function matchesPreparedSearch(
  fields: PreparedSearchFields,
  query: PreparedSearchQuery,
  searchFileName = true
): boolean {
  if (!query.fullNormalized) return false
  if (fieldMatchesToken(fields, query.fullNormalized, searchFileName)) {
    return true
  }
  if (query.isMultiToken) {
    return query.tokens.every((token) => fieldMatchesToken(fields, token, searchFileName))
  }
  return false
}

export function matchesTrackSearch(
  track: SearchableTrackFields,
  query: string | PreparedSearchQuery,
  searchFileName = true
): boolean {
  const preparedQuery = typeof query === 'string' ? prepareSearchQuery(query) : query
  if (!preparedQuery.fullNormalized) return false
  const preparedFields = prepareSearchFields(track)
  return matchesPreparedSearch(preparedFields, preparedQuery, searchFileName)
}

function countOccurrences(haystack: string, needle: string): number {
  if (!haystack || !needle) return 0
  let count = 0
  let pos = 0
  while (pos <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, pos)
    if (idx === -1) break
    count += 1
    if (count >= 3) return 3
    pos = idx + Math.max(1, needle.length)
  }
  return count
}

function computeFieldTokenBm25(
  fieldValue: string,
  token: string,
  avgLen: number,
  boost: number
): number {
  if (!fieldValue || !token || !fieldValue.includes(token)) return 0
  const coverage = Math.min(1, token.length / Math.max(1, fieldValue.length))
  const tf = Math.min(3, countOccurrences(fieldValue, token))
  const normDl = fieldValue.length / avgLen
  const saturation = (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * normDl))
  return saturation * coverage * boost * 10
}

function computeFieldBm25(
  fieldValue: string,
  query: PreparedSearchQuery,
  avgLen: number,
  boost: number
): number {
  if (!fieldValue || !query.fullNormalized) return 0
  if (fieldValue.includes(query.fullNormalized)) {
    return computeFieldTokenBm25(fieldValue, query.fullNormalized, avgLen, boost)
  }
  if (!query.isMultiToken) return 0

  let sum = 0
  for (const token of query.tokens) {
    if (fieldValue.includes(token)) {
      sum += computeFieldTokenBm25(fieldValue, token, avgLen, boost)
    }
  }
  return sum
}

function findLongestContiguousTokenRun(fields: PreparedSearchFields, tokens: string[]): number {
  if (tokens.length < 2) return 0

  const wordLists = [fields.titleWords, fields.artistWords, fields.albumWords]
  let maxRun = 0

  for (const words of wordLists) {
    if (words.length === 0) continue
    for (let start = 0; start < tokens.length; start++) {
      for (let wIdx = 0; wIdx < words.length; wIdx++) {
        let run = 0
        while (
          start + run < tokens.length &&
          wIdx + run < words.length &&
          (words[wIdx + run] === tokens[start + run] ||
            words[wIdx + run].startsWith(tokens[start + run]))
        ) {
          run += 1
        }
        if (run > maxRun) maxRun = run
      }
    }
  }

  // Also check contiguous joined runs inside normTitle or normArtist
  const normTargets = [fields.normTitle, fields.normArtist, fields.normAlbum]
  for (const target of normTargets) {
    if (!target) continue
    for (let start = 0; start < tokens.length; start++) {
      let joined = tokens[start]
      for (let end = start + 1; end < tokens.length; end++) {
        joined += tokens[end]
        const len = end - start + 1
        if (len > maxRun && target.includes(joined)) {
          maxRun = len
        }
      }
    }
  }

  return maxRun >= 2 ? maxRun : 0
}

export function scorePreparedSearchRelevance(
  fields: PreparedSearchFields,
  query: PreparedSearchQuery,
  options?: SearchRelevanceOptions
): SearchRelevanceBreakdown {
  const searchFileName = options?.searchFileName ?? true
  const typoPenaltyFactor = options?.typoPenaltyFactor ?? query.typoPenaltyFactor ?? 1

  if (!matchesPreparedSearch(fields, query, searchFileName)) {
    return {
      exact: 0,
      prefix: 0,
      phrase: 0,
      ftsBm25: 0,
      favorite: 0,
      playCount: 0,
      typoPenaltyFactor,
      total: 0
    }
  }

  const q = query.fullNormalized

  // 1. Exact & Primary Field Match Feature (w_exact)
  let exact = 0
  if (fields.normTitle === q) exact += 500
  else if (fields.normTitle.includes(q)) exact += 100
  if (fields.normArtist === q) exact += 300
  else if (fields.normArtist.includes(q)) exact += 55
  if (fields.normAlbum === q) exact += 80
  else if (fields.normAlbum.includes(q)) exact += 25
  if (q.length >= 2 && fields.titleInitials === q) exact += 65
  if (q.length >= 2 && fields.artistInitials === q) exact += 50
  if (q.length >= 2 && fields.albumInitials === q) exact += 35
  if (searchFileName && fields.normFileName === q) exact += 15

  if (fields.normTitle !== q && fields.titleWords.includes(q)) exact += 180
  if (fields.normArtist !== q && fields.artistWords.includes(q)) exact += 110
  if (fields.normAlbum !== q && fields.albumWords.includes(q)) exact += 40

  if (query.isMultiToken) {
    const tokens = query.tokens
    let exactTitleSpan = false
    let exactArtistSpan = false
    let exactAlbumSpan = false

    for (let i = 0; i < tokens.length; i++) {
      let span = ''
      for (let j = i; j < tokens.length; j++) {
        span += tokens[j]
        if (span === q) continue
        if (fields.normTitle && span === fields.normTitle) exactTitleSpan = true
        if (fields.normArtist && span === fields.normArtist) exactArtistSpan = true
        if (fields.normAlbum && span === fields.normAlbum) exactAlbumSpan = true
      }
    }

    if (exactTitleSpan && exactArtistSpan) {
      exact += 450
    } else {
      if (exactTitleSpan && fields.normTitle !== q) exact += 220
      if (exactArtistSpan && fields.normArtist !== q) exact += 140
      if (exactAlbumSpan && fields.normAlbum !== q) exact += 60
    }
  }

  // 2. Prefix Match Feature (w_prefix)
  let prefix = 0
  if (fields.normTitle !== q && fields.normTitle.startsWith(q)) prefix += 250
  if (fields.normArtist !== q && fields.normArtist.startsWith(q)) prefix += 150
  if (fields.normAlbum !== q && fields.normAlbum.startsWith(q)) prefix += 45
  if (fields.titleInitials !== q && fields.titleInitials.startsWith(q)) prefix += 35
  if (fields.artistInitials !== q && fields.artistInitials.startsWith(q)) prefix += 25
  if (fields.albumInitials !== q && fields.albumInitials.startsWith(q)) prefix += 18
  if (searchFileName && fields.normFileName !== q && fields.normFileName.startsWith(q)) {
    prefix += 8
  }

  if (
    !fields.normTitle.startsWith(q) &&
    !fields.titleWords.includes(q) &&
    fields.titleWords.some((w) => w.startsWith(q))
  ) {
    prefix += 120
  }
  if (
    !fields.normArtist.startsWith(q) &&
    !fields.artistWords.includes(q) &&
    fields.artistWords.some((w) => w.startsWith(q))
  ) {
    prefix += 75
  }
  if (
    !fields.normAlbum.startsWith(q) &&
    !fields.albumWords.includes(q) &&
    fields.albumWords.some((w) => w.startsWith(q))
  ) {
    prefix += 25
  }

  // 3. Phrase / Multi-Token Feature (w_phrase)
  let phrase = 0
  if (query.isMultiToken) {
    let matchedCount = 0
    const titleMatchedIndices = new Set<number>()
    const artistMatchedIndices = new Set<number>()

    for (let i = 0; i < query.tokens.length; i++) {
      const t = query.tokens[i]
      if (fieldMatchesToken(fields, t, searchFileName)) {
        matchedCount += 1
      }
      if (fields.normTitle.includes(t) || fields.titleInitials.includes(t)) {
        titleMatchedIndices.add(i)
      }
      if (fields.normArtist.includes(t) || fields.artistInitials.includes(t)) {
        artistMatchedIndices.add(i)
      }
    }

    if (matchedCount === query.tokens.length) {
      phrase += 160
      let crossTitleArtist = false
      for (const tIdx of titleMatchedIndices) {
        for (const aIdx of artistMatchedIndices) {
          if (tIdx !== aIdx) {
            crossTitleArtist = true
            break
          }
        }
        if (crossTitleArtist) break
      }
      if (crossTitleArtist) {
        phrase += 80
      }
    }

    const runLength = findLongestContiguousTokenRun(fields, query.tokens)
    if (runLength >= 2) {
      phrase += Math.round((Math.pow(PHRASE_COMPOUND_RATE, runLength) - 1) * 200)
    }
  }

  // 4. Per-Field Coverage-Weighted BM25 (w_fts_bm25)
  const fieldScores: number[] = []
  const titleBm25 = computeFieldBm25(
    fields.normTitle,
    query,
    FIELD_AVG_LEN.title,
    FIELD_BOOST.title
  )
  if (titleBm25 > 0) fieldScores.push(titleBm25)

  const artistBm25 = computeFieldBm25(
    fields.normArtist,
    query,
    FIELD_AVG_LEN.artist,
    FIELD_BOOST.artist
  )
  if (artistBm25 > 0) fieldScores.push(artistBm25)

  const titleInitialsBm25 = computeFieldBm25(
    fields.titleInitials,
    query,
    FIELD_AVG_LEN.initials,
    FIELD_BOOST.titleInitials
  )
  if (titleInitialsBm25 > 0) fieldScores.push(titleInitialsBm25)

  const albumBm25 = computeFieldBm25(
    fields.normAlbum,
    query,
    FIELD_AVG_LEN.album,
    FIELD_BOOST.album
  )
  if (albumBm25 > 0) fieldScores.push(albumBm25)

  const artistInitialsBm25 = computeFieldBm25(
    fields.artistInitials,
    query,
    FIELD_AVG_LEN.initials,
    FIELD_BOOST.artistInitials
  )
  if (artistInitialsBm25 > 0) fieldScores.push(artistInitialsBm25)

  const albumInitialsBm25 = computeFieldBm25(
    fields.albumInitials,
    query,
    FIELD_AVG_LEN.initials,
    FIELD_BOOST.albumInitials
  )
  if (albumInitialsBm25 > 0) fieldScores.push(albumInitialsBm25)

  if (searchFileName) {
    const fileNameBm25 = computeFieldBm25(
      fields.normFileName,
      query,
      FIELD_AVG_LEN.fileName,
      FIELD_BOOST.fileName
    )
    if (fileNameBm25 > 0) fieldScores.push(fileNameBm25)
  }

  fieldScores.sort((a, b) => b - a)
  let rawBm25 = 0
  if (fieldScores.length > 0) {
    rawBm25 = fieldScores[0]
    for (let i = 1; i < fieldScores.length; i++) {
      rawBm25 += 0.25 * fieldScores[i]
    }
  }
  const ftsBm25 = round4(rawBm25)

  // 5. Personal Signals (w_favorite & w_play_count)
  let favorite = 0
  if (options?.signals?.banned) {
    favorite = -200
  } else if (options?.signals?.favorite) {
    favorite = 80
  }

  const rawPlayCount = options?.signals?.playCount ?? 0
  const playCountPart =
    rawPlayCount > 0 ? Math.min(60, Math.round(Math.log1p(rawPlayCount) * 18 * 100) / 100) : 0
  const lastPlayedPart = (options?.signals?.lastPlayed ?? 0) > 0 ? 15 : 0
  const playCount = round4(playCountPart + lastPlayedPart)

  const total = round4((exact + prefix + phrase + ftsBm25) * typoPenaltyFactor + favorite + playCount)

  return {
    exact,
    prefix,
    phrase,
    ftsBm25,
    favorite,
    playCount,
    typoPenaltyFactor,
    total
  }
}

export function scoreTrackSearchRelevance(
  track: SearchableTrackFields,
  query: string | PreparedSearchQuery,
  options?: SearchRelevanceOptions
): SearchRelevanceBreakdown {
  const preparedQuery =
    typeof query === 'string'
      ? prepareSearchQuery(query, options?.typoPenaltyFactor ?? 1)
      : query
  const preparedFields = prepareSearchFields(track)
  return scorePreparedSearchRelevance(preparedFields, preparedQuery, options)
}

export function getMaxSymSpellTolerance(token: string): number {
  if (!token || token.length <= 2) return 0
  if (CJK_EXTENDED_PATTERN.test(token)) return 0
  for (const ch of token) {
    if (isCjkChar(ch)) return 0
  }
  if (PURE_DIGITS_PATTERN.test(token)) return 0
  if (token.length <= 5) return 1
  return 2
}

export function damerauLevenshteinDistance(a: string, b: string, maxDistance = 2): number {
  if (a === b) return 0
  const lenA = a.length
  const lenB = b.length
  if (Math.abs(lenA - lenB) > maxDistance) return maxDistance + 1
  if (lenA === 0) return lenB <= maxDistance ? lenB : maxDistance + 1
  if (lenB === 0) return lenA <= maxDistance ? lenA : maxDistance + 1

  let prevPrevRow = new Int32Array(lenB + 1)
  let prevRow = new Int32Array(lenB + 1)
  let currRow = new Int32Array(lenB + 1)

  for (let j = 0; j <= lenB; j++) {
    prevRow[j] = j
  }

  let prevRowMin = 0

  for (let i = 1; i <= lenA; i++) {
    currRow[0] = i
    let rowMin = currRow[0]
    const chA = a.charCodeAt(i - 1)

    for (let j = 1; j <= lenB; j++) {
      const chB = b.charCodeAt(j - 1)
      const cost = chA === chB ? 0 : 1
      let val = Math.min(
        prevRow[j] + 1, // deletion
        currRow[j - 1] + 1, // insertion
        prevRow[j - 1] + cost // substitution
      )

      if (i > 1 && j > 1 && chA === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === chB) {
        val = Math.min(val, prevPrevRow[j - 2] + 1) // transposition
      }

      currRow[j] = val
      if (val < rowMin) rowMin = val
    }

    if (rowMin > maxDistance && prevRowMin > maxDistance) {
      return maxDistance + 1
    }

    prevRowMin = rowMin
    const tmp = prevPrevRow
    prevPrevRow = prevRow
    prevRow = currRow
    currRow = tmp
  }

  const distance = prevRow[lenB]
  return distance <= maxDistance ? distance : maxDistance + 1
}

function generateDeleteVariants(wordPrefix: string, maxEditDistance: number): Set<string> {
  const results = new Set<string>()
  results.add(wordPrefix)

  let currentLevel = new Set<string>([wordPrefix])
  for (let dist = 1; dist <= maxEditDistance; dist++) {
    const nextLevel = new Set<string>()
    for (const item of currentLevel) {
      if (item.length <= 1) continue
      for (let i = 0; i < item.length; i++) {
        const deleted = item.slice(0, i) + item.slice(i + 1)
        if (!results.has(deleted)) {
          results.add(deleted)
          nextLevel.add(deleted)
        }
      }
    }
    currentLevel = nextLevel
    if (currentLevel.size === 0) break
  }

  return results
}

export class SymSpellIndex {
  readonly maxDictionaryEditDistance = 2
  readonly prefixLength = 7
  private readonly maxUnigrams = 50_000
  private readonly maxBigrams = 50_000

  private readonly unigrams = new Map<string, number>()
  private readonly deletes = new Map<string, string[]>()
  private readonly bigrams = new Map<string, number>()

  get unigramCount(): number {
    return this.unigrams.size
  }

  get bigramCount(): number {
    return this.bigrams.size
  }

  clear(): void {
    this.unigrams.clear()
    this.deletes.clear()
    this.bigrams.clear()
  }

  addTerm(term: string, count = 1): void {
    if (!term || count <= 0) return
    const normalized = normalizeSearchText(term)
    if (normalized.length < 3) return
    if (STOP_WORDS.has(normalized)) return
    if (getMaxSymSpellTolerance(normalized) === 0) return

    const existing = this.unigrams.get(normalized)
    if (existing !== undefined) {
      this.unigrams.set(normalized, existing + count)
      return
    }

    if (this.unigrams.size >= this.maxUnigrams) return
    this.unigrams.set(normalized, count)

    const keyPrefix =
      normalized.length > this.prefixLength ? normalized.slice(0, this.prefixLength) : normalized
    const variants = generateDeleteVariants(keyPrefix, this.maxDictionaryEditDistance)
    for (const variant of variants) {
      let bucket = this.deletes.get(variant)
      if (!bucket) {
        bucket = [normalized]
        this.deletes.set(variant, bucket)
      } else {
        bucket.push(normalized)
      }
    }
  }

  addBigram(first: string, second: string, count = 1): void {
    if (!first || !second || count <= 0) return
    const w1 = normalizeSearchText(first)
    const w2 = normalizeSearchText(second)
    if (w1.length < 2 || w2.length < 2) return
    const key = `${w1} ${w2}`
    const existing = this.bigrams.get(key)
    if (existing !== undefined) {
      this.bigrams.set(key, existing + count)
      return
    }
    if (this.bigrams.size >= this.maxBigrams) return
    this.bigrams.set(key, count)
  }

  addText(text: string, weight = 1): void {
    if (!text || weight <= 0) return
    const words = tokenizeWords(text)
    const eligibleWords: string[] = []

    for (const rawWord of words) {
      const w = normalizeSearchText(rawWord)
      if (!w) continue
      if (w.length >= 3 && !STOP_WORDS.has(w) && getMaxSymSpellTolerance(w) > 0) {
        this.addTerm(w, weight)
        eligibleWords.push(w)
      } else if (w.length >= 2 && getMaxSymSpellTolerance(w) >= 0 && !CJK_EXTENDED_PATTERN.test(w)) {
        eligibleWords.push(w)
      }
    }

    for (let i = 0; i + 1 < eligibleWords.length; i++) {
      this.addBigram(eligibleWords[i], eligibleWords[i + 1], weight)
    }

    const initials = getPinyinInitials(text)
    if (initials.length >= 4) {
      this.addTerm(initials, weight)
    }
  }

  addTrack(fields: { title?: string; artist?: string; album?: string }): void {
    if (fields.title) this.addText(fields.title, 3)
    if (fields.artist) this.addText(fields.artist, 2)
    if (fields.album) this.addText(fields.album, 1)
  }

  lookup(token: string, maxEditDistance?: number): SymSpellSuggestion[] {
    const w = normalizeSearchText(token)
    if (!w) return []

    const exactFreq = this.unigrams.get(w)
    if (exactFreq !== undefined) {
      return [{ term: w, distance: 0, frequency: exactFreq, score: 1 }]
    }

    if (STOP_WORDS.has(w)) {
      return []
    }

    const maxTol = getMaxSymSpellTolerance(w)
    const tol = maxEditDistance !== undefined ? Math.min(maxEditDistance, maxTol) : maxTol
    if (tol <= 0) {
      return []
    }

    const queryPrefix = w.length > this.prefixLength ? w.slice(0, this.prefixLength) : w
    const queryVariants = generateDeleteVariants(queryPrefix, tol)
    if (w.length > this.prefixLength) {
      const extendedPrefix = w.slice(0, this.prefixLength + tol)
      for (const v of generateDeleteVariants(extendedPrefix, tol)) {
        if (v.length <= this.prefixLength) {
          queryVariants.add(v)
        }
      }
    }

    const candidates = new Set<string>()
    for (const variant of queryVariants) {
      const bucket = this.deletes.get(variant)
      if (!bucket) continue
      for (let i = 0; i < bucket.length; i++) {
        candidates.add(bucket[i])
      }
    }

    const suggestions: SymSpellSuggestion[] = []
    for (const cand of candidates) {
      if (Math.abs(cand.length - w.length) > tol) continue
      const d = damerauLevenshteinDistance(w, cand, tol)
      if (d > tol) continue

      const sharesFirstChar = cand.charCodeAt(0) === w.charCodeAt(0)
      if (!sharesFirstChar && d > 1 && w.length < 5) continue

      const freq = this.unigrams.get(cand) ?? 1
      const score =
        (Math.pow(0.78, d) *
          (sharesFirstChar ? 1.15 : 1.0) *
          (1 + Math.log10(1 + freq) * 0.15)) /
        (1 + Math.abs(cand.length - w.length) * 0.05)

      suggestions.push({
        term: cand,
        distance: d,
        frequency: freq,
        score: round4(score)
      })
    }

    suggestions.sort((a, b) => {
      if (a.distance !== b.distance) return a.distance - b.distance
      if (b.score !== a.score) return b.score - a.score
      if (b.frequency !== a.frequency) return b.frequency - a.frequency
      return a.term.localeCompare(b.term)
    })

    return suggestions.slice(0, 10)
  }

  suggestQuery(query: string): SymSpellQuerySuggestion | null {
    const rawParts = query
      .trim()
      .split(/\s+/u)
      .map((part) => normalizeSearchText(part))
      .filter(Boolean)

    if (rawParts.length === 0) return null

    const tokenCandidateLists: SymSpellSuggestion[][] = []
    for (const token of rawParts) {
      if (STOP_WORDS.has(token) || getMaxSymSpellTolerance(token) === 0) {
        tokenCandidateLists.push([
          {
            term: token,
            distance: 0,
            frequency: this.unigrams.get(token) ?? 0,
            score: 1
          }
        ])
        continue
      }

      const suggestions = this.lookup(token)
      if (suggestions.length === 0) {
        return null
      }
      tokenCandidateLists.push(suggestions.slice(0, 5))
    }

    if (tokenCandidateLists.length === 1) {
      const best = tokenCandidateLists[0][0]
      if (best.distance === 0) return null
      return {
        originalQuery: query,
        correctedQuery: best.term,
        tokens: [best.term],
        totalDistance: best.distance,
        penaltyFactor: Math.pow(0.8, best.distance)
      }
    }

    // Multi-token beam / Viterbi search using bigram coherence bonus
    interface BeamState {
      tokens: string[]
      totalDistance: number
      score: number
    }

    let beam: BeamState[] = tokenCandidateLists[0].map((cand) => ({
      tokens: [cand.term],
      totalDistance: cand.distance,
      score: cand.score
    }))

    for (let i = 1; i < tokenCandidateLists.length; i++) {
      const nextCandidates = tokenCandidateLists[i]
      const nextBeam: BeamState[] = []

      for (const state of beam) {
        const prevTerm = state.tokens[state.tokens.length - 1]
        for (const cand of nextCandidates) {
          const bigramFreq = this.bigrams.get(`${prevTerm} ${cand.term}`) ?? 0
          const bigramBonus = bigramFreq > 0 ? 1 + Math.log10(1 + bigramFreq) * 1.5 : 1.0
          nextBeam.push({
            tokens: [...state.tokens, cand.term],
            totalDistance: state.totalDistance + cand.distance,
            score: state.score + cand.score * bigramBonus
          })
        }
      }

      nextBeam.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        return a.totalDistance - b.totalDistance
      })
      beam = nextBeam.slice(0, 8)
    }

    const bestSequence = beam[0]
    if (!bestSequence || bestSequence.totalDistance === 0) {
      return null
    }

    return {
      originalQuery: query,
      correctedQuery: bestSequence.tokens.join(' '),
      tokens: bestSequence.tokens,
      totalDistance: bestSequence.totalDistance,
      penaltyFactor: Math.pow(0.8, bestSequence.totalDistance)
    }
  }
}
