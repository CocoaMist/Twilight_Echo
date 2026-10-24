import { createHash } from 'crypto'
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'fs'
import { readFile, readdir, stat } from 'fs/promises'
import { basename, extname, isAbsolute, relative, resolve } from 'path'
import {
  MAX_CUE_BYTES,
  parseCueSheet,
  parseCueDefinition,
  resolveCueDefinition,
  type CueDefinition,
  type CueRange,
  type ParsedCueSheet
} from '../../shared/cue.ts'
import type { LocalLibraryFileIdentity } from '../../shared/localLibraryScan.ts'
import { legacyTrackIdentityTags, normalizeTrackIdentityTags, type TrackIdentityTags } from '../../shared/trackIdentification.ts'
import type {
  LibraryCueDefinitionRecord,
  LibraryScanDependency
} from '../../shared/libraryDatabase.ts'

export interface CueDerivedTrack extends Record<string, unknown> {
  cueRange: CueRange
  cueSheetPath: string
  cueEncoding: string
}

/**
 * Returns logical tracks for one audio file when a sibling CUE sheet references it. CUE FILE
 * names are never allowed to escape the CUE directory, so scan-time parsing cannot turn an
 * authorized music-folder scan into an arbitrary path probe.
 */
export function deriveCueTracks(
  audioPath: string,
  audioDurationSeconds: number,
  baseTrack: Record<string, unknown>,
  supportedExtensions: readonly string[]
): CueDerivedTrack[] | null {
  if (!Number.isFinite(audioDurationSeconds) || audioDurationSeconds <= 0) return null
  const directory = resolve(audioPath, '..')
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch {
    return null
  }
  const matching: Array<{ cuePath: string; parsed: ReturnType<typeof parseCueSheet> }> = []
  for (const name of names) {
    if (extname(name).toLowerCase() !== '.cue') continue
    const cuePath = resolve(directory, name)
    try {
      const cueInfo = statSync(cuePath)
      if (!cueInfo.isFile() || cueInfo.size <= 0) continue
      if (cueInfo.size > MAX_CUE_BYTES) {
        console.warn(`[library] CUE skipped (${basename(cuePath)}): exceeds ${MAX_CUE_BYTES} bytes`)
        continue
      }
      const bytes = readFileSync(cuePath)
      const parsed = parseCueSheet(bytes, audioDurationSeconds)
      const referenced = resolveCueAudioPath(directory, parsed.fileName, supportedExtensions)
      if (samePath(referenced, audioPath)) matching.push({ cuePath, parsed })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      console.warn(`[library] CUE skipped (${basename(cuePath)}): ${detail}`)
    }
  }
  if (!matching.length) return null
  if (matching.length !== 1) {
    console.warn(
      `[library] CUE skipped for ${basename(audioPath)}: ambiguous multiple CUE sheets (${matching.length})`
    )
    return null
  }
  const { cuePath, parsed } = matching[0]
  return projectCueTracks(audioPath, baseTrack, cuePath, parsed)
}

