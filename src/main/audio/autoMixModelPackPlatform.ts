import { createReadStream, createWriteStream } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { CoreModelPackDecode } from '../../shared/coreModelPack.ts'
import { probeStemRuntime } from './autoMixStemRuntime.ts'
import { decodeStemZipLzma } from './autoMixStemZipLzma.ts'

/** Fixed OS jobs for Core-owned installations; no submitted executable or arguments. */
export function createAutoMixModelPackPlatform(options: {
  root: string
  workerDirectory: string
  chooseArchive(): Promise<string | null>
}) {
  const running = new Set<Promise<unknown>>()
  const run = <T>(action: () => Promise<T>): Promise<T> => {
    const work = action()
    running.add(work)
    void work.finally(() => running.delete(work)).catch(() => {})
    return work
  }
  const managedDirectory = async (path: string, name: RegExp): Promise<string> => {
    const directory = await realpath(path)
    if (dirname(directory) !== (await realpath(options.root)) || !name.test(basename(directory)))
      throw new Error('Unknown AutoMix installation ticket')
    return directory
  }
  return {
    idle: async () => {
      await Promise.allSettled([...running])
    },
    operations: {
      'automix.chooseArchive': () => options.chooseArchive(),
      'automix.probeInstall': ({ packDirectory }: { packDirectory: string }, signal: AbortSignal) =>
        run(async () => {
          const directory = await managedDirectory(packDirectory, /^(?:[a-f0-9]{24}|[a-f0-9]{64})$/)
          return probeStemRuntime(directory, options.workerDirectory, signal)
        }),
      'automix.decodeArchiveEntry': (request: CoreModelPackDecode, signal: AbortSignal) =>
        run(async () => {
          if (
            !Number.isSafeInteger(request.bytes) ||
            request.bytes < 0 ||
            request.bytes > 8 * 1024 ** 3
          )
            throw new Error('Invalid AutoMix decoded size')
          const directory = await managedDirectory(request.directory, /^\.decode-[a-zA-Z0-9]+$/)
          let bytes = 0
          const limit = new Transform({
            transform(chunk: Buffer, _encoding, done) {
              bytes += chunk.length
              done(bytes > request.bytes ? new Error('invalid_zip_lzma_size') : null, chunk)
            }
          })
          await pipeline(
            decodeStemZipLzma(
              createReadStream(join(directory, 'input.lzma')),
              request.bytes,
              join(options.workerDirectory, '7za.exe'),
              signal
            ),
            limit,
            createWriteStream(join(directory, 'output.bin'), { flags: 'wx' }),
            { signal }
          )
          if (bytes !== request.bytes) throw new Error('invalid_zip_lzma_size')
        })
    }
  }
}
