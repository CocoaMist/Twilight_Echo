import type {
  MiniPlayerLayoutPreference,
  MiniPlayerThemeProfile,
  MiniPlayerVisibilitySettings
} from '../../../shared/miniPlayer.ts'

/**
 * compact = single-row strip, standard = artwork card, wide = stage with inline
 * volume and queue, poster = portrait sleeve with the artwork on top.
 */
export type MiniPlayerResolvedLayout = 'compact' | 'standard' | 'wide' | 'poster'
export type MiniPlayerCssVariables = Record<`--mini-${string}`, string>

export const MINI_PLAYER_STANDARD_MIN_HEIGHT = 150
export const MINI_PLAYER_WIDE_MIN_WIDTH = 600
export const MINI_PLAYER_WIDE_MIN_HEIGHT = 230
export const MINI_PLAYER_POSTER_MIN_HEIGHT = 320
/** Portrait once the window is noticeably taller than wide. */
export const MINI_PLAYER_POSTER_ASPECT = 1.15

function resolveLandscapeLayout(width: number, height: number): MiniPlayerResolvedLayout {
  if (height < MINI_PLAYER_STANDARD_MIN_HEIGHT) return 'compact'
  if (width >= MINI_PLAYER_WIDE_MIN_WIDTH && height >= MINI_PLAYER_WIDE_MIN_HEIGHT) return 'wide'
  return 'standard'
}

export function resolveMiniPlayerLayout(
  width: number,
  height: number,
  preference: MiniPlayerLayoutPreference
): MiniPlayerResolvedLayout {
  const canUsePoster = height >= MINI_PLAYER_POSTER_MIN_HEIGHT
  const landscape = resolveLandscapeLayout(width, height)

  if (preference === 'compact') return 'compact'
  if (preference === 'standard') return landscape === 'compact' ? 'compact' : 'standard'
  if (preference === 'wide') return landscape
  if (preference === 'poster') return canUsePoster ? 'poster' : landscape
  return canUsePoster && height >= width * MINI_PLAYER_POSTER_ASPECT ? 'poster' : landscape
}

const RESPONSIVE_VISIBILITY: Record<MiniPlayerResolvedLayout, MiniPlayerVisibilitySettings> = {
  compact: {
    artwork: true,
    album: false,
    equalizer: false,
    time: false,
    volume: false,
    playMode: false,
    queuePosition: false
  },
  standard: {
    artwork: true,
    album: true,
    equalizer: true,
    time: true,
    volume: true,
    playMode: true,
    queuePosition: false
  },
  wide: {
    artwork: true,
    album: true,
    equalizer: true,
    time: true,
    volume: true,
    playMode: true,
    queuePosition: true
  },
  poster: {
    artwork: true,
    album: true,
    equalizer: true,
    time: true,
    volume: true,
    playMode: true,
    queuePosition: true
  }
}

export function resolveMiniPlayerVisibility(
  visibility: MiniPlayerVisibilitySettings,
  layout: MiniPlayerResolvedLayout
): MiniPlayerVisibilitySettings {
  const responsiveMask = RESPONSIVE_VISIBILITY[layout]
  return {
    artwork: visibility.artwork && responsiveMask.artwork,
    album: visibility.album && responsiveMask.album,
    equalizer: visibility.equalizer && responsiveMask.equalizer,
    time: visibility.time && responsiveMask.time,
    volume: visibility.volume && responsiveMask.volume,
    playMode: visibility.playMode && responsiveMask.playMode,
    queuePosition: visibility.queuePosition && responsiveMask.queuePosition
  }
}

export function readableTextColors(surfaceColor: string): { primary: string; muted: string } {
  const normalizedSurface = normalizeHexColor(surfaceColor, '#11121d')
  const light = '#ffffff'
  const dark = '#1b2034'
  const primary =
    contrastRatio(light, normalizedSurface) >= contrastRatio(dark, normalizedSurface) ? light : dark
  const mixedMuted = mixHexColors(primary, normalizedSurface, 0.34)
  const muted = contrastRatio(mixedMuted, normalizedSurface) >= 4.5 ? mixedMuted : primary
  return { primary, muted }
}

