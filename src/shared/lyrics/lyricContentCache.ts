import { buildLyricLines } from './lyricLineBuilder.ts'
import type { BuildLyricLinesOptions, LyricLine } from './lyricTypes.ts'

/** One current content version per consumer, never a cross-track text cache. */
export function createLyricContentCache(): typeof buildLyricLines {
  let previous: readonly unknown[] | null = null
  let lines: LyricLine[] = []
  return (
    original: string | null | undefined,
    translation: string | null | undefined,
    romanization?: string | null,
    options: BuildLyricLinesOptions = {}
  ) => {
    const key = [
      original,
      translation,
      romanization,
      !!options.replaceTtmlTranslation,
      !!options.replaceTtmlRomanization
    ]
    if (previous && key.every((value, index) => value === previous![index])) return lines
    lines = buildLyricLines(original, translation, romanization, options)
    previous = key
    return lines
  }
}
