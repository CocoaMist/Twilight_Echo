import { execFile } from 'node:child_process'
import type { SftpBatchResult } from '../../core/network/adapters/sftpSystemAdapter.ts'
export async function runSftpBatch(
  batch: string,
  deps: { host: string; port: number; username: string; keyPath: string },
  signal?: AbortSignal
): Promise<SftpBatchResult> {
  signal?.throwIfAborted()
  return new Promise((resolve) => {
    const child = execFile(
      'sftp',
      ['-b', '-', '-i', deps.keyPath, '-P', String(deps.port), `${deps.username}@${deps.host}`],
      { encoding: 'utf8', timeout: 60_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          code:
            typeof error === 'object' && error !== null
              ? ((error as { code?: number }).code ?? 1)
              : 0
        })
      }
    )
    const onAbort = (): void => {
      child.kill()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.once('close', () => signal?.removeEventListener('abort', onAbort))
    child.stdin?.write(batch)
    child.stdin?.end()
  })
}

import type { MountCommandResult } from '../../core/network/adapters/smbMountAdapter.ts'
export async function runMountCommand(
  command: string,
  args: string[],
  signal?: AbortSignal
): Promise<MountCommandResult> {
  signal?.throwIfAborted()
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      { encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          code:
            typeof error === 'object' && error !== null
              ? ((error as { code?: number }).code ?? 1)
              : 0
        })
      }
    )
    const abort = () => {
      child.kill()
    }
    signal?.addEventListener('abort', abort, { once: true })
    child.once('close', () => signal?.removeEventListener('abort', abort))
  })
}