export function buildMiniPlayerCssVariables(
  profile: MiniPlayerThemeProfile,
  dominantColor: string,
  volume: number,
  coverSurfaceColor: string | null = null
): MiniPlayerCssVariables {
  const coverMode = profile.background.kind === 'cover'
  const fallbackColor = coverMode
    ? normalizeHexColor(coverSurfaceColor ?? '#0a0c10', '#0a0c10')
    : profile.background.fallbackColor
  const trackAccent =
    coverMode || profile.appearance.accentMode === 'track'
      ? normalizeHexColor(dominantColor, coverMode ? '#8fa8b5' : profile.appearance.accentColor)
      : profile.appearance.accentColor
  const accent =
    !coverMode && hexChroma(trackAccent) < MIN_TRACK_ACCENT_CHROMA
      ? profile.appearance.accentColor
      : trackAccent
  const automaticText = readableTextColors(fallbackColor)
  const primaryText =
    !coverMode && profile.appearance.textMode === 'custom'
      ? profile.appearance.primaryTextColor
      : automaticText.primary
  const mutedText =
    !coverMode && profile.appearance.textMode === 'custom'
      ? profile.appearance.mutedTextColor
      : automaticText.muted

  return {
    // These constants are consumed by the bootstrap fallback UI and keep its
    // appearance stable before a profile has been fully applied. Keeping them
    // with the other presentation tokens also lets the stylesheet remain
    // theme-token-only.
    '--mini-bootstrap-surface': 'color-mix(in srgb, #0f172a 82%, transparent)',
    '--mini-bootstrap-text': '#f8fafc',
    '--mini-bootstrap-action-surface': 'color-mix(in srgb, #8fa8b5 88%, #fff)',
    '--mini-bootstrap-action-text': '#fff',
    '--mini-surface-backdrop': 'rgba(12, 12, 18, 0.92)',
    '--mini-track-accent': trackAccent,
    '--mini-accent': ensureAccentContrast(
      accent,
      estimateMiniPlayerSurface(profile, coverSurfaceColor),
      primaryText
    ),
    '--mini-art-shadow': hexToRgba(
      profile.appearance.shadowColor,
      (profile.appearance.shadowStrength / 100) * ART_SHADOW_ALPHA
    ),
    '--mini-text': primaryText,
    '--mini-muted': mutedText,
    '--mini-font-family': profile.appearance.fontFamily,
    '--mini-window-radius': `${profile.appearance.cornerRadius}px`,
    '--mini-surface-opacity': `${profile.appearance.surfaceOpacity / 100}`,
    '--mini-glass-blur': `${profile.appearance.glassBlur}px`,
    '--mini-border-width': `${profile.appearance.borderWidth}px`,
    '--mini-border-color': profile.appearance.borderColor,
    '--mini-background-opacity': `${profile.background.opacity / 100}`,
    '--mini-background-blur': `${profile.background.blur}px`,
    '--mini-background-brightness': `${profile.background.brightness}%`,
    '--mini-background-saturation': `${profile.background.saturation}%`,
    '--mini-background-overlay': hexToRgba(
      profile.background.overlayColor,
      profile.background.overlayOpacity / 100
    ),
    '--mini-background-fallback': fallbackColor,
    '--mini-background-solid': profile.background.solidColor,
    '--mini-background-fit': profile.background.imageFit,
    '--mini-gradient-angle': `${profile.background.gradientAngle}deg`,
    '--mini-gradient-start': profile.background.gradientStart,
    '--mini-gradient-end': profile.background.gradientEnd,
    '--mini-volume': `${clampPercent(volume)}%`
  }
}

// Icons and fills are non-text UI: WCAG asks 3:1 against what sits behind them.
const MIN_ACCENT_CONTRAST = 3
const MIN_TRACK_ACCENT_CHROMA = 40
// The "shadow strength" slider at its aurora default (80) gives the artwork the
// same 50% drop shadow the design was drawn with.
const ART_SHADOW_ALPHA = 0.62

/**
 * Approximates the colour behind the controls. Cover backgrounds use the sampled
 * average; other backgrounds combine their fallback, source and overlay.
 */
export function estimateMiniPlayerSurface(
  profile: MiniPlayerThemeProfile,
  coverSurfaceColor: string | null = null
): string {
  const background = profile.background
  if (background.kind === 'cover') {
    return normalizeHexColor(coverSurfaceColor ?? '#0a0c10', '#0a0c10')
  }
  const base = normalizeHexColor(background.fallbackColor, '#11121d')
  const source =
    background.kind === 'solid'
      ? background.solidColor
      : background.kind === 'gradient'
        ? mixHexColors(background.gradientStart, background.gradientEnd, 0.5)
        : null
  const lit = source
    ? scaleHexColor(normalizeHexColor(source, base), background.brightness / 100)
    : base
  const withSource = mixHexColors(base, lit, clampUnit(background.opacity / 100))
  return mixHexColors(
    withSource,
    background.overlayColor,
    clampUnit(background.overlayOpacity / 100)
  )
}

