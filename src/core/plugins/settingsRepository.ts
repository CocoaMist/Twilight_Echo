import { readFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { isSecureValueEnvelope, isSensitiveStorageKey } from '../../shared/secureValue.ts'
import type { SecureValueEnvelope } from '../../shared/secureValue.ts'
import { tryParseJsonWithNestingLimit } from '../../shared/jsonSafety.ts'
import { writeJsonFileAtomic } from '../persistence/jsonFile.ts'

export interface PluginSettingsCryptography {
  protect(value: unknown, scope: string): Promise<SecureValueEnvelope> | SecureValueEnvelope
  unprotect(value: SecureValueEnvelope, scope: string): Promise<unknown> | unknown
}

export const pluginSettingsPath = (storagePath: string): string =>
  join(storagePath, 'settings.json')
const MAX_FILE_BYTES = 1024 * 1024

/** One writer for each plugin, including read-triggered legacy credential migration. */
export class PluginSettingsRepository {
  private readonly writes = new Map<string, Promise<unknown>>()
  private readonly crypto: PluginSettingsCryptography
  constructor(crypto: PluginSettingsCryptography) {
    this.crypto = crypto
  }

  /** Stable across Core restarts, changes with the persisted account/config.
   * Inspect only filesystem metadata, never decrypt or fingerprint credentials. */
  identityContext(storagePath: string): string {
    try {
      const stat = statSync(pluginSettingsPath(storagePath), { bigint: true })
      return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
      throw error
    }
  }

  get(storagePath: string, key?: string): Promise<unknown> {
    return this.run(storagePath, async () => {
      const raw = await this.read(storagePath)
      const settings: Record<string, unknown> = { ...raw }
      let migrated = false
      for (const [name, value] of Object.entries(raw)) {
        if (isSecureValueEnvelope(value)) {
          settings[name] = await this.crypto.unprotect(value, scope(storagePath, name))
        } else if (isSensitiveStorageKey(name)) {
          raw[name] = await this.crypto.protect(value, scope(storagePath, name))
          migrated = true
        }
      }
      if (migrated) this.write(storagePath, raw)
      return key === undefined ? settings : settings[normalizeKey(key)]
    })
  }

  set(storagePath: string, key: string, value: unknown): Promise<void> {
    return this.run(storagePath, async () => {
      const name = normalizeKey(key)
      const json = JSON.stringify(value)
      if (json !== undefined && Buffer.byteLength(json) > 512 * 1024)
        throw new Error('plugin setting value is too large')
      const settings = await this.read(storagePath)
      // Leave other encrypted values intact, including credentials unavailable
      // while the OS keyring is locked. Updating a UI setting cannot erase them.
      Object.defineProperty(settings, name, {
        value: isSensitiveStorageKey(name)
          ? await this.crypto.protect(value, scope(storagePath, name))
          : value,
        enumerable: true,
        configurable: true,
        writable: true
      })
      this.write(storagePath, settings)
    })
  }

  delete(storagePath: string, key: string): Promise<void> {
    return this.run(storagePath, async () => {
      const settings = await this.read(storagePath)
      delete settings[normalizeKey(key)]
      this.write(storagePath, settings)
    })
  }

  async flush(): Promise<void> {
    await Promise.all(this.writes.values())
  }

  private run<T>(storagePath: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(storagePath) ?? Promise.resolve()
    const next = previous.then(operation, operation)
    this.writes.set(storagePath, next)
    void next
      .finally(() => {
        if (this.writes.get(storagePath) === next) this.writes.delete(storagePath)
      })
      .catch(() => undefined)
    return next
  }

  private async read(storagePath: string): Promise<Record<string, unknown>> {
    let raw: string
    try {
      raw = await readFile(pluginSettingsPath(storagePath), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
    if (Buffer.byteLength(raw) > MAX_FILE_BYTES) return {}
    const parsed = tryParseJsonWithNestingLimit(raw)
    return parsed.ok && isRecord(parsed.value) ? parsed.value : {}
  }

  private write(storagePath: string, settings: Record<string, unknown>): void {
    const json = JSON.stringify(settings, null, 2)
    if (Buffer.byteLength(json) > MAX_FILE_BYTES)
      throw new Error('plugin settings file is too large')
    writeJsonFileAtomic(
      pluginSettingsPath(storagePath),
      json,
      {
        label: 'plugin settings',
        maxBytes: MAX_FILE_BYTES,
        validate: isRecord
      },
      settings
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function normalizeKey(key: string): string {
  const value = key.trim()
  if (!value) throw new Error('settings key is required')
  if (value.length > 128) throw new Error('settings key is too long')
  if (/[\0\r\n]/.test(value)) throw new Error('settings key contains invalid characters')
  return value
}
function scope(storagePath: string, key: string): string {
  return `plugin-settings:${storagePath}:${key}`
}
