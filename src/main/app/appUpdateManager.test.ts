import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, dirname, basename } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { AppUpdateManager, type AppUpdateManagerOptions } from './appUpdateManager.ts'
import { AppUpdateRepository } from './appUpdateRepository.ts'
import type { AppUpdateSnapshot } from '../../shared/appUpdate.ts'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
async function fixture(t: TestContext) {
  const directory = await mkdtemp(resolve(tmpdir(), 'twilight-update-test-'))
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('twilight-update-test-'))
    await rm(directory, { recursive: true, force: true })
  })
  const state = {
    version: '2.0.0',
    payload: 'installer version two',
    requests: [] as RequestInit[],
    snapshots: [] as AppUpdateSnapshot[],
    calls: [] as string[],
    now: 1_800_000_000_000,
    apiError: 0,
    download: null as null | ((init: RequestInit) => Promise<Response>),
    prepare: async () => {},
    open: async () => ''
  }
  const options: AppUpdateManagerOptions = {
    directory,
    currentVersion: '1.0.0',
    platform: 'win32',
    arch: 'x64',
    now: () => state.now,
    downloadOptions: { retryDelayMs: 1, timeoutMs: 100 },
    fetch: async (input, init) => {
      if (String(input).endsWith('/installer.exe')) {
        state.requests.push(init ?? {})
        if (state.download) return state.download(init ?? {})
        return new Response(state.payload)
      }
      if (state.apiError) return new Response('', { status: state.apiError })
      return Response.json({
        tag_name: state.version,
        html_url: 'https://github.com/Px-asen/Twilight_Echo/releases/tag/v' + state.version,
        body: 'Release notes',
        assets: [
          {
            name: 'TwilightEcho-setup.exe',
            size: Buffer.byteLength(state.payload),
            browser_download_url: 'https://example.com/installer.exe',
            digest: 'sha256:' + hash(state.payload)
          }
        ]
      })
    },
    publish: (snapshot) => state.snapshots.push(snapshot),
    prepareInstall: async () => {
      state.calls.push('save')
      await state.prepare()
    },
    openInstaller: async () => {
      state.calls.push('open')
      return state.open()
    },
    quit: () => {
      state.calls.push('quit')
    }
  }
  const manager = new AppUpdateManager(options)
  await manager.initialize()
  return {
    manager,
    state,
    options,
    directory,
    repository: new AppUpdateRepository(directory),
    restart: (currentVersion = '1.0.0') => new AppUpdateManager({ ...options, currentVersion })
  }
}
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await delay(2)
  }
  assert.fail('Expected state was not reached')
}

test('downloaded version and checksum remain bound across a newer release check', async (t) => {
  const { manager, state } = await fixture(t)
  await manager.check()
  assert.equal((await manager.download()).ok, true)
  state.version = '3.0.0'
  state.payload = 'installer version three'
  await manager.check()
  assert.equal(manager.snapshot().readyVersion, '2.0.0')
  assert.equal((await manager.install()).ok, true)
  assert.deepEqual(state.calls, ['save', 'open', 'quit'])
  assert.equal((await manager.install()).ok, false)
})

test('a no-update check never bypasses install-time verification', async (t) => {
  const { manager, state } = await fixture(t)
  await manager.check()
  const result = await manager.download()
  assert.ok(result.ok)
  state.version = '1.0.0'
  await manager.check()
  await writeFile(result.installerPath, 'x'.repeat(Buffer.byteLength(state.payload)))
  const install = await manager.install()
  assert.equal(install.ok, false)
  if (!install.ok) {
    assert.equal(install.errorCode, 'checksum')
    assert.equal(install.installerPath, null)
  }
  assert.deepEqual(state.calls, [])
  await assert.rejects(stat(result.installerPath), { code: 'ENOENT' })
})

