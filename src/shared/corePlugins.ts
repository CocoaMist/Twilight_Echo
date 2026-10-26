import type { TwilightMediaProviderMethod } from './mediaProviderMethods.ts'

/** The download coordinator, not a UI/plugin caller, owns these provider methods. */
export const CORE_HOST_PROVIDER_METHODS = new Set<TwilightMediaProviderMethod>([
  'createDownload',
  'getDownloadStatus',
  'getDownloadFile',
  'cancelDownload'
])
export interface CoreProviderCall {
  providerId: string
  method: TwilightMediaProviderMethod
  args: unknown[]
  idempotencyKey?: string
}

export interface CoreExperienceDocument { revision: number; value: Record<string, unknown> }
