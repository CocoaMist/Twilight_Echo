import { readFileSync, renameSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { CoreSettingsRepository } from '../../core/persistence/settingsRepository.ts'

export type DevelopmentMetadataSetupResult =
  | { status: 'not-requested' | 'missing' | 'profile-mismatch' | 'settings-issue' | 'applied' }
  | { status: 'invalid-request'; message: string }
  | {
      status: 'failed'
      stage: 'read' | 'save' | 'consume'
      settingsApplied: boolean
      message: string
    }

interface DevelopmentMetadataSetupRequest {
  version: 1
  profileRoot: string
  newImports: true
  history: false
  sources: ['musicbrainz']
}

function validRequest(value: unknown): value is DevelopmentMetadataSetupRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const request = value as Record<string, unknown>
  const keys = ['version', 'profileRoot', 'newImports', 'history', 'sources']
  return (
    Object.keys(request).length === keys.length &&
    keys.every((key) => Object.hasOwn(request, key)) &&
    request.version === 1 &&
    typeof request.profileRoot === 'string' &&
    isAbsolute(request.profileRoot) &&
    request.newImports === true &&
    request.history === false &&
    Array.isArray(request.sources) &&
    request.sources.length === 1 &&
    request.sources[0] === 'musicbrainz'
  )
}

function normalizedRoot(root: string): string {
  const path = resolve(root)
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Consumed by the Core owner at startup, before automatic metadata tasks activate. */
export function applyDevelopmentMetadataSetup(
  requestFile: string | undefined,
  root: string,
  settings: Pick<CoreSettingsRepository, 'read' | 'update' | 'issue'>
): DevelopmentMetadataSetupResult {
  if (requestFile === undefined) return { status: 'not-requested' }

  let text: string
  try {
    text = readFileSync(requestFile, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
    return { status: 'failed', stage: 'read', settingsApplied: false, message: errorMessage(error) }
  }

  let request: unknown
  try {
    request = JSON.parse(text)
  } catch {
    return { status: 'invalid-request', message: 'Development metadata setup is not valid JSON' }
  }
  if (!validRequest(request))
    return {
      status: 'invalid-request',
      message: 'Development metadata setup has an invalid schema'
    }
  if (normalizedRoot(request.profileRoot) !== normalizedRoot(root))
    return { status: 'profile-mismatch' }
  if (settings.issue) return { status: 'settings-issue' }

  try {
    settings.update({
      musicIdentification: {
        ...settings.read().musicIdentification,
        newImports: true,
        history: false,
        sources: ['musicbrainz']
      }
    })
  } catch (error) {
    return { status: 'failed', stage: 'save', settingsApplied: false, message: errorMessage(error) }
  }

  try {
    renameSync(requestFile, `${requestFile}.applied`)
  } catch (error) {
    return {
      status: 'failed',
      stage: 'consume',
      settingsApplied: true,
      message: errorMessage(error)
    }
  }
  return { status: 'applied' }
}