function projectCueTracks(
  audioPath: string,
  baseTrack: Record<string, unknown>,
  cuePath: string,
  parsed: ParsedCueSheet
): CueDerivedTrack[] {
  const fileName = String(baseTrack.fileName ?? basename(audioPath))
  const baseTitle = String(baseTrack.title ?? basename(audioPath, extname(audioPath)))
  const baseArtist = String(baseTrack.artist ?? 'Unknown Artist')
  const baseAlbum = String(baseTrack.album ?? 'Unknown Album')
  return parsed.tracks.map((cueTrack) => {
    const id = stableCueTrackId(audioPath, cuePath, cueTrack.number)
    const duration =
      (cueTrack.range.virtualPregapSeconds ?? 0) +
      cueTrack.range.endSeconds -
      cueTrack.range.startSeconds
    const parent = normalizeTrackIdentityTags(baseTrack.identityTags) ?? legacyTrackIdentityTags(baseTrack)
    // A file-level recording/ISRC describes the whole audio, not each segment.
    // Retain only album-level IDs; parent observations remain in audio_metadata.
    const identityTags: TrackIdentityTags = {
      ...parent,
      scope: 'cue_track',
      musicbrainz: parent.musicbrainz
        ? {
            artistIds: [],
            albumArtistIds: parent.musicbrainz.albumArtistIds,
            releaseId: parent.musicbrainz.releaseId,
            releaseGroupId: parent.musicbrainz.releaseGroupId
          }
        : undefined,
      isrcs: [],
      title: cueTrack.title
        ? { value: cueTrack.title, origin: 'cue' }
        : { value: `${String(cueTrack.number).padStart(2, '0')}. ${baseTitle}`, origin: 'filename' },
      artist: cueTrack.performer || parsed.performer
        ? { value: (cueTrack.performer || parsed.performer)!, origin: 'cue' }
        : parent.artist,
      artists: cueTrack.performer || parsed.performer
        ? { value: [(cueTrack.performer || parsed.performer)!], origin: 'cue' }
        : undefined,
      album: parsed.title ? { value: parsed.title, origin: 'cue' } : parent.album,
      durationSeconds: { value: cueTrack.range.endSeconds - cueTrack.range.startSeconds, origin: 'cue' },
      trackNumber: { value: cueTrack.number, origin: 'cue' },
      // The sheet may be partial; its last index is not an album track total.
      trackTotal: undefined
    }
    return {
      ...baseTrack,
      identityTags,
      isrc: undefined,
      id,
      title: cueTrack.title || `${String(cueTrack.number).padStart(2, '0')}. ${baseTitle}`,
      artist: cueTrack.performer || parsed.performer || baseArtist,
      artists: cueTrack.performer || parsed.performer
        ? [{ name: (cueTrack.performer || parsed.performer)! }]
        : undefined,
      album: parsed.title || baseAlbum,
      filePath: resolve(audioPath),
      fileName,
      duration,
      trackNumber: cueTrack.number,
      cueRange: cueTrack.range,
      cueSheetPath: cuePath,
      cueEncoding: parsed.encoding
    }
  })
}

/** One scan owns this cache. SQLite retains definitions; its directory index
 * keeps only file identities, not every logical track in a dense directory. */
type CueIndexEntry = {
  cuePath: string
  definition?: CueDefinition
  identity: LocalLibraryFileIdentity
}
type CueDefinitionCache = {
  get(identity: LocalLibraryFileIdentity): Promise<LibraryCueDefinitionRecord | null>
  put(record: LibraryCueDefinitionRecord): Promise<void>
}
export class CueDirectoryIndex {
  private readonly directoryVersions = new Map<string, LibraryScanDependency>()
  private readonly directories = new Map<
    string,
    {
      settled: boolean
      value: Promise<Map<string, CueIndexEntry[]>>
    }
  >()
  readonly metrics = { directoryReads: 0, cueReads: 0 }
  persistentCacheHits = 0

  private readonly supportedExtensions: readonly string[]
  private readonly persistent?: CueDefinitionCache
  private cacheTail: Promise<void> = Promise.resolve()
  private readonly pendingDefinitions = new Map<CueIndexEntry, Promise<CueDefinition>>()
  constructor(supportedExtensions: readonly string[], persistent?: CueDefinitionCache) {
    this.supportedExtensions = supportedExtensions
    this.persistent = persistent
  }

