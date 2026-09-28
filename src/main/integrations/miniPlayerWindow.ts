import type { Rectangle } from 'electron'
import {
  MINI_PLAYER_MAX_HEIGHT,
  MINI_PLAYER_MAX_WIDTH,
  MINI_PLAYER_MIN_HEIGHT,
  MINI_PLAYER_MIN_WIDTH,
  type MiniPlayerSettings
} from '../../shared/miniPlayer.ts'

export {
  MINI_PLAYER_MAX_HEIGHT,
  MINI_PLAYER_MAX_WIDTH,
  MINI_PLAYER_MIN_HEIGHT,
  MINI_PLAYER_MIN_WIDTH
}

export function clampMiniPlayerBoundsToWorkArea(bounds: Rectangle, workArea: Rectangle): Rectangle {
  const maxWidth = Math.max(1, Math.min(MINI_PLAYER_MAX_WIDTH, Math.round(workArea.width)))
  const maxHeight = Math.max(1, Math.min(MINI_PLAYER_MAX_HEIGHT, Math.round(workArea.height)))
  const minWidth = Math.min(MINI_PLAYER_MIN_WIDTH, maxWidth)
  const minHeight = Math.min(MINI_PLAYER_MIN_HEIGHT, maxHeight)
  const width = clampNumber(Math.round(bounds.width), minWidth, maxWidth)
  const height = clampNumber(Math.round(bounds.height), minHeight, maxHeight)
  const minX = Math.round(workArea.x)
  const minY = Math.round(workArea.y)
  const maxX = minX + Math.round(workArea.width) - width
  const maxY = minY + Math.round(workArea.height) - height

  return {
    x: clampNumber(Math.round(bounds.x), minX, maxX),
    y: clampNumber(Math.round(bounds.y), minY, maxY),
    width,
    height
  }
}

const MAX_MINI_PLAYER_COORDINATE = 100_000
// Windows lands a frameless thick-frame window up to a few pixels off the bounds
// it was given at fractional scale factors.
const MINI_PLAYER_BOUNDS_ECHO_SLACK = 4

/** Whether a bounds reading is the rounded echo of a programmatic setBounds rather than a user edit. */
export function isMiniPlayerBoundsEcho(actual: Rectangle, requested: Rectangle): boolean {
  return (
    Math.abs(actual.x - requested.x) <= MINI_PLAYER_BOUNDS_ECHO_SLACK &&
    Math.abs(actual.y - requested.y) <= MINI_PLAYER_BOUNDS_ECHO_SLACK &&
    Math.abs(actual.width - requested.width) <= MINI_PLAYER_BOUNDS_ECHO_SLACK &&
    Math.abs(actual.height - requested.height) <= MINI_PLAYER_BOUNDS_ECHO_SLACK
  )
}

/**
 * Resizes toward the work-area corner the window sits nearest, so a player parked
 * in a corner keeps that corner through form switches instead of being pushed out
 * by the clamp on the way up and left stranded on the way down.
 */
export function resizeMiniPlayerBounds(
  current: Rectangle,
  size: { width: number; height: number },
  workArea: Rectangle
): Rectangle {
  const sized = clampMiniPlayerBoundsToWorkArea({ ...current, ...size }, workArea)
  const anchorRight = current.x + current.width / 2 > workArea.x + workArea.width / 2
  const anchorBottom = current.y + current.height / 2 > workArea.y + workArea.height / 2
  return clampMiniPlayerBoundsToWorkArea(
    {
      x: anchorRight ? current.x + current.width - sized.width : current.x,
      y: anchorBottom ? current.y + current.height - sized.height : current.y,
      width: sized.width,
      height: sized.height
    },
    workArea
  )
}

/**
 * Validates a renderer drag target. The mini player moves itself with pointer
 * events instead of `-webkit-app-region: drag`, because a drag region swallows
 * every hover and click the redesigned surface relies on.
 */
export function parseMiniPlayerMoveTarget(payload: unknown): { x: number; y: number } | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const { x, y } = payload as { x?: unknown; y?: unknown }
  if (typeof x !== 'number' || typeof y !== 'number') return null
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  if (Math.abs(x) > MAX_MINI_PLAYER_COORDINATE || Math.abs(y) > MAX_MINI_PLAYER_COORDINATE) {
    return null
  }
  return { x: Math.round(x), y: Math.round(y) }
}

export function miniPlayerBoundsPatch(
  bounds: Rectangle
): Pick<MiniPlayerSettings, 'windowX' | 'windowY' | 'windowWidth' | 'windowHeight'> {
  return {
    windowX: Math.round(bounds.x),
    windowY: Math.round(bounds.y),
    windowWidth: Math.round(bounds.width),
    windowHeight: Math.round(bounds.height)
  }
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}
