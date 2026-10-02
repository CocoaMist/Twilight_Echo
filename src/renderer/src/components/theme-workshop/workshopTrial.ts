import { THEME_MANAGED_DATA_ATTRIBUTES, type ThemeTone } from '../../../../shared/theme.ts'
import {
  workshopRuntimeAttributes,
  type WorkshopProject
} from '../../../../shared/themeWorkshop.ts'

export function createWorkshopTrial(doc: Document, onStop: () => void) {
  let attributes: Record<string, string | null> = {}
  let recovery: HTMLButtonElement | undefined
  let sheet: HTMLStyleElement | undefined
  function stop(): void {
    for (const [key, value] of Object.entries(attributes)) {
      if (value === null) doc.documentElement.removeAttribute(key)
      else doc.documentElement.setAttribute(key, value)
    }
    attributes = {}
    recovery?.remove()
    recovery = undefined
    sheet?.remove()
    sheet = undefined
    onStop()
  }
  function update(project: WorkshopProject, css: string, tone: ThemeTone): void {
    if (!sheet) return
    sheet.textContent = css
    for (const key of THEME_MANAGED_DATA_ATTRIBUTES) doc.documentElement.removeAttribute(key)
    const next = { ...workshopRuntimeAttributes(project), 'data-theme': tone }
    for (const [key, value] of Object.entries(next)) {
      if (!(key in attributes)) attributes[key] = doc.documentElement.getAttribute(key)
      doc.documentElement.setAttribute(key, value)
    }
  }
  function start(project: WorkshopProject, css: string, tone: ThemeTone): void {
    stop()
    for (const key of [...THEME_MANAGED_DATA_ATTRIBUTES, 'data-theme'])
      attributes[key] = doc.documentElement.getAttribute(key)
    sheet = doc.createElement('style')
    sheet.id = 'workshop-trial'
    doc.head.append(sheet)
    update(project, css, tone)
    recovery = doc.createElement('button')
    recovery.textContent = '退出主题试用 · Esc'
    recovery.setAttribute('popover', 'manual')
    for (const [key, value] of Object.entries({
      position: 'fixed',
      top: '12px',
      right: '12px',
      left: 'auto',
      bottom: 'auto',
      margin: '0',
      display: 'block',
      padding: '12px 18px',
      background: '#ffffff',
      color: '#152a30',
      border: '2px solid #087f79',
      'border-radius': '12px',
      'font-size': '14px',
      opacity: '1',
      visibility: 'visible',
      'pointer-events': 'auto'
    }))
      recovery.style.setProperty(key, value, 'important')
    recovery.onclick = stop
    doc.body.append(recovery)
    recovery.showPopover()
  }
  return { start, stop, update }
}