  async derive(
    audioPath: string,
    duration: number,
    baseTrack: Record<string, unknown>
  ): Promise<CueDerivedTrack[] | null> {
    if (!Number.isFinite(duration) || duration <= 0) return null
    const entries =
      (await this.getDirectory(resolve(audioPath, '..'))).get(canonicalPath(audioPath)) ?? []
    const matching: Array<{ cuePath: string; parsed: ParsedCueSheet }> = []
    for (const entry of entries) {
      // A cache/authority failure is not invalid CUE syntax. Propagate it to
      // the durable scan's failed-file path, preserving previous CUE tracks.
      const definition = await this.readDefinition(entry)
      try {
        matching.push({
          cuePath: entry.cuePath,
          parsed: resolveCueDefinition(definition, duration)
        })
      } catch (error) {
        console.warn(`[library] CUE skipped (${basename(entry.cuePath)}): ${String(error)}`)
      }
    }
    if (matching.length !== 1) {
      if (matching.length > 1)
        console.warn(
          `[library] CUE skipped for ${basename(audioPath)}: ambiguous multiple CUE sheets (${matching.length})`
        )
      return null
    }
    return projectCueTracks(audioPath, baseTrack, matching[0].cuePath, matching[0].parsed)
  }

  /** Four audio parsers share the scan bridge's bounded RPC allowance. Keep
   * cache calls serial and coalesce same-sheet reads only while in flight. */
  private cacheCall<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.cacheTail.then(operation)
    this.cacheTail = result.then(
      () => {},
      () => {}
    )
    return result
  }

  private readDefinition(entry: CueIndexEntry): Promise<CueDefinition> {
    if (entry.definition) return Promise.resolve(entry.definition)
    const pending = this.pendingDefinitions.get(entry)
    if (pending) return pending
    const read = this.cacheCall(async () => {
      const record = await this.persistent!.get(entry.identity)
      if (!record?.definition)
        throw new Error(`CUE definition is no longer available: ${basename(entry.cuePath)}`)
      return record.definition
    })
    this.pendingDefinitions.set(entry, read)
    const clear = () => {
      this.pendingDefinitions.delete(entry)
    }
    void read.then(clear, clear)
    return read
  }

  /** Only CUEs referencing this audio contribute to its projection identity. */
  async getSignatures(directory: string): Promise<Map<string, string>> {
    const result = new Map<string, string>()
    for (const [audio, entries] of await this.getDirectory(directory))
      result.set(
        audio,
        JSON.stringify(
          entries
            .map(({ cuePath, identity }) => [
              canonicalPath(cuePath),
              identity.size,
              identity.mtimeMs
            ])
            .sort()
        )
      )
    return result
  }
  async getDependencies(audioPath: string): Promise<LibraryScanDependency[]> {
    const directory = resolve(audioPath, '..')
    const entries = (await this.getDirectory(directory)).get(canonicalPath(audioPath)) ?? []
    const version = this.directoryVersions.get(canonicalPath(directory))
    return [...entries.map((entry) => entry.identity), ...(version ? [version] : [])]
  }
  invalidateDirectory(directory: string): void {
    const key = canonicalPath(directory)
    this.directories.delete(key)
    this.directoryVersions.delete(key)
  }
  private async getDirectory(directory: string): Promise<Map<string, CueIndexEntry[]>> {
    const key = canonicalPath(directory)
    let cached = this.directories.get(key)
    if (!cached) {
      cached = { settled: false, value: this.readDirectory(directory) }
      this.directories.set(key, cached)
      const entry = cached
      void entry.value.then(
        () => {
          entry.settled = true
          this.trimCache()
        },
        () => {
          this.directories.delete(key)
          this.directoryVersions.delete(key)
        }
      )
    }
    // Touch settled entries; concurrently parsing files always share in-flight work.
    this.directories.delete(key)
    this.directories.set(key, cached)
    return cached.value
  }

  private trimCache(): void {
    for (const [key, entry] of this.directories) {
      if (this.directories.size <= 64) break
      if (entry.settled) {
        this.directories.delete(key)
        this.directoryVersions.delete(key)
      }
    }
  }

  private async readDirectory(directory: string): Promise<Map<string, CueIndexEntry[]>> {
    const byAudio = new Map<string, CueIndexEntry[]>()
    this.metrics.directoryReads++
    let names: Dirent[]
    try {
      const info = await stat(directory)
      this.directoryVersions.set(canonicalPath(directory), {
        filePath: resolve(directory),
        size: info.size,
        mtimeMs: info.mtimeMs,
        kind: 'directory'
      })
      names = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (this.persistent) throw error
      return byAudio
    }
    for (const entry of names) {
      if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.cue') continue
      const cuePath = resolve(directory, entry.name)
      let identity: LocalLibraryFileIdentity
      try {
        const info = await stat(cuePath)
        if (!info.isFile() || info.size <= 0 || info.size > MAX_CUE_BYTES) continue
        identity = { filePath: cuePath, size: info.size, mtimeMs: info.mtimeMs }
      } catch (error) {
        if (this.persistent && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        console.warn(`[library] CUE skipped (${basename(cuePath)}): ${String(error)}`)
        continue
      }
      const cached = this.persistent
        ? await this.cacheCall(() => this.persistent!.get(identity))
        : null
      if (cached) this.persistentCacheHits++
      if (cached?.error) {
        console.warn(`[library] CUE skipped (${basename(cuePath)}): ${cached.error}`)
        continue
      }
      let record: LibraryCueDefinitionRecord = cached ?? { identity, parserVersion: 1 }
      if (!record.definition) {
        this.metrics.cueReads++
        // I/O failure is retryable; only invalid CUE bytes may be cached as a parse error.
        let bytes: Buffer
        try {
          bytes = await readFile(cuePath)
        } catch (error) {
          if (this.persistent) throw error
          console.warn(`[library] CUE skipped (${basename(cuePath)}): ${String(error)}`)
          continue
        }
        try {
          record = { identity, parserVersion: 1, definition: parseCueDefinition(bytes) }
        } catch (error) {
          record = { identity, parserVersion: 1, error: String(error) }
        }
      }
      try {
        if (!record.definition) throw new Error(record.error)
        const definition = record.definition
        const audioPath = resolveCueAudioPath(
          directory,
          definition.fileName,
          this.supportedExtensions
        )
        record = { identity, parserVersion: 1, audioPath, definition }
        const key = canonicalPath(audioPath)
        const definitions = byAudio.get(key) ?? []
        definitions.push({ cuePath, identity, ...(this.persistent ? {} : { definition }) })
        byAudio.set(key, definitions)
      } catch (error) {
        console.warn(`[library] CUE skipped (${basename(cuePath)}): ${String(error)}`)
        // Keep a valid definition even if its audio is temporarily absent. Resolve
        // FILE again on the next directory check without rereading unchanged CUE bytes.
      }
      if (!cached && this.persistent) await this.cacheCall(() => this.persistent!.put(record))
    }
    return byAudio
  }
}

