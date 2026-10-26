import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { CoreModelPackService, decodeWithPlatform } from './modelPackService.ts'
import { managedStemPackDirectories } from './autoMixStemInstaller.ts'
import { STEM_MODEL_VERSION } from './autoMixStemService.ts'

const crc32 = createRequire(import.meta.url)('buffer-crc32')
const model = Buffer.from('Core model installation fixture')
const checkpointSha256 = createHash('sha256').update(model).digest('hex')
const metadata = Buffer.from(JSON.stringify({ modelVersion: STEM_MODEL_VERSION, checkpointSha256 }))

async function archive(path: string): Promise<void> {
  const files = [
    ['manifest.json', metadata],
    ['model.lock.json', metadata],
    ['models/955717e8-8726e21a.th', model],
    ['runtime/python.exe', Buffer.from('fixture')]
  ] as const
  const local: Buffer[] = [],
    central: Buffer[] = []
  let offset = 0
  for (const [name, data] of files) {
    const filename = Buffer.from(name),
      crc = crc32.unsigned(data)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50)
    header.writeUInt16LE(20, 4)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(data.length, 18)
    header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(filename.length, 26)
    local.push(header, filename, data)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(filename.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, filename)
    offset += header.length + filename.length + data.length
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  await writeFile(path, Buffer.concat([...local, directory, end]))
}

async function fixture(
  t: test.TestContext,
  options: Partial<ConstructorParameters<typeof CoreModelPackService>[0]> = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'core-model-pack-'))
  const path = join(root, 'fixture.zip')
  await archive(path)
  let selected = 0
  const installed: boolean[] = []
  const states: string[] = []
  const service = new CoreModelPackService({
    root,
    chooseArchive: async () => {
      selected++
      return path
    },
    decode: async () => {
      throw new Error('Stored fixture must not request decoding')
    },
    probe: async () => ({ cpu: true, gpu: false }),
    changed: () => states.push(service.state().phase),
    installed: async (enableAfterInstall) => {
      installed.push(enableAfterInstall)
    },
    checkpointSha256,
    ...options
  })
  t.after(async () => {
    await service.shutdown()
    await rm(root, { recursive: true, force: true })
  })
  return { root, service, states, selected: () => selected, installed }
}

async function finished(service: CoreModelPackService) {
  for (let i = 0; i < 200; i++) {
    if (['ready', 'cancelled', 'failed'].includes(service.state().phase)) return
    await delay(5)
  }
  assert.fail(`Installation did not finish: ${service.state().phase}`)
}

test('accepted installs survive the caller, coalesce and publish one validated package', async (t) => {
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const f = await fixture(t, {
    probe: async () => {
      entered()
      await gate
      return { cpu: true, gpu: true }
    }
  })
  assert.equal(f.service.start(true).phase, 'selecting')
  await started
  assert.equal(f.service.start(false).phase, 'verifying')
  assert.equal(f.selected(), 1)
  const state = f.service.state()
  state.phase = 'idle'
  assert.equal(f.service.state().phase, 'verifying')
  release()
  await finished(f.service)
  assert.equal(f.service.state().phase, 'ready')
  assert.deepEqual(f.installed, [true])
  const [installed] = managedStemPackDirectories(join(f.root, 'automix-stem-packs'))
  assert.deepEqual(await readFile(join(installed, 'models/955717e8-8726e21a.th')), model)
  assert.deepEqual(
    f.states.filter((phase, i) => phase !== f.states[i - 1]),
    ['selecting', 'checking', 'extracting', 'verifying', 'ready']
  )
  assert.ok(!JSON.stringify(f.service.state()).includes(f.root))
})

test('shutdown joins probe cancellation and leaves no unpublished package', async (t) => {
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let aborted = false
  const f = await fixture(t, {
    probe: async (_directory, signal) => {
      entered()
      signal.addEventListener(
        'abort',
        () => {
          aborted = true
        },
        { once: true }
      )
      await gate
      signal.throwIfAborted()
      return { cpu: true, gpu: false }
    }
  })
  f.service.start(true)
  await started
  let stopped = false
  const shutdown = f.service.shutdown().then(() => {
    stopped = true
  })
  await delay(5)
  assert.equal(aborted, true)
  assert.equal(stopped, false)
  release()
  await shutdown
  assert.equal(f.service.state().phase, 'cancelled')
  assert.deepEqual(f.installed, [])
  assert.deepEqual(await readdir(join(f.root, 'automix-stem-packs')), [])
  assert.throws(() => f.service.start(false), /stopped/)
})

test('picker cancellation changes no files and shutdown aborts an outstanding picker', async (t) => {
  const f = await fixture(t, {
    chooseArchive: async (signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve(null), { once: true })
      })
  })
  f.service.start(false)
  await f.service.shutdown()
  assert.equal(f.service.state().phase, 'cancelled')
  assert.deepEqual(await readdir(f.root), ['fixture.zip'])
})

test('disk decode tickets stream bytes and join platform cancellation before cleanup', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'core-model-decode-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const signal = new AbortController()
  const input = Buffer.from('compressed fixture'),
    output = Buffer.from('decoded fixture')
  const stream = decodeWithPlatform(
    root,
    Readable.from([input]),
    output.length,
    async (request) => {
      assert.deepEqual(await readFile(join(request.directory, 'input.lzma')), input)
      await writeFile(join(request.directory, 'output.bin'), output)
    },
    signal.signal
  )
  const actual: Buffer[] = []
  for await (const bytes of stream) actual.push(bytes)
  assert.deepEqual(Buffer.concat(actual), output)
  assert.deepEqual(await readdir(root), [])

  let release!: () => void, entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const cancelled = decodeWithPlatform(
    root,
    Readable.from([input]),
    output.length,
    async (_request, signal) => {
      entered()
      await gate
      signal.throwIfAborted()
    },
    signal.signal
  )
  const failed = assert.rejects(async () => {
    for await (const _chunk of cancelled) {
      /* consume */
    }
  }, /abort/i)
  await started
  signal.abort()
  await delay(5)
  assert.equal((await readdir(root)).length, 1)
  release()
  await failed
  assert.deepEqual(await readdir(root), [])
})
