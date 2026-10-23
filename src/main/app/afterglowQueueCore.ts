// Compatibility names; the implementation is shared with the independent Core.
export {
  NativeQueueMaintainer as AfterglowQueueCore,
  nativeQueueItem as afterglowNativeQueueItem
} from '../../core/playback/nativeQueueMaintainer.ts'
export type {
  NativeQueueMaintainerEngine as AfterglowQueueCoreEngine,
  NativeQueueMaintainerOptions as AfterglowQueueCoreOptions
} from '../../core/playback/nativeQueueMaintainer.ts'
