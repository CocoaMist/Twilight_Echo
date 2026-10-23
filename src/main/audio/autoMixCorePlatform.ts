import { app, dialog } from 'electron'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { managedStemPackDirectories } from './autoMixStemInstaller.ts'
import { createAutoMixProcessPlatform } from './autoMixProcessPlatform.ts'
import { createAutoMixModelPackPlatform } from './autoMixModelPackPlatform.ts'
import { translate } from '../../shared/i18n/translate.ts'
import { mainLocale } from '../core/locale.ts'
import { runtime } from '../core/runtime.ts'

export function createAutoMixCorePlatform(root: string) {
  const workerDirectory = join(
    app.isPackaged || app.getAppPath().endsWith('.asar')
      ? process.resourcesPath
      : join(app.getAppPath(), 'resources'),
    'automix-stems'
  )
  const processPlatform = createAutoMixProcessPlatform({
    candidates: () => [
      ...managedStemPackDirectories(join(root, 'automix-stem-packs')),
      ...(process.env.TWILIGHT_AUTOMIX_STEM_PACK ? [process.env.TWILIGHT_AUTOMIX_STEM_PACK] : []),
      ...[
        join(app.getPath('exe'), '..'),
        join(process.resourcesPath, '..'),
        app.getAppPath()
      ].flatMap((directory) =>
        ['automix-enhancement', 'automix-enhancement-gpu', 'automix-enhancement-cpu'].map((name) =>
          join(directory, name)
        )
      )
    ],
    workerDirectory,
    temporaryDirectory: tmpdir()
  })
  const models = createAutoMixModelPackPlatform({
    root: join(root, 'automix-stem-packs'),
    workerDirectory,
    chooseArchive: async () => {
      const options: Electron.OpenDialogOptions = {
        title: translate(mainLocale(), 'automix.stems.install.pick'),
        properties: ['openFile'],
        filters: [{ name: 'AutoMix ZIP', extensions: ['zip'] }]
      }
      const parent = runtime.mainWindow
      const result =
        parent && !parent.isDestroyed()
          ? await dialog.showOpenDialog(parent, options)
          : await dialog.showOpenDialog(options)
      return result.canceled ? null : (result.filePaths[0] ?? null)
    }
  })
  return {
    operations: { ...processPlatform.operations, ...models.operations },
    idle: async () => {
      await Promise.all([processPlatform.idle(), models.idle()])
    }
  }
}
