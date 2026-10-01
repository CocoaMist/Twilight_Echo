import type { WorkshopLayer, WorkshopSurface } from '../../../../shared/themeWorkshopLayers.ts'
import type { WorkshopProject } from '../../../../shared/themeWorkshop.ts'
import { WORKSHOP_SURFACE_SELECTORS } from '../../../../shared/themeWorkshopLayerCss.ts'

export interface WorkshopCanvasBox {
  id: string
  surface: WorkshopSurface
  name: string
  left: number
  top: number
  width: number
  height: number
  hostWidth: number
  hostHeight: number
}
export function workshopCanvasBoxes(
  doc: Document,
  project: WorkshopProject,
  tone: 'dark' | 'pureWhite'
): WorkshopCanvasBox[] {
  const boxes: WorkshopCanvasBox[] = []
  for (const [surface, layers] of Object.entries(project.layers?.[tone] ?? {})) {
    const host = doc.querySelector(WORKSHOP_SURFACE_SELECTORS[surface as WorkshopSurface])
    const bounds = host?.getBoundingClientRect()
    if (!host || !bounds?.width || !bounds.height) continue
    for (const [index, layer] of layers.entries()) {
      const target = host.querySelector<HTMLElement>(
        `:scope > .workshop-decoration > :nth-child(${index + 1})`
      )
      const rect = target?.getBoundingClientRect()
      if (
        !target ||
        !layer.visible ||
        !rect?.width ||
        !rect.height ||
        doc.defaultView?.getComputedStyle(target).display === 'none'
      )
        continue
      boxes.push({
        id: layer.id,
        surface: surface as WorkshopSurface,
        name: layer.name,
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        hostWidth: bounds.width,
        hostHeight: bounds.height
      })
    }
  }
  return boxes
}
export function workshopCanvasPoint(
  event: Pick<PointerEvent, 'clientX' | 'clientY'>,
  rect: Pick<DOMRect, 'left' | 'top' | 'width'>,
  width: number
): { x: number; y: number } {
  const zoom = rect.width / width || 1
  return { x: (event.clientX - rect.left) / zoom, y: (event.clientY - rect.top) / zoom }
}
export function workshopLayerDrag(
  layer: WorkshopLayer,
  box: WorkshopCanvasBox,
  dx: number,
  dy: number,
  resize: boolean
): Partial<WorkshopLayer> {
  const clamp = (value: number, min: number, max: number): number =>
    Math.max(min, Math.min(max, value))
  return resize
    ? {
        scale: clamp(
          layer.scale * Math.max(0.1, (box.width + dx) / box.width, (box.height + dy) / box.height),
          0.1,
          5
        )
      }
    : {
        x: clamp(layer.x + (dx / box.hostWidth) * 100, -100, 200),
        y: clamp(layer.y + (dy / box.hostHeight) * 100, -100, 200)
      }
}
