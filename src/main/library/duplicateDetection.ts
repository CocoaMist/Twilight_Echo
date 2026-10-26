import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { normalize } from 'node:path'
import {
  detectDuplicates as detect,
  groupDuplicates as group,
  type DuplicateDetectionOptions as CoreOptions
} from '../../core/library/duplicateDetection.ts'
import type {
  DuplicateCandidate,
  DuplicateDetectionResult,
  DuplicateGroup
} from '../../shared/duplicateDetection.ts'
export * from '../../core/library/duplicateDetection.ts'
export type DuplicateDetectionOptions = Omit<CoreOptions, 'pathKey'>

const pathKey = (path: string): string => {
  const value = normalize(path)
  return process.platform === 'win32' ? value.toLocaleLowerCase('en-US') : value
}
export function detectDuplicates(
  items: readonly DuplicateCandidate[],
  options: DuplicateDetectionOptions = {}
): Promise<DuplicateDetectionResult> {
  return detect(items, { ...options, pathKey })
}
export function groupDuplicates(
  items: readonly DuplicateCandidate[],
  hashForPath?: (path: string) => string
): DuplicateGroup[] {
  return group(items, pathKey, hashForPath)
}
/** Full-file content identity for duplicate inspection, streamed inside an analysis worker. */
export async function contentHash(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}
