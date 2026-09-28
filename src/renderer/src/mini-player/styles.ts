import {
  DEFAULT_MINI_PLAYER_SETTINGS,
  DEFAULT_MINI_PLAYER_STYLE_ID,
  MINI_PLAYER_MIN_HEIGHT,
  MINI_PLAYER_MIN_WIDTH,
  createDefaultMiniPlayerThemeProfile,
  normalizeMiniPlayerThemeProfile,
  type MiniPlayerThemeProfile,
  type MiniPlayerWindowSize
} from '../../../shared/miniPlayer.ts'

export type MiniPlayerStyleTokens = Record<`--mini-${string}`, string>

export interface MiniPlayerStyleDefinition {
  id: string
  name: string
  description: string
  className: string
  layout: 'artwork-card'
  windowSize: MiniPlayerWindowSize
  accentMode: 'track' | 'fixed'
  fixedAccent?: string
  nativeBackgroundColor: string
  defaultProfile: MiniPlayerThemeProfile
  tokens: MiniPlayerStyleTokens
}

const styleRegistry = new Map<string, MiniPlayerStyleDefinition>()

export function registerMiniPlayerStyle(
  definition: MiniPlayerStyleDefinition,
  options: { replace?: boolean } = {}
): () => void {
  const normalized = normalizeStyleDefinition(definition)
  const previous = styleRegistry.get(normalized.id)
  if (previous && options.replace !== true) {
    throw new Error(`Mini player style already registered: ${normalized.id}`)
  }

  styleRegistry.set(normalized.id, normalized)
  return () => {
    if (styleRegistry.get(normalized.id) !== normalized) return
    if (previous) styleRegistry.set(previous.id, previous)
    else styleRegistry.delete(normalized.id)
  }
}

export function listMiniPlayerStyles(): MiniPlayerStyleDefinition[] {
  return [...styleRegistry.values()]
}

export function resolveMiniPlayerStyle(styleId: string): MiniPlayerStyleDefinition {
  const style =
    styleRegistry.get(styleId) ??
    styleRegistry.get(DEFAULT_MINI_PLAYER_STYLE_ID) ??
    listMiniPlayerStyles()[0]
  if (!style) throw new Error('No mini player styles are registered')
  return style
}

export function getNextMiniPlayerStyle(styleId: string): MiniPlayerStyleDefinition {
  const styles = listMiniPlayerStyles()
  if (styles.length === 0) throw new Error('No mini player styles are registered')
  const currentIndex = styles.findIndex((style) => style.id === styleId)
  return styles[(currentIndex + 1 + styles.length) % styles.length]!
}

function normalizeStyleDefinition(
  definition: MiniPlayerStyleDefinition
): MiniPlayerStyleDefinition {
  const id = definition.id.trim()
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) {
    throw new Error(`Invalid mini player style id: ${definition.id}`)
  }
  if (!definition.name.trim()) throw new Error(`Mini player style ${id} requires a name`)

  return {
    ...definition,
    id,
    name: definition.name.trim(),
    description: definition.description.trim(),
    className: definition.className.trim(),
    nativeBackgroundColor: /^#[\da-f]{6}$/i.test(definition.nativeBackgroundColor)
      ? definition.nativeBackgroundColor
      : '#11121d',
    defaultProfile: normalizeMiniPlayerThemeProfile(
      definition.defaultProfile,
      createDefaultMiniPlayerThemeProfile(id)
    ),
    windowSize: {
      width: Math.min(
        760,
        Math.max(MINI_PLAYER_MIN_WIDTH, Math.round(definition.windowSize.width))
      ),
      height: Math.min(
        420,
        Math.max(MINI_PLAYER_MIN_HEIGHT, Math.round(definition.windowSize.height))
      )
    },
    tokens: { ...definition.tokens }
  }
}

registerMiniPlayerStyle({
  id: DEFAULT_MINI_PLAYER_STYLE_ID,
  name: '暮光玻璃',
  description: '歌词页同款封面背景',
  className: 'mini-style-aurora',
  layout: 'artwork-card',
  windowSize: {
    width: DEFAULT_MINI_PLAYER_SETTINGS.windowWidth,
    height: DEFAULT_MINI_PLAYER_SETTINGS.windowHeight
  },
  accentMode: 'track',
  nativeBackgroundColor: '#0a0c10',
  defaultProfile: createDefaultMiniPlayerThemeProfile(DEFAULT_MINI_PLAYER_STYLE_ID),
  tokens: {
    '--mini-placeholder': 'linear-gradient(145deg, #26343b, #10171d)',
    '--mini-highlight': 'rgba(255, 255, 255, 0.16)',
    '--mini-grain-opacity': '0.07'
  }
})

registerMiniPlayerStyle({
  id: 'porcelain',
  name: '月白',
  description: '明亮留白与柔和纸感',
  className: 'mini-style-porcelain',
  layout: 'artwork-card',
  windowSize: {
    width: DEFAULT_MINI_PLAYER_SETTINGS.windowWidth,
    height: DEFAULT_MINI_PLAYER_SETTINGS.windowHeight
  },
  accentMode: 'fixed',
  fixedAccent: '#5966d9',
  nativeBackgroundColor: '#f4f5fb',
  defaultProfile: createDefaultMiniPlayerThemeProfile('porcelain'),
  tokens: {
    '--mini-placeholder': 'linear-gradient(145deg, #e9e5ff, #dce7ff)',
    '--mini-highlight': 'rgba(255, 255, 255, 0.7)',
    '--mini-grain-opacity': '0.05'
  }
})
