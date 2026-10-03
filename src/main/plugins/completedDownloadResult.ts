import { constants } from 'node:fs'
import { copyFile, rm } from 'node:fs/promises'
import { basename, extname, join, parse } from 'node:path'
import { isCanonicalPathInside, resolveCanonicalExistingPath } from '../security/pathGrants.ts'
import { flushFileToDisk } from './downloadTargets.ts'
import type { ProviderDownloadTaskSnapshot } from '../../shared/providerDownloads.ts'

interface ResultOptions {
  libraryRoots: string[]
  downloadRoots: string[]
  addToLibrary: boolean
  enqueue?: (path: string) => void
  updatePath: (path: string) => void
  grant: (path: string) => Promise<string>
}
export async function resolveCompletedDownloadResult(
  task: ProviderDownloadTaskSnapshot,
  options: ResultOptions
): Promise<string> {
  if (task.status !== 'completed' || !task.targetPath) throw new Error('下载尚未完成')
  if (!/^[a-zA-Z0-9-]+$/.test(task.id)) throw new Error('下载任务标识无效')
  const source = await resolveCanonicalExistingPath(task.targetPath, 'file')
  if (
    ![...options.libraryRoots, ...options.downloadRoots].some((root) =>
      isCanonicalPathInside(root, source)
    )
  )
    throw new Error('下载目录已失效，请重新选择目录')
  let target = source
  if (options.addToLibrary) {
    if (!options.enqueue) throw new Error('曲库索引服务尚未就绪，请稍后重试')
    if (!options.libraryRoots.length) throw new Error('请先在设置中添加音乐库目录')
    if (!options.libraryRoots.some((root) => isCanonicalPathInside(root, source))) {
      target = join(
        options.libraryRoots[0],
        `${parse(basename(source)).name}-${task.id}${extname(source)}`
      )
      await copyFile(source, target, constants.COPYFILE_EXCL)
      try {
        await flushFileToDisk(target)
      } catch (error) {
        await rm(target, { force: true })
        throw error
      }
      options.updatePath(target)
    }
    options.enqueue(target)
  }
  return options.grant(target)
}