test('cancel retains the task lock until cleanup; a later retry remains cancellable', async (t) => {
  const { manager, state } = await fixture(t)
  await manager.check()
  const pending: { signal: AbortSignal; reject: (error: Error) => void }[] = []
  state.download = (init) =>
    new Promise((_resolve, reject) => pending.push({ signal: init.signal!, reject }))
  const first = manager.download()
  await until(() => pending.length === 1)
  assert.equal(manager.cancel(), true)
  assert.equal(manager.snapshot().progress.phase, 'cancelling')
  const overlap = await manager.download()
  assert.equal(overlap.ok, false)
  pending[0].reject(Object.assign(new Error('abort'), { name: 'AbortError' }))
  const cancelled = await first
  assert.ok(!cancelled.ok && cancelled.cancelled)
  const second = manager.download()
  await until(() => pending.length === 2)
  assert.equal(manager.cancel(), true)
  assert.equal(pending[1].signal.aborted, true)
  pending[1].reject(Object.assign(new Error('abort'), { name: 'AbortError' }))
  await second
})

test('restart restores a partial download and validates HTTP Range before appending', async (t) => {
  const { manager, state, repository, restart } = await fixture(t)
  await manager.check()
  const asset = repository.read().asset!
  await writeFile(repository.partial(asset), state.payload.slice(0, 5))
  const restored = restart()
  await restored.initialize()
  assert.equal(restored.snapshot().progress.phase, 'cancelled')
  state.download = async (init) => {
    assert.equal(new Headers(init.headers).get('range'), 'bytes=5-')
    return new Response(state.payload.slice(5), {
      status: 206,
      headers: { 'content-range': `bytes 5-${asset.size - 1}/${asset.size}` }
    })
  }
  const result = await restored.download()
  assert.ok(result.ok)
  assert.equal(await readFile(result.installerPath, 'utf8'), state.payload)
  await assert.rejects(stat(repository.partial(asset)), { code: 'ENOENT' })
})

test('a server ignoring Range restarts the file instead of appending duplicate data', async (t) => {
  const { manager, state, repository } = await fixture(t)
  await manager.check()
  await writeFile(repository.partial(repository.read().asset!), state.payload.slice(0, 5))
  const result = await manager.download()
  assert.ok(result.ok)
  assert.equal(new Headers(state.requests[0].headers).get('range'), 'bytes=5-')
  assert.equal(await readFile(result.installerPath, 'utf8'), state.payload)
})

test('incorrect range and hash mismatch fail closed and remove invalid partial data', async (t) => {
  const { manager, state, repository } = await fixture(t)
  await manager.check()
  const asset = repository.read().asset!
  await writeFile(repository.partial(asset), state.payload.slice(0, 5))
  state.download = async () =>
    new Response(state.payload, {
      status: 206,
      headers: { 'content-range': `bytes 0-${asset.size - 1}/${asset.size}` }
    })
  assert.equal((await manager.download()).ok, false)
  assert.equal(manager.snapshot().readyVersion, null)
  await assert.rejects(stat(repository.partial(asset)), { code: 'ENOENT' })
  state.download = async () => new Response('x'.repeat(asset.size))
  const corrupted = await manager.download()
  assert.ok(!corrupted.ok && corrupted.errorCode === 'checksum')
  await assert.rejects(stat(repository.partial(asset)), { code: 'ENOENT' })
})

test('transient HTTP failures retry finitely and completed packages are reused', async (t) => {
  const { manager, state, restart } = await fixture(t)
  await manager.check()
  state.download = async () =>
    state.requests.length < 3 ? new Response('', { status: 503 }) : new Response(state.payload)
  assert.equal((await manager.download()).ok, true)
  assert.equal(state.requests.length, 3)
  const restored = restart()
  await restored.initialize()
  assert.equal(restored.snapshot().progress.phase, 'ready')
  assert.equal((await restored.download()).ok, true)
  assert.equal(state.requests.length, 3)
})

test('stalled downloads timeout after bounded retries and can be retried by the user', async (t) => {
  const { manager, state } = await fixture(t)
  await manager.check()
  state.download = async (init) =>
    new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
    })
  const result = await manager.download()
  assert.ok(!result.ok && result.errorCode === 'timeout')
  assert.equal(state.requests.length, 3)
  state.download = null
  assert.equal((await manager.download()).ok, true)
})

