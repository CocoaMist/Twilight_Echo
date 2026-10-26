import { realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { CoreAutoMixWorkerRequest } from '../../shared/coreAutoMix.ts'
import { probeStemRuntime, runAutoMixStemWorker } from './autoMixStemRuntime.ts'

/** The registry fixes both entry points; no executable, script or env comes from Core. */
export function createAutoMixProcessPlatform(options: {
  candidates(): string[]
  workerDirectory: string
  temporaryDirectory: string
}) {
  const running = new Set<Promise<unknown>>()
  const run = <T>(action: () => Promise<T>): Promise<T> => {
    const work = action()
    running.add(work)
    void work.finally(() => running.delete(work)).catch(() => {})
    return work
  }
  const authorizePack = (path: string) => {
    const pack = resolve(path)
    if (!options.candidates().some((candidate) => resolve(candidate) === pack))
      throw new Error('Unknown AutoMix runtime pack')
    return pack
  }
  return {
    idle: async () => {
      await Promise.allSettled([...running])
    },
    operations: {
      'automix.environment': async () => ({
        candidates: options.candidates(),
        workerDirectory: options.workerDirectory,
        temporaryDirectory: options.temporaryDirectory
      }),
      'automix.probe': ({ packDirectory }: { packDirectory: string }, signal: AbortSignal) =>
        run(async () =>
          probeStemRuntime(authorizePack(packDirectory), options.workerDirectory, signal)
        ),
      'automix.runWorker': (request: CoreAutoMixWorkerRequest, signal: AbortSignal) =>
        run(async () => {
          const pack = authorizePack(request.packDirectory)
          const file = await realpath(request.requestPath)
          const directory = dirname(file)
          if (
            basename(file) !== 'request.json' ||
            dirname(directory) !== (await realpath(options.temporaryDirectory)) ||
            !basename(directory).startsWith('twilight-automix-material-')
          )
            throw new Error('Unknown AutoMix material ticket')
          await runAutoMixStemWorker(
            pack,
            join(options.workerDirectory, 'worker.py'),
            file,
            request.budgetMs,
            signal
          )
        })
    }
  }
}