/**
 * Cover colours are often near-black or near-white; used raw they disappear
 * into the surface and the progress fill goes invisible. Step the accent's
 * lightness toward the text colour until it separates from the surface, keeping
 * hue and saturation so a dark crimson cover still reads as crimson.
 */
function ensureAccentContrast(accent: string, surface: string, text: string): string {
  const normalizedAccent = normalizeHexColor(accent, '#8fa8b5')
  const normalizedSurface = normalizeHexColor(surface, '#11121d')
  const normalizedText = normalizeHexColor(text, '#ffffff')
  if (contrastRatio(normalizedAccent, normalizedSurface) >= MIN_ACCENT_CONTRAST) {
    return normalizedAccent
  }
  const [hue, saturation, lightness] = hexToHsl(normalizedAccent)
  const direction =
    relativeLuminance(normalizedText) >= relativeLuminance(normalizedSurface) ? 1 : -1
  for (let step = 1; step <= 20; step += 1) {
    const candidate = hslToHex(hue, saturation, clampUnit(lightness + direction * step * 0.05))
    if (contrastRatio(candidate, normalizedSurface) >= MIN_ACCENT_CONTRAST) return candidate
  }
  return normalizedText
}

function hexToHsl(color: string): [number, number, number] {
  const [red, green, blue] = hexChannels(color).map((channel) => channel / 255) as [
    number,
    number,
    number
  ]
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const lightness = (max + min) / 2
  const delta = max - min
  if (delta === 0) return [0, 0, lightness]
  const saturation = delta / (1 - Math.abs(2 * lightness - 1))
  const sector =
    max === red
      ? ((green - blue) / delta) % 6
      : max === green
        ? (blue - red) / delta + 2
        : (red - green) / delta + 4
  return [(sector * 60 + 360) % 360, saturation, lightness]
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1))
  const offset = lightness - chroma / 2
  const [red, green, blue] =
    hue < 60
      ? [chroma, second, 0]
      : hue < 120
        ? [second, chroma, 0]
        : hue < 180
          ? [0, chroma, second]
          : hue < 240
            ? [0, second, chroma]
            : hue < 300
              ? [second, 0, chroma]
              : [chroma, 0, second]
  return `#${[red, green, blue]
    .map((channel) =>
      Math.round(Math.min(1, Math.max(0, channel + offset)) * 255)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`
}

function hexChroma(color: string): number {
  const channels = hexChannels(normalizeHexColor(color, '#000000'))
  return Math.max(...channels) - Math.min(...channels)
}

function scaleHexColor(color: string, factor: number): string {
  const channels = hexChannels(normalizeHexColor(color, '#000000')).map((channel) =>
    Math.round(Math.min(255, Math.max(0, channel * factor)))
  )
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

function clampUnit(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, Math.round(value * 100) / 100))
}

function contrastRatio(first: string, second: string): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second))
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second))
  return (lighter + 0.05) / (darker + 0.05)
}

function relativeLuminance(color: string): number {
  const [red, green, blue] = hexChannels(normalizeHexColor(color, '#000000')).map((channel) => {
    const normalized = channel / 255
    return normalized <= 0.04045 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function mixHexColors(foreground: string, background: string, backgroundWeight: number): string {
  const foregroundChannels = hexChannels(normalizeHexColor(foreground, '#ffffff'))
  const backgroundChannels = hexChannels(normalizeHexColor(background, '#000000'))
  const channels = foregroundChannels.map((channel, index) =>
    Math.round(channel * (1 - backgroundWeight) + backgroundChannels[index]! * backgroundWeight)
  )
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

function hexToRgba(color: string, alpha: number): string {
  const [red, green, blue] = hexChannels(normalizeHexColor(color, '#000000'))
  return `rgba(${red}, ${green}, ${blue}, ${Math.min(1, Math.max(0, alpha))})`
}

function hexChannels(color: string): [number, number, number] {
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16)
  ]
}

function normalizeHexColor(value: string, fallback: string): string {
  return /^#[\da-f]{6}$/i.test(value.trim()) ? value.trim().toLowerCase() : fallback
}
