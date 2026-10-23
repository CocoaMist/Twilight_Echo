import { OutputRouter as PortableOutputRouter } from '../../core/audio/outputRouter.ts'
import type { OutputRouterHost } from '../../core/audio/outputRouter.ts'
import type { AudioEngineConfig, AudioEngineManagerDependencies } from './audioEngineTypes.ts'
export type { OutputRouterHost } from '../../core/audio/outputRouter.ts'
export class OutputRouter extends PortableOutputRouter {
  constructor(
    host: OutputRouterHost,
    config: Pick<
      AudioEngineConfig,
      'audioOutput' | 'audioDevice' | 'exclusiveMode' | 'exclusiveAutoRelease' | 'audioOutputConfig'
    >,
    dependencies: Pick<
      AudioEngineManagerDependencies,
      'deviceOptionsProvider' | 'platform' | 'persistAudioOutput'
    >
  ) {
    super(host, config, { ...dependencies, platform: dependencies.platform ?? process.platform })
  }
}
