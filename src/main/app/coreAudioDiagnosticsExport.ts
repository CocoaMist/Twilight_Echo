import type { AudioDiagnosticReport } from '../../shared/coreAudioDiagnostics.ts'
import type { AppLocale } from '../../shared/i18n/locale.ts'
import { renderAudioDiagnosticMarkdown } from '../audio/diagnosticReport.ts'

export interface CoreAudioDiagnosticsExportOptions {
  locale: AppLocale
  choose(): Promise<string | null>
  report(locale: AppLocale): Promise<AudioDiagnosticReport>
  write(path: string, contents: string): Promise<void>
}

/** Main supplies only the dialog and filesystem; the complete evidence is captured by Core. */
export async function exportCoreAudioDiagnostics(options: CoreAudioDiagnosticsExportOptions) {
  const chosen = await options.choose()
  if (!chosen) return { filePath: null }
  const report = await options.report(options.locale)
  const base = chosen.replace(/\.(?:md|json)$/i, '')
  const json = chosen.toLowerCase().endsWith('.json')
  const markdownPath = json ? `${base}.md` : chosen
  const jsonPath = json ? chosen : `${base}.json`
  await options.write(markdownPath, renderAudioDiagnosticMarkdown(options.locale, report))
  await options.write(jsonPath, `${JSON.stringify(report, null, 2)}\n`)
  return { filePath: markdownPath }
}
