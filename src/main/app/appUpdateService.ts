import { app, shell } from 'electron'
import { join } from 'node:path'
import { runtime } from '../core/runtime.ts'
import { requestRendererPlaybackSessionSave } from './window.ts'
import { AppUpdateManager } from './appUpdateManager.ts'
import { GITHUB_OWNER, GITHUB_REPO, RELEASES_URL } from '../../shared/projectUrls.ts'
import type { AppUpdatePreferencePatch } from '../../shared/appUpdate.ts'

let manager: AppUpdateManager | null = null
let startupTimer: ReturnType<typeof setTimeout> | null = null
let checkTimer: ReturnType<typeof setInterval> | null = null
function service(): AppUpdateManager {
  manager ??= new AppUpdateManager({
    directory: join(app.getPath('userData'), 'updates'),
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    fetch: (input, init) => fetch(input, init),
    publish: (snapshot) => {
      const win = runtime.mainWindow
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
      win.webContents.send('app:update-state', snapshot)
      win.webContents.send('app:update-progress', snapshot.progress)
    },
    prepareInstall: requestRendererPlaybackSessionSave,
    openInstaller: (path) => shell.openPath(path),
    quit: () => {
      setTimeout(() => {
        runtime.forceQuit = true
        // Persistence was acknowledged before launching the installer.
        runtime.closingAfterPlaybackSessionSave = true
        app.quit()
        runtime.closingAfterPlaybackSessionSave = false
      }, 0)
    }
  })
  return manager
}
export const checkForAppUpdate = () => service().check()
export const downloadAppUpdate = () => service().download()
export const cancelAppUpdateDownload = () => service().cancel()
export const installDownloadedAppUpdate = () => service().install()
export async function getAppUpdateState() {
  await service().initialize()
  return service().snapshot()
}
export const setAppUpdatePreferences = (patch: AppUpdatePreferencePatch) =>
  service().preferences(patch)
export const dismissAppUpdate = (action: 'skip' | 'later') => service().dismiss(action)
export function getAppUpdateMeta() {
  const check = manager?.snapshot().check
  return {
    releaseUrl: check?.releaseUrl ?? RELEASES_URL,
    latestVersion: check?.latestVersion ?? '',
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO
  }
}
export function startAppUpdateChecks(): void {
  if (!app.isPackaged || startupTimer || checkTimer) return
  const check = (): void => {
    void service()
      .automaticCheck()
      .catch((error) => console.warn('[update]', error))
  }
  startupTimer = setTimeout(() => {
    startupTimer = null
    check()
    checkTimer = setInterval(check, 60_000)
    checkTimer.unref()
  }, 30_000)
  startupTimer.unref()
}
export function stopAppUpdateChecks(): void {
  if (startupTimer) clearTimeout(startupTimer)
  if (checkTimer) clearInterval(checkTimer)
  startupTimer = null
  checkTimer = null
  manager?.cancel()
}
