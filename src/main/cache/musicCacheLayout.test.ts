import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const { MANAGED_MUSIC_CACHE_DIRECTORY_NAMES, clearManagedMusicCache, getManagedMusicCacheSize } =
  (await import(
    new URL('./musicCacheLayout.ts', import.meta.url).href
  )) as typeof import('./musicCacheLayout')
import { clearCoreMusicCache } from './musicCacheLayout.ts'

test('Core clear retains native current/preload pins and leaves platform directories to their owners', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'te-core-cache-files-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const name of MANAGED_MUSIC_CACHE_DIRECTORY_NAMES) {
    await mkdir(join(root, name))
    for (const file of ['current', 'preload', 'unused'])
      await writeFile(join(root, name, file), file)
  }
  await writeFile(join(root, 'personal'), 'keep')
  const current = join(root, 'ncm-cache', 'current')
  const preload = join(root, 'network-cache', 'preload')
  await clearCoreMusicCache(
    root,
    [process.platform === 'win32' ? current.toUpperCase() : current, preload],
    new AbortController().signal
  )
  assert.equal(await readFile(current, 'utf8'), 'current')
  assert.equal(await readFile(preload, 'utf8'), 'preload')
  assert.equal(await readFile(join(root, 'cover-cache', 'unused'), 'utf8'), 'unused')
  assert.equal(await readFile(join(root, 'renderer-cache', 'unused'), 'utf8'), 'unused')
  await assert.rejects(readFile(join(root, 'ncm-cache', 'unused')), { code: 'ENOENT' })
  assert.equal(await readFile(join(root, 'personal'), 'utf8'), 'keep')
})

test('Core selective clear removes managed directory symlinks without traversing their target', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'te-core-cache-symlink-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cache = join(root, 'cache'),
    outside = join(root, 'outside')
  await mkdir(cache)
  await mkdir(outside)
  await writeFile(join(outside, 'keep'), 'outside')
  await symlink(
    outside,
    join(cache, 'ncm-cache'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  await clearCoreMusicCache(cache, [], new AbortController().signal)
  assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'outside')
  await assert.rejects(readFile(join(cache, 'ncm-cache', 'keep')), { code: 'ENOENT' })
})

test('managed cache clearing preserves the selected root and unrelated user files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'twilight-cache-layout-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const unrelatedFile = join(root, 'keep-me.txt')
  await writeFile(unrelatedFile, 'user-owned')
  for (const name of MANAGED_MUSIC_CACHE_DIRECTORY_NAMES) {
    const directory = join(root, name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, `${name}.bin`), name)
  }

  assert.ok((await getManagedMusicCacheSize(root)) > 0)
  await clearManagedMusicCache(root)

  assert.equal(await readFile(unrelatedFile, 'utf8'), 'user-owned')
  assert.equal(await getManagedMusicCacheSize(root), 0)
  for (const name of MANAGED_MUSIC_CACHE_DIRECTORY_NAMES) {
    await writeFile(join(root, name, 'recreated.bin'), 'ok')
  }
})

test('managed cache clearing does not follow a symlinked cache directory', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'twilight-cache-symlink-'))
  t.after(async () => {
    await rm(parent, { recursive: true, force: true })
  })
  const root = join(parent, 'cache-root')
  const outside = join(parent, 'outside')
  await mkdir(root)
  await mkdir(outside)
  const sentinel = join(outside, 'keep-me.bin')
  await writeFile(sentinel, 'outside')
  try {
    await symlink(
      outside,
      join(root, 'ncm-cache'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES') {
      t.skip(`symlink creation is unavailable: ${code}`)
      return
    }
    throw error
  }

  await clearManagedMusicCache(root)

  assert.equal(await readFile(sentinel, 'utf8'), 'outside')
  await writeFile(join(root, 'ncm-cache', 'recreated.bin'), 'ok')
})
