const SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

interface FocusEnvironment {
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>
  document: Pick<Document, 'activeElement' | 'body'>
  requestFrame: typeof requestAnimationFrame
  cancelFrame: typeof cancelAnimationFrame
}

const traps: object[] = []
const backgroundOwners = new WeakMap<HTMLElement, { count: number; original: boolean }>()

/** Owns listeners, the opening frame and the opener; Vue only controls activation. */
export function createFocusTrap(getRoot: () => HTMLElement | null, environment: FocusEnvironment) {
  const { window, document, requestFrame, cancelFrame } = environment
  const entry = {}
  let active = false
  let opener: HTMLElement | null = null
  let frame: number | null = null
  let background: HTMLElement[] = []

  function restoreBackground(): void {
    for (const element of background) {
      const owner = backgroundOwners.get(element)
      if (!owner || --owner.count > 0) continue
      element.inert = owner.original
      backgroundOwners.delete(element)
    }
    background = []
  }

  function disableBackground(root: HTMLElement): void {
    restoreBackground()
    let current: HTMLElement | null = root
    while (current?.parentElement) {
      for (const sibling of Array.from(current.parentElement.children)) {
        if (sibling === current) continue
        const element = sibling as HTMLElement
        const owner = backgroundOwners.get(element)
        if (owner) owner.count++
        else backgroundOwners.set(element, { count: 1, original: element.inert })
        background.push(element)
        element.inert = true
      }
      current = current.parentElement
      if (current === document.body) break
    }
  }

  function targets(root: HTMLElement): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>(SELECTOR)).filter(
      (element) => element.getClientRects().length > 0 && !element.closest('[inert]')
    )
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.key !== 'Tab' || traps.at(-1) !== entry) return
    const root = getRoot()
    if (!root) return
    const focusable = targets(root)
    if (focusable.length === 0) {
      event.preventDefault()
      root.focus()
      return
    }
    const first = focusable[0]
    const last = focusable.at(-1)!
    const current = document.activeElement
    if (event.shiftKey && (current === first || !root.contains(current))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (current === last || !root.contains(current))) {
      event.preventDefault()
      first.focus()
    }
  }

  function cancelOpeningFrame(): void {
    if (frame !== null) cancelFrame(frame)
    frame = null
  }

  return {
    activate(): void {
      if (!active) {
        active = true
        opener = document.activeElement as HTMLElement | null
        traps.push(entry)
        window.addEventListener('keydown', onKeydown, true)
      }
      cancelOpeningFrame()
      frame = requestFrame(() => {
        frame = null
        if (!active || traps.at(-1) !== entry) return
        const root = getRoot()
        if (root?.isConnected) {
          disableBackground(root)
          ;(targets(root)[0] ?? root).focus()
        }
      })
    },
    deactivate(): void {
      cancelOpeningFrame()
      if (!active) return
      active = false
      const wasTop = traps.at(-1) === entry
      const index = traps.indexOf(entry)
      if (index !== -1) traps.splice(index, 1)
      window.removeEventListener('keydown', onKeydown, true)
      restoreBackground()
      const root = getRoot()
      const current = document.activeElement
      if (
        wasTop &&
        opener?.isConnected &&
        (!current || current === document.body || root?.contains(current))
      )
        opener.focus()
      opener = null
    }
  }
}
