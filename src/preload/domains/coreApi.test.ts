import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { readFile } from 'node:fs/promises'
import type { EventEmitter } from 'node:events'
import test from 'node:test'
import { CORE_WINDOW_IPC } from '../../shared/coreBridge.ts'

const hooks = registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? { url: 'test:core-preload', shortCircuit: true }
      : next(specifier, context)
  },
  load(url, context, next) {
    return url === 'test:core-preload'
      ? {
          format: 'module',
          shortCircuit: true,
          source: `import { EventEmitter } from 'node:events';
export const calls=[];
export const ipcRenderer=Object.assign(new EventEmitter(),{invoke:async(...args)=>{calls.push(args);return {ok:false,error:{code:'STALE_REVISION',message:'stale'}}}});`
        }
      : next(url, context)
  }
})
const electron = (await import('electron')) as unknown as {
  calls: unknown[][]
  ipcRenderer: EventEmitter
}
const { coreApi } = await import('./coreApi.ts')
hooks.deregister()

test('preload forwards only fixed Core channels and keeps structured errors across context isolation', async () => {
  assert.deepEqual(await coreApi.connect(), {
    ok: false,
    error: { code: 'STALE_REVISION', message: 'stale' }
  })
  await coreApi.cancel('owned', 'request')
  await coreApi.disconnect('owned')
  assert.deepEqual(electron.calls, [
    [CORE_WINDOW_IPC.connect, {}],
    [CORE_WINDOW_IPC.cancel, { connectionId: 'owned', requestId: 'request' }],
    [CORE_WINDOW_IPC.disconnect, { connectionId: 'owned' }]
  ])
  const seen: unknown[] = [],
    dispose = coreApi.onMessage((message) => seen.push(message))
  electron.ipcRenderer.emit(
    CORE_WINDOW_IPC.message,
    { secret: 'ipc-event' },
    { connectionId: 'owned' }
  )
  dispose()
  assert.deepEqual(seen, [{ connectionId: 'owned' }])
  assert.equal(electron.ipcRenderer.listenerCount(CORE_WINDOW_IPC.message), 0)
  const source = await readFile(new URL('./coreApi.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /node:|from ['"].*main\//)
})
