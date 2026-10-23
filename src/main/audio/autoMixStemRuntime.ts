import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { StemRuntimeProbe } from '../../core/audio/autoMixStemCapabilities.ts'

export function probeStemRuntime(
  directory: string,
  workerDirectory: string,
  signal?: AbortSignal
): Promise<StemRuntimeProbe> {
  signal?.throwIfAborted()
  return new Promise((resolveProbe, reject) => {
    const child = spawn(
      join(directory, 'runtime', 'python.exe'),
      [join(workerDirectory, 'probe.py'), directory],
      {
        cwd: directory,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONNOUSERSITE: '1',
          PYTHONUTF8: '1',
          PYTHONDONTWRITEBYTECODE: '1',
          OPENBLAS_NUM_THREADS: '1'
        }
      }
    )
    const cancel = () => {
      child.kill()
    }
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
    let output = ''
    let failure: Error | undefined
    const timer = setTimeout(() => {
      failure = new Error('probe_timeout')
      child.kill()
    }, 20_000)
    child.stdout.on('data', (chunk) => {
      output += chunk.toString()
      if (Buffer.byteLength(output) > 64 * 1024) {
        failure = new Error('runtime_unavailable')
        child.kill()
      }
    })
    child.stderr.on('data', () => {})
    child.once('error', () => {
      failure ??= new Error('runtime_unavailable')
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      if (signal?.aborted) return reject(signal.reason)
      if (failure || code !== 0) return reject(failure ?? new Error('runtime_unavailable'))
      try {
        const line = output
          .split(/\r?\n/)
          .find((item) => item.startsWith('TWILIGHT_STEM_CAPABILITIES='))
        const result = JSON.parse(line?.slice('TWILIGHT_STEM_CAPABILITIES='.length) ?? '')
        if (typeof result.cpu !== 'boolean' || typeof result.gpu !== 'boolean' || !result.cpu)
          throw new Error('runtime_unavailable')
        resolveProbe({
          cpu: result.cpu,
          gpu: result.gpu,
          gpuName: typeof result.gpuName === 'string' ? result.gpuName.slice(0, 200) : undefined
        })
      } catch {
        reject(new Error('runtime_unavailable'))
      }
    })
  })
}

export async function runAutoMixStemWorker(
  pack: string,
  worker: string,
  request: string,
  budget: number,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  const directory = dirname(request)
  await new Promise<void>((resolveTask, reject) => {
    const child = spawn(join(pack, 'runtime', 'python.exe'), [worker, request], {
      cwd: pack,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        PYTHONNOUSERSITE: '1',
        PYTHONUTF8: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        OPENBLAS_NUM_THREADS: '1'
      }
    })
    let settled = false
    let pendingError: Error | undefined
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      if (error) {
        reject(error)
      } else resolveTask()
    }
    const stop = (error: Error) => {
      pendingError ??= error
      // close fires only after the worker exits and its pipes close. Keep
      // busy/material ownership until then; cleanup cannot race the worker.
      child.kill()
    }
    const cancel = () => stop(new Error('stems_cancelled'))
    const timer = setTimeout(() => stop(new Error('stem_timeout')), budget)
    child.stderr?.on('data', () => {})
    child.on('error', () => {
      pendingError ??= new Error('stem_worker_unavailable')
    })
    child.on('close', (code) =>
      finish(
        pendingError ??
          (code !== 0 && !existsSync(join(directory, 'result.json'))
            ? new Error('stem_worker_exited')
            : undefined)
      )
    )
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
  })
}
