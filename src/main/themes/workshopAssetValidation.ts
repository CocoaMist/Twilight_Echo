import { Buffer } from 'node:buffer'
import type { WorkshopProject } from '../../shared/themeWorkshop.ts'
import type { WorkshopDiagnostic } from '../../shared/themeWorkshopDiagnostics.ts'

export function diagnoseWorkshopAssetEncoding(
  project: WorkshopProject,
  decodeImage: (dataUrl: string) => boolean
): WorkshopDiagnostic[] {
  const diagnostics: WorkshopDiagnostic[] = []
  for (const asset of project.assets ?? []) {
    const bytes = Buffer.from(asset.dataUrl.slice(asset.dataUrl.indexOf(',') + 1), 'base64')
    const valid =
      asset.type === 'font'
        ? bytes.length >= 48 &&
          bytes.toString('ascii', 0, 4) === 'wOF2' &&
          bytes.readUInt32BE(8) === bytes.length &&
          bytes.readUInt16BE(12) > 0
        : decodeImage(asset.dataUrl)
    if (!valid)
      diagnostics.push({
        id: `asset.decode:${asset.id}`,
        code: 'asset.decode',
        severity: 'error',
        message: `${asset.name} 素材编码无效，请替换素材`,
        location: { kind: 'asset', id: asset.id }
      })
  }
  return diagnostics
}
