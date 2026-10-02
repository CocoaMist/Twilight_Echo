export type AppUpdateChannel = 'stable' | 'preview'
export type AppUpdateErrorCode =
  | 'network'
  | 'timeout'
  | 'rate-limit'
  | 'http'
  | 'disk'
  | 'checksum'
  | 'invalid-release'
  | 'no-asset'
  | 'no-checksum'
  | 'unsupported-platform'
  | 'busy'
  | 'persistence'
  | 'install'
export type AppUpdateCheckError = AppUpdateErrorCode

export interface AppUpdatePreferences {
  autoCheck: boolean
  channel: AppUpdateChannel
  checkIntervalHours: 6 | 24 | 72
  skippedVersion: string
  remindAfter: number
}
export const DEFAULT_APP_UPDATE_PREFERENCES: AppUpdatePreferences = {
  autoCheck: true,
  channel: 'stable',
  checkIntervalHours: 24,
  skippedVersion: '',
  remindAfter: 0
}
export type AppUpdateCheckResult = {
  hasUpdate: boolean
  currentVersion: string
  latestVersion?: string
  releaseUrl?: string
  releaseNotes?: string
  publishedAt?: string
  assetName?: string
  assetSize?: number
  hasChecksum?: boolean
  error?: AppUpdateErrorCode
  message?: string
}
export type AppUpdateProgressPhase =
  | 'idle'
  | 'resolving'
  | 'downloading'
  | 'retrying'
  | 'cancelling'
  | 'cancelled'
  | 'verifying'
  | 'ready'
  | 'installing'
  | 'error'
export type AppUpdateProgress = {
  phase: AppUpdateProgressPhase
  percent: number
  receivedBytes: number
  totalBytes: number
  taskId?: string
  version?: string
  assetName?: string
  installerPath?: string
  bytesPerSecond?: number
  remainingSeconds?: number
  attempt?: number
  message?: string
  error?: string
  errorCode?: AppUpdateErrorCode
}
export interface AppUpdateSnapshot {
  revision: number
  checking: boolean
  checkedAt: number
  check: AppUpdateCheckResult | null
  progress: AppUpdateProgress
  preferences: AppUpdatePreferences
  readyVersion: string | null
  pendingInstallVersion: string | null
  completedVersion: string | null
  notice: { id: string; kind: 'available' | 'ready' | 'installed'; version: string } | null
}
export function createInitialAppUpdateSnapshot(): AppUpdateSnapshot {
  return {
    revision: 0,
    checking: false,
    checkedAt: 0,
    check: null,
    progress: { phase: 'idle', percent: 0, receivedBytes: 0, totalBytes: 0 },
    preferences: { ...DEFAULT_APP_UPDATE_PREFERENCES },
    readyVersion: null,
    pendingInstallVersion: null,
    completedVersion: null,
    notice: null
  }
}
export type AppUpdateDownloadResult =
  | { ok: true; installerPath: string; assetName: string; verified: true; sha256: string }
  | { ok: false; error: string; errorCode?: AppUpdateErrorCode; cancelled?: boolean }
export type AppUpdateInstallResult =
  | { ok: true }
  | { ok: false; error: string; errorCode?: AppUpdateErrorCode; installerPath?: string | null }
export type AppUpdatePreferencePatch = Partial<
  Pick<AppUpdatePreferences, 'autoCheck' | 'channel' | 'checkIntervalHours'>
>
export interface AppUpdateClient {
  getUpdateState: () => Promise<AppUpdateSnapshot>
  onUpdateState: (callback: (snapshot: AppUpdateSnapshot) => void) => () => void
  checkForUpdates: () => Promise<AppUpdateCheckResult>
  downloadUpdate: () => Promise<AppUpdateDownloadResult>
  cancelUpdateDownload: () => Promise<boolean>
  installUpdate: () => Promise<AppUpdateInstallResult>
  setUpdatePreferences: (patch: AppUpdatePreferencePatch) => Promise<AppUpdateSnapshot>
  dismissUpdate: (action: 'skip' | 'later') => Promise<AppUpdateSnapshot>
}
