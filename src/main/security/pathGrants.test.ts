import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const { CanonicalPathGrantSet } = (await import(
  new URL('./pathGrants.ts', import.meta.url).href
)) as typeof import('./pathGrants')

test('canonical grants authorize descendants but reject unrelated files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'twilight-path-grants-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  const library = join(root, 'library')
  const outside = join(root, 'outside')
  await mkdir(library)
  await mkdir(outside)
  const track = join(library, 'track.flac')
  const secret = join(outside, 'secret.flac')
  await writeFile(track, 'track')
  await writeFile(secret, 'secret')

  const grants = new CanonicalPathGrantSet()
  await grants.grantRoot(library)

  assert.equal(await grants.resolveWithinRoots(track, 'file'), await realpath(track))
  assert.equal(await grants.resolveWithinRoots(secret, 'file'), null)
})

test('canonical grants reject a symlink escape from an authorized root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'twilight-path-symlink-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  const library = join(root, 'library')
  const outside = join(root, 'outside')
  const link = join(library, 'escape')
  await mkdir(library)
  await mkdir(outside)
  await writeFile(join(outside, 'secret.flac'), 'secret')
  try {
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES') {
      t.skip(`symlink creation is unavailable: ${code}`)
      return
    }
    throw error
  }

  const grants = new CanonicalPathGrantSet()
  await grants.grantRoot(library)

  assert.equal(await grants.resolveWithinRoots(join(link, 'secret.flac'), 'file'), null)
})
