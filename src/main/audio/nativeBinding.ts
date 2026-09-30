import { existsSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import type { NativeAudioBinding } from './audioEngineTypes.ts'

const require = createRequire(import.meta.url)

type ElectronModule = typeof import('electron')

export function resolveElectronApp(
  electronVersion = process.versions.electron,
  loadModule: () => ElectronModule | string = () => require('electron')
): ElectronModule['app'] | null {
  // In plain Node, importing the SDK only yields an executable path and may
  // lazily download its binary. App discovery belongs to an Electron runtime.
  if (!electronVersion) return null
  try {
    const electronModule = loadModule()
    if (typeof electronModule === 'object' && electronModule && 'app' in electronModule) {
      return electronModule.app
    }
  } catch {
    // Node-side tests can import this module without an Electron runtime.
  }
  return null
}

const electronApp = resolveElectronApp()

export function getNativeAddonCandidates(): string[] {
  const binary = 'twilight_audio_node.node'
  const appPath = electronApp?.getAppPath?.() ?? process.cwd()
  return [
    join(process.resourcesPath ?? '', 'audio-engine', binary),
    join(appPath, 'resources', 'audio-engine', binary),
    join(appPath, 'audio-engine', 'build', 'default', binary),
    join(appPath, 'audio-engine', 'build', 'mingw-static', binary),
    join(appPath, 'audio-engine', 'build', 'windows-msvc', binary),
    join(appPath, '..', 'audio-engine', 'build', 'default', binary),
    join(appPath, '..', 'audio-engine', 'build', 'mingw-static', binary),
    join(appPath, '..', 'audio-engine', 'build', 'windows-msvc', binary)
  ]
}

export function rendererFallbackAllowed(): boolean {
  return process.env.TWILIGHT_ENABLE_HTMLAUDIO_FALLBACK === '1'
}

export type NativeBindingLoadAttempt = { candidate: string; error: string }

export type NativeBindingLoadResult = {
  binding: NativeAudioBinding | null
  /** Candidates that existed on disk but could not be required. */
  attempts: NativeBindingLoadAttempt[]
  candidateCount: number
}

const MAX_NATIVE_FAILURE_DETAIL = 240

export function loadNativeBindingWithDiagnostics(
  getCandidates: () => string[] = getNativeAddonCandidates
): NativeBindingLoadResult {
  const candidates = getCandidates()
  const attempts: NativeBindingLoadAttempt[] = []
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      // Native addons must be loaded dynamically because the file is produced by CMake.
      return {
        binding: require(candidate) as NativeAudioBinding,
        attempts,
        candidateCount: candidates.length
      }
    } catch (err) {
      attempts.push({ candidate, error: err instanceof Error ? err.message : String(err) })
      console.warn('原生音频模块加载失败：', candidate, err)
    }
  }
  return { binding: null, attempts, candidateCount: candidates.length }
}

export function loadNativeBinding(
  getCandidates: () => string[] = getNativeAddonCandidates
): NativeAudioBinding | null {
  return loadNativeBindingWithDiagnostics(getCandidates).binding
}

/**
 * Why the addon is unavailable, phrased for the crash notice the user sees.
 * A file that is absent and a file that fails to dlopen (on Windows, almost
 * always a runtime DLL missing beside it) need completely different repairs, so
 * the reason carries the real loader error instead of collapsing both cases into
 * a bare "未加载 twilight_audio_node.node".
 */
export function describeNativeBindingFailure(result: NativeBindingLoadResult): string {
  if (result.binding) return ''
  const prefix = '未加载 twilight_audio_node.node'
  const [firstAttempt] = result.attempts
  if (!firstAttempt) {
    if (result.candidateCount === 0) return `${prefix}（没有可用的模块路径）`
    return `${prefix}（${result.candidateCount} 个候选路径均不存在）`
  }
  // The Windows loader puts its description on the first line and the module
  // path on the next, so keep the line that names the actual failure.
  const reason = firstAttempt.error.split('\n')[0].trim() || '未知错误'
  const detail = `${firstAttempt.candidate}：${reason}`
  return `${prefix}（${detail.length > MAX_NATIVE_FAILURE_DETAIL ? `${detail.slice(0, MAX_NATIVE_FAILURE_DETAIL)}…` : detail}）`
}
