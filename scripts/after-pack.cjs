// Unified after-pack dispatcher.
//
// electron-builder's `afterPack` accepts a single script path (not an array),
// so this dispatcher routes to the platform-specific hooks below. Each hook
// is responsible for its own platform guard.
const { join } = require('node:path')
const { existsSync } = require('node:fs')
const { validate: validateAutoMixAssets } = require('./stage-automix-native-assets.cjs')

exports.default = async function afterPack(context) {
  const { electronPlatformName } = context
  const resourcesDir =
    electronPlatformName === 'darwin'
      ? join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          'Contents',
          'Resources'
        )
      : join(context.appOutDir, 'resources')
  const autoMixAssets = join(resourcesDir, 'audio-engine', 'automix-native')
  if (existsSync(autoMixAssets)) validateAutoMixAssets(autoMixAssets)
  if (electronPlatformName === 'win32') {
    return require(join(__dirname, 'after-pack-windows.cjs')).default(context)
  }
  if (electronPlatformName === 'linux') {
    return require(join(__dirname, 'after-pack-linux.cjs')).default(context)
  }
  // mac / darwin: no custom after-pack steps yet.
}
