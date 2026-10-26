import { dialog, shell } from 'electron'
import { protectProviderMedia } from '../security/remoteMediaGrants.ts'
import { writeDiagnostic } from '../diagnostics/logger.ts'
import { sanitizeDiagnosticText } from '../diagnostics/sanitize.ts'
import { redactSensitiveText } from '../../shared/errors/redactSensitiveText.ts'
import { buildLocalPluginInstallDialogOptions } from './installDialog.ts'
import { buildPluginInstallConfirmationDetail } from './installTrust.ts'

import type { PluginManagerPlatform } from '../../core/plugins/platform.ts'

export function createPluginManagerPlatform(
  options: Pick<PluginManagerPlatform, 'userData' | 'launchHost'>
): PluginManagerPlatform {
  return {
    userData: options.userData,
    launchHost: options.launchHost,
    chooseInstallSource: async (kind) => {
      const result = await dialog.showOpenDialog(buildLocalPluginInstallDialogOptions(kind))
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },
    confirmInstall: async (manifest, evidence) => {
      const result = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['安装', '取消'],
        cancelId: 1,
        defaultId: 1,
        title: '安装 Twilight Echo 插件',
        message: '安装 ' + manifest.name + '？',
        detail: buildPluginInstallConfirmationDetail(manifest, evidence)
      })
      return result.response === 0
    },
    showLog: (path) => shell.showItemInFolder(path),
    notifyStateIssue: async (type, detail) => {
      await dialog.showMessageBox({
        type,
        buttons: ['确定'],
        defaultId: 0,
        title: type === 'warning' ? '插件状态已恢复' : '插件状态读取失败',
        message:
          type === 'warning'
            ? '插件状态文件损坏，已从备份恢复。'
            : '插件状态文件损坏且无法从备份恢复。',
        detail
      })
    },
    log: (pluginId, level, message) => {
      const event = writeDiagnostic(
        'plugin',
        'plugin.output',
        { pluginId, message },
        level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'
      )
      return {
        timestamp: event?.timestamp ?? new Date().toISOString(),
        eventId: event?.eventId ?? '',
        text: sanitizeDiagnosticText(redactSensitiveText(message))
      }
    },
    protectProviderResult: (value, method) => {
      return protectProviderMedia(value, method)
    }
  }
}
