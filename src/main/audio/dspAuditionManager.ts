import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { normalizeLocalPath } from '../security/ipcValidation.ts'
import {
  DspAuditionManager as Manager,
  type DspAuditionDependencies
} from '../../core/audio/dspAuditionManager.ts'
export * from '../../core/audio/dspAuditionManager.ts'
type Dependencies = Omit<DspAuditionDependencies, 'newId' | 'timers' | 'identify'> & {
  identify?: DspAuditionDependencies['identify']
}
export class DspAuditionManager extends Manager {
  constructor(dependencies: Dependencies) {
    super({
      ...dependencies,
      authorize: (source) => dependencies.authorize(normalizeLocalPath(source, '试听音源')),
      identify:
        dependencies.identify ??
        (async (source) => {
          const value = await stat(source)
          if (!value.isFile()) throw new Error('试听源不是本地文件')
          return JSON.stringify([source, value.size, value.mtimeMs])
        }),
      newId: randomUUID,
      timers: {
        setInterval: (callback, delay) => {
          const timer = setInterval(callback, delay)
          timer.unref()
          return timer
        },
        clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout)
      }
    })
  }
}
