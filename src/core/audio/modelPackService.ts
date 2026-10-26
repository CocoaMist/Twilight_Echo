import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type {
  CoreModelPackDecode,
  CoreModelPackStatus,
  CoreModelPackPlatformOperations
} from '../../shared/coreModelPack.ts'
import { AutoMixStemInstaller } from './autoMixStemInstaller.ts'

interface Options {
  root: string
  chooseArchive(signal: AbortSignal): Promise<string | null>
  decode(request: CoreModelPackDecode, signal: AbortSignal): Promise<void>
  probe(
    directory: string,
    signal: AbortSignal
  ): Promise<CoreModelPackPlatformOperations['automix.probeInstall']['output']>
  changed(): void
  installed(enableAfterInstall: boolean): Promise<void>
  checkpointSha256?: string
}

/** An accepted installation belongs to Core, not to its initiating connection. */
export class CoreModelPackService {
  private readonly installer: AutoMixStemInstaller
  private pending: Promise<void> | null = null
  private stopped = false
  private readonly options: Options
  constructor(options: Options) {
    this.options = options
    const root = join(options.root, 'automix-stem-packs')
    this.installer = new AutoMixStemInstaller({
      root: () => root,
      chooseArchive: options.chooseArchive,
      decodeLzma: (input, bytes, signal, progress) =>
        decodeWithPlatform(root, input, bytes, options.decode, signal, progress),
      lzmaDiskTickets: true,
      probe: options.probe,
      changed: options.changed,
      checkpointSha256: options.checkpointSha256
    })
  }
  state(): CoreModelPackStatus {
    return this.installer.getStatus()
  }
  start(enableAfterInstall: boolean): CoreModelPackStatus {
    if (this.stopped) throw new Error('Core model installer is stopped')
    if (!this.pending) {
      const work = this.installer.install().then(async (state) => {
        if (state.phase === 'ready') await this.options.installed(enableAfterInstall)
      })
      this.pending = work
      void work
        .finally(() => {
          if (this.pending === work) this.pending = null
          this.options.changed()
        })
        .catch(() => {})
    }
    return this.state()
  }
  cancel(): CoreModelPackStatus {
    return this.installer.cancel()
  }
  async shutdown(): Promise<void> {
    this.stopped = true
    await this.installer.shutdown()
    await this.pending
  }
}

/** Disk tickets keep multi-GB entry bytes out of IPC and keep 7za in main. */
export function decodeWithPlatform(
  root: string,
  input: Readable,
  bytes: number,
  decode: Options['decode'],
  signal: AbortSignal,
  progress?: (bytes: number) => void
): Readable {
  async function* run(): AsyncGenerator<Buffer> {
    await mkdir(root, { recursive: true })
    const directory = await mkdtemp(join(root, '.decode-'))
    try {
      await pipeline(input, createWriteStream(join(directory, 'input.lzma'), { flags: 'wx' }), {
        signal
      })
      signal.throwIfAborted()
      // This capability must join decoder exit on cancellation before cleanup.
      let decoding = true
      const output = join(directory, 'output.bin')
      const timer = setInterval(() => {
        void stat(output)
          .then((file) => {
            if (decoding) progress?.(Math.min(bytes, file.size))
          })
          .catch(() => {})
      }, 250)
      try {
        await decode({ directory, bytes }, signal)
      } finally {
        decoding = false
        clearInterval(timer)
      }
      signal.throwIfAborted()
      await rm(join(directory, 'input.lzma'))
      for await (const chunk of createReadStream(output, { signal })) yield chunk as Buffer
    } finally {
      input.destroy()
      await rm(directory, { recursive: true, force: true })
    }
  }
  return Readable.from(run(), { objectMode: false })
}
