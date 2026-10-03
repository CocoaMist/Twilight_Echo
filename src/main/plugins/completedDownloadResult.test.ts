import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCompletedDownloadResult } from './completedDownloadResult.ts'
import type { ProviderDownloadTaskSnapshot } from '../../shared/providerDownloads.ts'

test('completed files play without indexing; explicit import copies exclusively and reindexes without duplicating', async () => {
  const root = await mkdtemp(join(tmpdir(), 'twilight-download-result-'))
  try {
    const library = join(root, 'library'),
      download = join(root, 'download')
    await mkdir(library)
    await mkdir(download)
    const source = join(download, 'song.flac')
    await writeFile(source, 'downloaded audio')
    const task = {
      id: 'task-1',
      status: 'completed',
      targetPath: source
    } as ProviderDownloadTaskSnapshot
    let indexed = '',
      granted = ''
    const options = {
      libraryRoots: [await realpath(library)],
      downloadRoots: [await realpath(download)],
      addToLibrary: false,
      updatePath: (path: string) => {
        task.targetPath = path
      },
      grant: async (path: string) => {
        granted = path
        return path
      },
      enqueue: (path: string) => {
        indexed = path
      }
    }
    assert.equal(await resolveCompletedDownloadResult(task, options), await realpath(source))
    assert.equal(indexed, '')
    assert.equal(granted, await realpath(source))
    const copied = await resolveCompletedDownloadResult(task, { ...options, addToLibrary: true })
    assert.equal(indexed, copied)
    assert.equal(await readFile(source, 'utf8'), 'downloaded audio')
    assert.equal(await readFile(copied, 'utf8'), 'downloaded audio')
    assert.equal(
      await resolveCompletedDownloadResult(task, { ...options, addToLibrary: true }),
      copied
    )
    // A different task with the same planned destination must not overwrite any bytes.
    task.targetPath = source
    await assert.rejects(
      resolveCompletedDownloadResult(task, { ...options, addToLibrary: true }),
      /EEXIST/
    )
    assert.equal(await readFile(copied, 'utf8'), 'downloaded audio')
    await assert.rejects(
      resolveCompletedDownloadResult(task, { ...options, libraryRoots: [], downloadRoots: [] }),
      /目录已失效/
    )
    await assert.rejects(
      resolveCompletedDownloadResult({ ...task, status: 'downloading' }, options),
      /尚未完成/
    )
    await assert.rejects(
      resolveCompletedDownloadResult({ ...task, id: '../escape' }, options),
      /标识无效/
    )
    await assert.rejects(
      resolveCompletedDownloadResult(task, { ...options, addToLibrary: true, enqueue: undefined }),
      /尚未就绪/
    )
    await assert.rejects(
      resolveCompletedDownloadResult(task, { ...options, addToLibrary: true, libraryRoots: [] }),
      /添加音乐库/
    )
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'private.flac'), 'outside granted directories')
    const link = join(download, 'redirect')
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(
      resolveCompletedDownloadResult({ ...task, targetPath: join(link, 'private.flac') }, options),
      /目录已失效/
    )
    await rm(source)
    await assert.rejects(resolveCompletedDownloadResult(task, options))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
