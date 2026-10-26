import type { NetworkSourceErrorCode } from '../../shared/networkSources.ts'

/** 网络源统一结构化错误：渲染层只读 code，message 不携带凭据。 */
export class NetworkSourceFailure extends Error {
  code: NetworkSourceErrorCode
  constructor(code: NetworkSourceErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/** The adapter could not prove that the response starts at the requested byte. */
export class NetworkResumeUnsupported extends NetworkSourceFailure {
  constructor() {
    super('network', '远程服务器未确认续传范围')
  }
}

export function toNetworkSourceFailure(err: unknown): NetworkSourceFailure {
  if (err instanceof NetworkSourceFailure) return err
  if (err instanceof Error && (err as { code?: string }).code === 'ABORT_ERR') {
    return new NetworkSourceFailure('timeout', '网络请求超时')
  }
  const message = err instanceof Error ? err.message : String(err)
  return new NetworkSourceFailure('network', `网络源操作失败：${message}`)
}
