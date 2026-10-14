import { app, ipcMain, powerMonitor, utilityProcess } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DiagnosticWriterClient } from './client.ts'
import {
  configureDiagnosticLogger,
  diagnosticIdentity,
  installConsoleDiagnostics,
  writeDiagnostic
} from './logger.ts'
import { installIpcDiagnostics, flushDiagnosticAggregates } from './observation.ts'
import { isTrustedIpcSender } from '../security/electronSecurity.ts'
import { installNetworkDiagnostics } from './network.ts'
import { observeUtilityProcess } from './utilityObservation.ts'

app.setName('TwilightEcho')
export const diagnosticDirectory =
  process.env.TWILIGHT_LOG_DIRECTORY || join(app.getPath('logs'), 'diagnostics')
export const diagnosticWriter = new DiagnosticWriterClient(
  diagnosticDirectory,
  join(app.getAppPath(), 'out/main/diagnosticWriter.js')
)
configureDiagnosticLogger({ sessionId: randomUUID(), processRole: 'main' }, (event) =>
  diagnosticWriter.record(event)
)
process.env.TWILIGHT_LOG_DIRECTORY = diagnosticDirectory
process.env.TWILIGHT_LOG_SESSION_ID = diagnosticIdentity().sessionId
process.env.TAE_DIAGNOSTICS_DIR = diagnosticDirectory
installConsoleDiagnostics('main.console')
installIpcDiagnostics(ipcMain, isTrustedIpcSender)
installNetworkDiagnostics()

process.on('uncaughtExceptionMonitor', (error, origin) => {
  const entry = writeDiagnostic('app', 'process.uncaught-exception', { error, origin }, 'fatal')
  if (entry) diagnosticWriter.emergency(entry)
})
writeDiagnostic('app', 'session.start', {
  appVersion: app.getVersion(),
  packaged: app.isPackaged,
  platform: process.platform,
  architecture: process.arch,
  versions: process.versions
})

app.on('web-contents-created', (_event, contents) => {
  const windowId = contents.id
  writeDiagnostic('window', 'created', { windowId, type: contents.getType() })
  contents.on('console-message', (details) => {
    const level =
      details.level === 'error'
        ? 'error'
        : details.level === 'warning'
          ? 'warn'
          : details.level === 'debug'
            ? 'debug'
            : 'info'
    writeDiagnostic(
      'renderer.console',
      'console.message',
      { windowId, message: details.message, line: details.lineNumber, source: details.sourceId },
      level
    )
  })
  contents.on('did-fail-load', (_event, errorCode, description, _url, isMainFrame) =>
    writeDiagnostic(
      'window',
      'load.failed',
      { windowId, errorCode, description, isMainFrame },
      'error'
    )
  )
  contents.on('render-process-gone', (_event, details) =>
    writeDiagnostic('window', 'renderer.gone', { windowId, ...details }, 'error')
  )
  contents.on('preload-error', (_event, _path, error) =>
    writeDiagnostic('window', 'preload.failed', { windowId, error }, 'error')
  )
  contents.on('unresponsive', () => writeDiagnostic('window', 'unresponsive', { windowId }, 'warn'))
  contents.on('responsive', () => writeDiagnostic('window', 'responsive', { windowId }))
  contents.on('destroyed', () => writeDiagnostic('window', 'destroyed', { windowId }))
})
app.on('child-process-gone', (_event, details) =>
  writeDiagnostic('app', 'child-process.gone', details, 'error')
)

const originalFork = utilityProcess.fork.bind(utilityProcess)
utilityProcess.fork = (entry, args, options) => {
  const child = originalFork(entry, args, options)
  observeUtilityProcess(child, options?.serviceName ?? 'utility')
  return child
}

app
  .whenReady()
  .then(async () => {
    for (const event of [
      'suspend',
      'resume',
      'on-ac',
      'on-battery',
      'shutdown',
      'lock-screen',
      'unlock-screen'
    ])
      (powerMonitor as NodeJS.EventEmitter).on(event, () => writeDiagnostic('system', event))
    const { registerDiagnosticsIpc } = await import('./ipc.ts')
    registerDiagnosticsIpc(diagnosticWriter)
    writeDiagnostic('app', 'app.ready')
  })
  .catch((error) => writeDiagnostic('app', 'diagnostics.setup-failed', { error }, 'error'))

let shuttingDown = false
app.on('will-quit', (event) => {
  if (shuttingDown) return
  shuttingDown = true
  event.preventDefault()
  flushDiagnosticAggregates()
  writeDiagnostic('app', 'session.end')
  void diagnosticWriter.close().finally(() => app.quit())
})