function canonicalPath(value: string): string {
  return process.platform === 'win32' ? resolve(value).toLocaleLowerCase('en-US') : resolve(value)
}

export function resolveCueAudioPath(
  cueDirectory: string,
  cueFileName: string,
  supportedExtensions: readonly string[]
): string {
  const normalizedName = cueFileName.trim()
  if (!normalizedName || isAbsolute(normalizedName))
    throw new Error('CUE FILE path must be relative')
  const resolved = resolve(cueDirectory, normalizedName)
  const pathRelative = relative(cueDirectory, resolved)
  if (
    pathRelative === '' ||
    pathRelative === '..' ||
    pathRelative.startsWith(`..${String.fromCharCode(92)}`) ||
    pathRelative.startsWith('../')
  ) {
    throw new Error('CUE FILE path escapes its directory')
  }
  if (!supportedExtensions.includes(extname(resolved).toLowerCase())) {
    throw new Error('CUE FILE extension is not supported')
  }
  if (!existsSync(resolved)) throw new Error('CUE referenced audio file does not exist')
  return resolved
}

function stableCueTrackId(audioPath: string, cuePath: string, trackNumber: number): string {
  const key = `${resolve(audioPath)}\u0000${resolve(cuePath)}\u0000${trackNumber}`
  return `local:cue:${createHash('sha256').update(key).digest('hex').slice(0, 24)}`
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32'
    ? a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US')
    : a === b
}