test('saving playback must succeed before launching; failed launch remains retryable', async (t) => {
  const { manager, state } = await fixture(t)
  await manager.check()
  await manager.download()
  state.prepare = async () => {
    throw new Error('save failed')
  }
  assert.equal((await manager.install()).ok, false)
  assert.deepEqual(state.calls, ['save'])
  state.prepare = async () => {}
  state.open = async () => 'launch rejected'
  assert.equal((await manager.install()).ok, false)
  assert.deepEqual(state.calls, ['save', 'save', 'open'])
  state.open = async () => ''
  assert.equal((await manager.install()).ok, true)
  assert.deepEqual(state.calls.slice(-3), ['save', 'open', 'quit'])
})

test('installation owns the lock during persistence and prevents duplicate installer launches', async (t) => {
  const { manager, state } = await fixture(t)
  await manager.check()
  await manager.download()
  let release!: () => void
  state.prepare = () =>
    new Promise((resolve) => {
      release = resolve
    })
  const installing = manager.install()
  await until(() => !!release)
  assert.equal((await manager.install()).ok, false)
  assert.equal((await manager.download()).ok, false)
  assert.equal((await manager.check()).error, 'busy')
  await assert.rejects(manager.preferences({ channel: 'preview' }))
  release()
  await installing
  assert.equal(state.calls.filter((c) => c === 'open').length, 1)
})

test('a later start confirms the installed version and cleans obsolete installers', async (t) => {
  const { manager, state, restart } = await fixture(t)
  await manager.check()
  const result = await manager.download()
  assert.ok(result.ok)
  await manager.install()
  const incomplete = restart()
  await incomplete.initialize()
  assert.equal(incomplete.snapshot().pendingInstallVersion, '2.0.0')
  const completed = restart('2.0.0')
  await completed.initialize()
  assert.equal(completed.snapshot().completedVersion, '2.0.0')
  assert.equal(completed.snapshot().readyVersion, null)
  assert.equal(completed.snapshot().notice?.kind, 'installed')
  await assert.rejects(stat(result.installerPath), { code: 'ENOENT' })
  assert.deepEqual(state.calls, ['save', 'open', 'quit'])
})

test('automatic checks honor interval, opt-out, skip and later; manual checks restore reminders', async (t) => {
  const { manager, state, restart } = await fixture(t)
  await manager.automaticCheck()
  assert.equal(manager.snapshot().notice?.version, '2.0.0')
  await manager.dismiss('skip')
  state.now += 25 * 3600_000
  await manager.automaticCheck()
  assert.equal(manager.snapshot().notice, null)
  await manager.check()
  assert.equal(manager.snapshot().preferences.skippedVersion, '')
  await manager.dismiss('later')
  await manager.preferences({ checkIntervalHours: 6 })
  state.now += 7 * 3600_000
  await manager.automaticCheck()
  assert.equal(manager.snapshot().notice, null)
  state.now += 25 * 3600_000
  await manager.automaticCheck()
  assert.equal(manager.snapshot().notice?.kind, 'available')
  await manager.preferences({ autoCheck: false })
  const savedAt = manager.snapshot().checkedAt
  state.now += 25 * 3600_000
  await manager.automaticCheck()
  assert.equal(manager.snapshot().checkedAt, savedAt)
  const restored = restart()
  await restored.initialize()
  assert.equal(restored.snapshot().preferences.autoCheck, false)
})

test('failed checks retain the ready installer and channel changes clear old candidates', async (t) => {
  const { manager, state } = await fixture(t)
  await manager.check()
  await manager.download()
  state.apiError = 503
  assert.equal((await manager.check()).error, 'http')
  assert.equal(manager.snapshot().readyVersion, '2.0.0')
  assert.equal((await manager.install()).ok, true)
})
