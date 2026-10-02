import { resolveMotionMode, type ResolvedMotionMode } from '../../../shared/motion.ts'

/** The document contains the resolved preference, including an explicit full override. */
export function documentMotionMode(): ResolvedMotionMode {
  const mode = document.documentElement.dataset.teMotion
  if (mode === 'full' || mode === 'reduced' || mode === 'off') return mode
  return resolveMotionMode('system', window.matchMedia('(prefers-reduced-motion: reduce)').matches)
}

export function scrollMotionBehavior(
  requested: ScrollBehavior = 'smooth',
  keyboardNavigation = false
): ScrollBehavior {
  return documentMotionMode() !== 'full' || keyboardNavigation ? 'instant' : requested
}
