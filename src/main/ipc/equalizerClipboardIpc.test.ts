import assert from 'node:assert/strict'
import test from 'node:test'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { registerEqualizerClipboardIpc } from './equalizerClipboardIpc.ts'
import type { EqualizerBand } from '../../shared/audioEngineTypes.ts'

test('clipboard handlers validate DTOs and sender before accessing the system clipboard', () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, value?: unknown) => unknown>()
  const ipc = { handle: (channel, handler) => handlers.set(channel, handler) } as Pick<
    IpcMain,
    'handle'
  >
  const event = {} as IpcMainInvokeEvent
  let trusted = true,
    clipboard = 'unrelated private text',
    reads = 0,
    writes = 0
  registerEqualizerClipboardIpc(ipc, {
    assertTrusted: () => {
      if (!trusted) throw new Error('Untrusted')
    },
    readText: () => {
      reads++
      return clipboard
    },
    writeText: (value) => {
      writes++
      clipboard = value
    }
  })
  const copy = (value: unknown) => handlers.get('window:copy-eq-bands')!(event, value)
  const paste = () => handlers.get('window:paste-eq-bands')!(event)
  assert.throws(paste, /没有可粘贴/)
  assert.throws(() => copy([{ gain: 3 }]), /参数无效/)
  assert.equal(clipboard, 'unrelated private text')
  assert.equal(writes, 0)
  const bands: EqualizerBand[] = [
    { frequency: 1000, gain: 0, q: 1, filterType: 'highPass', enabled: false, channelMask: 2 }
  ]
  copy(bands)
  assert.deepEqual(paste(), bands)
  assert.equal(writes, 1)
  trusted = false
  assert.throws(() => copy(bands), /Untrusted/)
  assert.throws(paste, /Untrusted/)
  assert.equal(writes, 1)
  assert.equal(reads, 2)
})
