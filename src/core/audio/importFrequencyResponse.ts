import { basename, extname } from 'node:path'
import { parseAutoEqCsv, type ImportedFrequencyResponse } from '../../shared/frequencyResponse.ts'

export const MAX_IMPORTED_FREQUENCY_RESPONSE_BYTES = 5 * 1024 * 1024

export interface FrequencyResponseImportDialogResult {
  canceled: boolean
  filePaths: string[]
}

export function validateFrequencyResponseImportPath(filePath: string): void {
  if (extname(filePath).toLowerCase() !== '.csv') {
    throw new Error('Imported frequency response must be a .csv file')
  }
}

export function validateFrequencyResponseImportText(filePath: string, contents: string): void {
  validateFrequencyResponseImportPath(filePath)
  if (Buffer.byteLength(contents, 'utf-8') > MAX_IMPORTED_FREQUENCY_RESPONSE_BYTES) {
    throw new Error('Imported frequency response exceeds the 5 MiB limit')
  }
  if (!contents.trim() || /\0/.test(contents) || contents.includes('\uFFFD')) {
    throw new Error('Imported frequency response must be valid non-empty UTF-8 text')
  }
}

export async function importFrequencyResponseFromDialog(
  result: FrequencyResponseImportDialogResult,
  readText: (filePath: string) => Promise<string>,
  readByteSize?: (filePath: string) => Promise<number>
): Promise<ImportedFrequencyResponse | null> {
  if (result.canceled || result.filePaths.length === 0) return null
  if (result.filePaths.length !== 1) throw new Error('Select exactly one AutoEq CSV file')
  const filePath = result.filePaths[0]
  validateFrequencyResponseImportPath(filePath)
  if (readByteSize && (await readByteSize(filePath)) > MAX_IMPORTED_FREQUENCY_RESPONSE_BYTES) {
    throw new Error('Imported frequency response exceeds the 5 MiB limit')
  }
  const contents = await readText(filePath)
  validateFrequencyResponseImportText(filePath, contents)
  return parseAutoEqCsv(contents, basename(filePath))
}
