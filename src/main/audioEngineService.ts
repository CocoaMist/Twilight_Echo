import {
  describeNativeBindingFailure,
  loadNativeBindingWithDiagnostics
} from './audio/nativeBinding.ts'
import type { NativeAudioBinding } from './audio/audioEngineTypes.ts'
import {
  createAudioServiceCapabilities,
  REQUIRED_AUDIO_SERVICE_DSP_METHODS,
  type AudioServiceCapabilities
} from '../shared/audioServiceContract.ts'

type AudioServiceRequest = {
  kind: 'request'
  requestId: string
  method: keyof NativeAudioBinding
  args: unknown[]
}

type AudioServiceResponse = {
  kind: 'response'
  requestId: string
  ok: boolean
  value?: unknown
  error?: string
}

type ParentPort = {
  postMessage: (
    message:
      | AudioServiceResponse
      | { kind: 'ready'; capabilities: AudioServiceCapabilities }
      | { kind: 'fatal'; error: string }
  ) => void
  on: (event: 'message', listener: (message: AudioServiceRequest) => void) => void
}

type ElectronParentPort = {
  postMessage: ParentPort['postMessage']
  on: (event: 'message', listener: (event: { data: AudioServiceRequest }) => void) => void
}

type NodeIpcProcess = {
  send?: ParentPort['postMessage']
  on?: (event: 'message', listener: (message: AudioServiceRequest) => void) => void
}

const maybeElectronParentPort = (process as unknown as { parentPort?: ElectronParentPort })
  .parentPort
const maybeNodeIpc = process as unknown as NodeIpcProcess
const parentPort: ParentPort | null = maybeElectronParentPort
  ? {
      postMessage: (message) => maybeElectronParentPort.postMessage(message),
      on: (_event, listener) =>
        maybeElectronParentPort.on('message', (event) => listener(event.data))
    }
  : typeof maybeNodeIpc.send === 'function' && typeof maybeNodeIpc.on === 'function'
    ? {
        postMessage: (message) => {
          maybeNodeIpc.send?.(message)
        },
        on: (_event, listener) => maybeNodeIpc.on?.('message', listener)
      }
    : null

if (!parentPort) {
  throw new Error('Twilight audio engine service must run with Electron parentPort or Node IPC')
}

const servicePort = parentPort
const nativeLoad = loadNativeBindingWithDiagnostics()
const native = nativeLoad.binding
const nativeMethods = native
  ? Object.getOwnPropertyNames(native).filter(
      (method) => typeof native[method as keyof NativeAudioBinding] === 'function'
    )
  : []
const missingDspMethods = REQUIRED_AUDIO_SERVICE_DSP_METHODS.filter(
  (method) => typeof native?.[method] !== 'function'
)
const nativeContractError = !native
  ? describeNativeBindingFailure(nativeLoad)
  : missingDspMethods.length > 0
    ? `native audio binding is missing required DSP methods: ${missingDspMethods.join(', ')}`
    : ''

if (nativeContractError) {
  servicePort.postMessage({ kind: 'fatal', error: nativeContractError })
} else {
  servicePort.postMessage({
    kind: 'ready',
    capabilities: createAudioServiceCapabilities(nativeMethods)
  })
}

servicePort.on('message', (message) => {
  if (message.kind !== 'request') return
  void handleRequest(message)
})

async function handleRequest(message: AudioServiceRequest): Promise<void> {
  if (!native || nativeContractError) {
    post({
      kind: 'response',
      requestId: message.requestId,
      ok: false,
      error: nativeContractError || '未加载 twilight_audio_node.node'
    })
    return
  }
  try {
    if (
      message.method === 'AnalyzeBpm' ||
      message.method === 'AnalyzeLoudness' ||
      message.method === 'AnalyzeAutoMix'
    ) {
      throw new Error(`${String(message.method)} must use the isolated audio analysis service`)
    }
    const method = native[message.method]
    if (typeof method !== 'function') {
      throw new Error(`原生音频服务不支持方法：${String(message.method)}`)
    }
    const value = (method as (...args: unknown[]) => unknown)(...message.args)
    post({ kind: 'response', requestId: message.requestId, ok: true, value })
  } catch (error) {
    post({
      kind: 'response',
      requestId: message.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

function post(message: AudioServiceResponse): void {
  servicePort.postMessage(message)
}
