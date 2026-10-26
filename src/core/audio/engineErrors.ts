/**
 * Structured errors for the audio engine's process-independent throw sites.
 *
 * These rejections cross IPC into the renderer, where Electron flattens them to
 * a string and drops every custom property — so the code travels inside the
 * message as a `[TE-ERR:...]` sentinel (see `shared/errors/appError.ts`). The
 * renderer's `setAudioEngineError` choke point translates the code and strips
 * the tail, so the user reads their own language rather than pre-rendered
 * Chinese.
 *
 * The developer prose stays English: it is what lands in logs, stack traces and
 * the diagnostics report, where a fixed language is more useful than a localized
 * one.
 *
 * `code` is the full catalog key suffix (`audio.device_switch_failed`), matching
 * the `error.<code>` entries in the message catalogs. It is spelled out at every
 * call site rather than assembled here, so grepping the catalog key finds the
 * throw.
 */
import { ipcError } from '../../shared/errors/appError.ts'
import type { MessageParams } from '../../shared/i18n/translate.ts'

/** Fallback when the native layer reported no reason of its own. */
const NATIVE_UNAVAILABLE = 'native audio engine unavailable'

/**
 * A native call that returned false or threw.
 *
 * `detail` is the native layer's own message. It travels as the `{reason}` param
 * so each language can place it where its own grammar wants it, instead of being
 * concatenated onto a Chinese sentence at the throw site.
 */
export function nativeAudioError(code: string, developerMessage: string, detail?: string): Error {
  const resolved = detail?.trim() || NATIVE_UNAVAILABLE
  // The param is named `detail` to match the `{detail}` placeholder the engine
  // entries use. A mismatched name is not a type error — it renders the literal
  // `{detail}` in the UI — so the coverage gate checks this pairing.
  return ipcError(code, `${developerMessage}: ${resolved}`, { detail: resolved })
}

/** An error with no native detail — a precondition or contract failure. */
export function audioEngineError(
  code: string,
  developerMessage: string,
  params: MessageParams = {}
): Error {
  return ipcError(code, developerMessage, params)
}
