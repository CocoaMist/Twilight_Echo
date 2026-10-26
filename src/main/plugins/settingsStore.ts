import { PluginSettingsRepository } from '../../core/plugins/settingsRepository.ts'
import { protectJsonValue, unprotectJsonValue } from '../security/secureStorage.ts'
export { pluginSettingsPath } from '../../core/plugins/settingsRepository.ts'
const settings = new PluginSettingsRepository({
  protect: protectJsonValue,
  unprotect: unprotectJsonValue
})
export const getPluginSetting = (path: string, key?: string): Promise<unknown> =>
  settings.get(path, key)
export const setPluginSetting = (path: string, key: string, value: unknown): Promise<void> =>
  settings.set(path, key, value)
export const deletePluginSetting = (path: string, key: string): Promise<void> =>
  settings.delete(path, key)
