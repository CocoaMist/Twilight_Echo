import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { OutputConfig } from '../../shared/audioEngineTypes.ts'

export const OUTPUT_TEST_DURATION_MS = 1_800

/** Quiet, faded PCM notes: left channel first, then right. */
export function createOutputTestWav(): Buffer {
  const rate = 48_000
  const frames = Math.round((rate * OUTPUT_TEST_DURATION_MS) / 1000)
  const wav = Buffer.alloc(44 + frames * 4)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(2, 22)
  wav.writeUInt32LE(rate, 24)
  wav.writeUInt32LE(rate * 4, 28)
  wav.writeUInt16LE(4, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(frames * 4, 40)
  for (let frame = 0; frame < frames; frame++) {
    const time = frame / rate
    for (let channel = 0; channel < 2; channel++) {
      const local = time - (channel === 0 ? 0.1 : 0.95)
      if (local < 0 || local >= 0.65) continue
      const envelope = Math.min(1, local / 0.035, (0.65 - local) / 0.07)
      const sample = Math.sin(2 * Math.PI * (channel === 0 ? 440 : 660) * local) * 0.063 * envelope
      wav.writeInt16LE(Math.round(sample * 32_767), 44 + frame * 4 + channel * 2)
    }
  }
  return wav
}

export interface OutputTestContext {
  backend: string
  device: string
  volume: number
  outputConfig: OutputConfig
  playing: boolean
}

export interface OutputTestService {
  callAsync: (method: string, args: unknown[]) => Promise<unknown>
  destroy: () => void | Promise<void>
}

interface Session {
  cancelled: boolean
  service?: OutputTestService
  cancelWait?: () => void
  closing?: Promise<void>
}

export interface OutputTestDependencies {
  temporaryDirectory: string
  timers: {
    setTimeout(callback: () => void, delay: number): unknown
    clearTimeout(handle: unknown): void
  }
  context: (exclusive: boolean) => Promise<OutputTestContext>
  createService: () => OutputTestService
  durationMs?: number
}

/** A separate native service leaves the user's queue, position and stats alone. */
export class OutputTest {
  private session: Session | null = null
  private pending: Promise<{ cancelled: boolean }> = Promise.resolve({ cancelled: false })
  private readonly dependencies: OutputTestDependencies
  constructor(dependencies: OutputTestDependencies) {
    this.dependencies = dependencies
  }

  async stop(): Promise<void> {
    const session = this.session
    if (session) {
      session.cancelled = true
      session.cancelWait?.()
    }
    await Promise.all([session ? this.close(session) : undefined, this.pending.catch(() => {})])
  }

  play(exclusive: boolean): Promise<{ cancelled: boolean }> {
    if (this.session) return Promise.reject(new Error('测试音正在播放，请稍后再试'))
    const session: Session = { cancelled: false }
    this.session = session
    this.pending = this.run(session, exclusive)
    return this.pending
  }

  private close(session: Session): Promise<void> {
    if (!session.service) return Promise.resolve()
    return (session.closing ??= Promise.resolve().then(() => session.service!.destroy()))
  }

  private async run(session: Session, exclusive: boolean): Promise<{ cancelled: boolean }> {
    let directory: string | undefined
    try {
      const context = await this.dependencies.context(exclusive)
      if (session.cancelled) return { cancelled: true }
      if (context.playing) throw new Error('请先暂停当前歌曲，再试听输出设备')
      if (context.volume <= 0) throw new Error('当前音量为 0，请调整音量后再试听')
      directory = await mkdtemp(join(this.dependencies.temporaryDirectory, 'twilight-output-test-'))
      const source = join(directory, 'test.wav')
      await writeFile(source, createOutputTestWav())
      if (session.cancelled) return { cancelled: true }
      const service = this.dependencies.createService()
      session.service = service
      const command = async (method: string, args: unknown[]) => {
        if (session.cancelled) throw new Error('试听已停止')
        return service.callAsync(method, args)
      }
      await command('SetVolume', [Math.max(0, Math.min(1, context.volume))])
      await command('SetOutputBackend', [context.backend])
      await command('SetOutputDevice', [context.device])
      await command('SetOutputConfig', [JSON.stringify(context.outputConfig)])
      await command('Play', [source, 0])
      const raw = await command('GetPlaybackInfo', [])
      const info = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (info?.state !== 'playing' || info?.source !== source) {
        throw new Error('音频引擎没有确认测试音已开始，请检查设备后重试')
      }
      if (session.cancelled) return { cancelled: true }
      await new Promise<void>((resolveWait) => {
        const timer = this.dependencies.timers.setTimeout(
          resolveWait,
          this.dependencies.durationMs ?? OUTPUT_TEST_DURATION_MS + 150
        )
        session.cancelWait = () => {
          this.dependencies.timers.clearTimeout(timer)
          resolveWait()
        }
      })
      return { cancelled: session.cancelled }
    } catch (error) {
      if (session.cancelled) return { cancelled: true }
      throw error
    } finally {
      // Only the uniquely created temporary directory is ever removed.
      try {
        await this.close(session)
        if (
          directory &&
          resolve(directory).startsWith(resolve(this.dependencies.temporaryDirectory) + sep)
        )
          await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      } finally {
        if (this.session === session) this.session = null
      }
    }
  }
}
