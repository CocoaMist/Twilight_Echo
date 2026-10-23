import { createRequire } from 'node:module'
import {
  RadioMediaService as PortableRadioMediaService,
  type RadioMediaServiceOptions as PortableOptions
} from '../../core/streams/radioMediaService.ts'
const require = createRequire(import.meta.url)
export type RadioMediaServiceOptions = Omit<PortableOptions, 'userDataPath'> & {
  userDataPath?: string
}
export type { ImportedRadioEntry } from '../../core/streams/radioMediaService.ts'
/** Legacy main owner supplies Electron's path until production switches to Core. */
export class RadioMediaService extends PortableRadioMediaService {
  constructor(options: RadioMediaServiceOptions = {}) {
    const userDataPath =
      options.userDataPath ??
      (require('electron') as typeof import('electron')).app.getPath('userData')
    super({ ...options, userDataPath })
  }
}
