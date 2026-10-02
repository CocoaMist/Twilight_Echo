import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const FONT_REGISTRY_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'
const USER_FONT_REGISTRY_KEY = 'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'
const REGISTRY_TIMEOUT_MS = 15000
const MAX_FONTS = 600

/**
 * The renderer cannot answer this itself: `queryLocalFonts()` needs a permission
 * grant and the session denies every permission by design
 * (`security/electronSecurity.ts`), so the family list comes from the registry
 * through main instead.
 *
 * This module deliberately imports no Electron surface so the parser stays
 * unit-testable under plain `node --test`.
 */

/**
 * Registry value names carry the technical suffix Windows shows in the Fonts
 * folder — "Arial Bold Italic (TrueType)". Strip the format tag and the trailing
 * style words so the list reads like a font menu rather than a file listing.
 */
const STYLE_SUFFIX =
  /\s+(?:thin|extra\s?light|ultra\s?light|light|regular|normal|medium|semi\s?bold|demi\s?bold|bold|extra\s?bold|ultra\s?bold|black|heavy|italic|oblique)+$/i

export function parseWindowsFontFamilies(registryOutput: string): string[] {
  const families = new Set<string>()

  for (const rawLine of registryOutput.split(/\r?\n/)) {
    // `reg query /s` prints "    <name>    REG_SZ    <file>".
    const match = /^\s{2,}(.+?)\s{4,}REG_[A-Z_]+\s{4,}(.*)$/.exec(rawLine)
    if (!match) continue

    // Drop the format tag: "(TrueType)", "(OpenType)", "(All res)".
    const name = match[1]
      .trim()
      .replace(/\s*\([^)]*\)\s*$/, '')
      .trim()
    if (!name) continue

    // A single entry can register several localized names: "宋体 & 新宋体".
    for (const candidate of name.split('&')) {
      const family = normalizeFamilyName(candidate)
      if (family) families.add(family)
    }
  }

  return [...families].sort((left, right) => left.localeCompare(right)).slice(0, MAX_FONTS)
}

function normalizeFamilyName(candidate: string): string | null {
  const trimmed = candidate.trim()
  if (!trimmed) return null
  // Vertical-writing aliases duplicate a family that is already in the list.
  if (trimmed.startsWith('@')) return null
  if (trimmed.length > 96) return null

  // Repeat: "Arial Bold Italic" needs two passes to reach "Arial".
  let family = trimmed
  let previous: string
  do {
    previous = family
    family = family.replace(STYLE_SUFFIX, '').trim()
  } while (family !== previous && family)

  // A font whose whole name is a style word ("Bold") must survive rather than
  // be stripped down to nothing.
  return family || trimmed
}

/** Share a query in flight; transient failures must not cache an empty catalog. */
export function createFontFamilyLoader(query: () => Promise<string[]>) {
  let cachedFonts: string[] | null = null
  let pending: Promise<string[]> | null = null
  let generation = 0
  return {
    list(): Promise<string[]> {
      if (cachedFonts) return Promise.resolve(cachedFonts)
      if (pending) return pending
      const queryGeneration = generation
      const task = Promise.resolve()
        .then(query)
        .then((fonts) => {
          if (queryGeneration === generation && fonts.length > 0) cachedFonts = fonts
          return fonts
        })
        .catch(() => [])
        .finally(() => {
          if (pending === task) pending = null
        })
      pending = task
      return task
    },
    clear(): void {
      generation++
      cachedFonts = null
      pending = null
    }
  }
}

async function queryInstalledFontFamilies(): Promise<string[]> {
  if (process.platform !== 'win32') return []
  // Read both hives with one PowerShell startup; a missing per-user key is normal.
  const paths = [FONT_REGISTRY_KEY, USER_FONT_REGISTRY_KEY]
    .map((key) => "'Registry::" + key + "'")
    .join(',')
  const script = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); foreach ($path in @(${paths})) { $key = Get-Item -LiteralPath $path -ErrorAction SilentlyContinue; if ($null -eq $key) { continue }; foreach ($name in $key.GetValueNames()) { '    ' + $name + '    REG_SZ    ' + $key.GetValue($name) } }`
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      timeout: REGISTRY_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024
    }
  )
  return parseWindowsFontFamilies(stdout)
}

const fontLoader = createFontFamilyLoader(queryInstalledFontFamilies)

export function listInstalledFontFamilies(): Promise<string[]> {
  return fontLoader.list()
}

/** Exposed for tests; installing a font mid-session is rare enough to ignore. */
export function clearInstalledFontCache(): void {
  fontLoader.clear()
}
