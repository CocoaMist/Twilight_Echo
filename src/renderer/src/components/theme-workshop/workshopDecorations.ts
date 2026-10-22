import { WORKSHOP_SURFACE_SELECTORS } from '../../../../shared/themeWorkshopLayerCss'
import { WORKSHOP_LAYER_LIMIT } from '../../../../shared/themeWorkshopLayers'

export function mountWorkshopDecorations(doc: Document): () => void {
  const selector = Object.values(WORKSHOP_SURFACE_SELECTORS).join(',')
  const style = doc.createElement('style')
  style.textContent =
    '.workshop-decoration{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:-1;border-radius:inherit}.workshop-decoration>div{display:none;position:absolute;pointer-events:none}'
  doc.head.append(style)
  const pendingRoots = new Set<Element>()
  let scheduled = false
  let disposed = false
  const decorate = (host: Element): void => {
    if (host.querySelector(':scope > .workshop-decoration')) return
    const decoration = doc.createElement('div')
    decoration.className = 'workshop-decoration'
    decoration.setAttribute('aria-hidden', 'true')
    decoration.inert = true
    for (let index = 0; index < WORKSHOP_LAYER_LIMIT; index++)
      decoration.append(doc.createElement('div'))
    host.prepend(decoration)
  }
  const update = (): void => {
    scheduled = false
    if (disposed) return
    const roots = [...pendingRoots]
    pendingRoots.clear()
    const added = new Set(roots)
    for (const root of roots) {
      if (!root.isConnected || root.ownerDocument !== doc) continue
      // A parent insertion already covers all of its descendants in this batch.
      let parent = root.parentElement
      while (parent && !added.has(parent)) parent = parent.parentElement
      if (parent) continue
      if (root.matches(selector)) decorate(root)
      if (root.childElementCount > 0)
        for (const host of root.querySelectorAll(selector)) decorate(host)
    }
  }
  const Observer = doc.defaultView?.MutationObserver ?? MutationObserver
  const observer = new Observer((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1 || (node as Element).classList.contains('workshop-decoration'))
          continue
        pendingRoots.add(node as Element)
      }
    }
    if (scheduled || pendingRoots.size === 0) return
    scheduled = true
    queueMicrotask(update)
  })
  const scroll = (event: Event): void => {
    const target = event.target as Element | null
    if (target?.nodeType !== 1) return
    let host: Element | null = target
    while (host) {
      if (host.matches(selector)) {
        const decoration = host.querySelector<HTMLElement>(':scope > .workshop-decoration')
        const offset = target.scrollTop + 'px'
        if (decoration && decoration.style.getPropertyValue('--te-workshop-scroll-y') !== offset) {
          decoration.style.setProperty('--te-workshop-scroll-y', offset)
        }
      }
      host = host.parentElement
    }
  }
  doc.addEventListener('scroll', scroll, true)
  pendingRoots.add(doc.body)
  update()
  observer.observe(doc.body, { childList: true, subtree: true })
  return () => {
    disposed = true
    pendingRoots.clear()
    observer.disconnect()
    doc.removeEventListener('scroll', scroll, true)
    style.remove()
    doc.querySelectorAll('.workshop-decoration').forEach((node) => node.remove())
  }
}
