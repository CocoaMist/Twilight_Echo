export const MAX_SETTINGS_BACKUP_BYTES = 2 * 1024 * 1024

export interface CoreSettingsBackupImport {
  revision: number
  json: string
}

export function validCoreSettingsBackupPayload(
  name: string,
  payload: Record<string, unknown>
): boolean {
  if (name === 'settings.backup') return Object.keys(payload).length === 0
  return (
    name === 'settings.restore' &&
    Object.keys(payload).every((key) => key === 'revision' || key === 'json') &&
    Number.isSafeInteger(payload.revision) &&
    Number(payload.revision) >= 0 &&
    typeof payload.json === 'string' &&
    new TextEncoder().encode(payload.json).byteLength <= MAX_SETTINGS_BACKUP_BYTES
  )
}
