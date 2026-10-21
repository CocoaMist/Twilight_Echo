import type {
  DuplicateCandidate,
  DuplicateDetectionResult
} from '../../shared/duplicateDetection.ts'
import { contentHash, detectDuplicates, toDuplicateCandidate } from './duplicateDetection.ts'

export type DuplicateDetectionIpcDependencies = {
  assertTrustedSender(event: unknown): void
  authorizeAudioFile(filePath: string): Promise<string>
  hashContent?(filePath: string): Promise<string>
} & (
  | {
      loadTracks(): readonly unknown[] | Promise<readonly unknown[]>
      loadCandidatePages?: never
    }
  | {
      loadTracks?: never
      loadCandidatePages(): AsyncIterable<readonly DuplicateCandidate[]>
    }
)

export interface DuplicateDetectionIpcHandlers {
  detect(event: unknown): Promise<DuplicateDetectionResult>
}

/**
 * Read-only boundary for duplicate inspection. Its dependency surface intentionally exposes no
 * library mutation, media write, tag write, removal, or merge operation.
 */
export function createDuplicateDetectionIpcHandlers(
  dependencies: DuplicateDetectionIpcDependencies
): DuplicateDetectionIpcHandlers {
  const hashContent = dependencies.hashContent ?? contentHash
  let pending: Promise<DuplicateDetectionResult> | null = null

  async function inspect(): Promise<DuplicateDetectionResult> {
    const seenIds = new Set<string>()
    const candidates: DuplicateCandidate[] = []
    if (dependencies.loadCandidatePages) {
      for await (const page of dependencies.loadCandidatePages())
        appendCandidates(page, seenIds, candidates)
    } else appendCandidates(await dependencies.loadTracks(), seenIds, candidates)
    return await detectDuplicates(candidates, {
      contentHashForPath: async (filePath) => {
        try {
          const authorizedPath = await dependencies.authorizeAudioFile(filePath)
          return await hashContent(authorizedPath)
        } catch {
          // A missing, revoked, or unreadable file must not fail the entire read-only inspection.
          return null
        }
      }
    })
  }

  return {
    async detect(event): Promise<DuplicateDetectionResult> {
      dependencies.assertTrustedSender(event)
      // Repeated UI requests share a single read-only inspection; they must not
      // launch parallel full-library reads and media hashing pipelines.
      return await (pending ??= inspect().finally(() => {
        pending = null
      }))
    }
  }
}

function appendCandidates(
  tracks: readonly unknown[],
  seenIds: Set<string>,
  candidates: DuplicateCandidate[]
): void {
  for (const track of tracks) {
    if (!track || typeof track !== 'object' || Array.isArray(track)) continue
    const candidate = toDuplicateCandidate(track as Record<string, unknown>)
    // A duplicate or absent library identity cannot be safely presented as a merge candidate.
    if (!candidate.id || !candidate.filePath || seenIds.has(candidate.id)) continue
    seenIds.add(candidate.id)
    candidates.push(candidate)
  }
}
