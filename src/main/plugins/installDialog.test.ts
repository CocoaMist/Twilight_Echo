import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  assertLocalPluginInstallSourceAllowed,
  buildLocalPluginInstallDialogOptions,
  normalizeLocalPluginInstallSourceKind
} from './installDialog.ts'

const managerSource = readFileSync(new URL('./platform.ts', import.meta.url), 'utf8')
const pluginIpcSource = readFileSync(new URL('../ipc/plugins.ts', import.meta.url), 'utf8')
const mainSettingsSource = readFileSync(new URL('../core/settings.ts', import.meta.url), 'utf8')
const normalizationSource = readFileSync(
  new URL('../../core/settings/normalization.ts', import.meta.url),
  'utf8'
)
const pluginPageSource = readFileSync(
  new URL('../../renderer/src/components/PluginPage.vue', import.meta.url),
  'utf8'
)

test('本地安装包对话框是 .tep 文件选择器而不是目录选择器', () => {
  for (const options of [
    buildLocalPluginInstallDialogOptions(),
    buildLocalPluginInstallDialogOptions('package')
  ]) {
    assert.equal(options.title, '安装 Twilight Echo 插件')
    assert.deepEqual(options.properties, ['openFile'])
    assert.ok(!options.properties?.includes('openDirectory'))
    assert.deepEqual(options.filters, [
      { name: 'Twilight Echo Plugin', extensions: ['tep'] },
      { name: 'All Files', extensions: ['*'] }
    ])
  }
})

test('开发者模式的目录安装用独立的纯目录选择器', () => {
  const options = buildLocalPluginInstallDialogOptions('directory')
  assert.deepEqual(options.properties, ['openDirectory'])
  assert.ok(!options.properties?.includes('openFile'))
  assert.equal(options.filters, undefined)
  assert.notEqual(options.title, buildLocalPluginInstallDialogOptions('package').title)
})

test('来源类型只认显式的 directory，其余一律按 .tep 包处理', () => {
  assert.equal(normalizeLocalPluginInstallSourceKind('directory'), 'directory')
  for (const value of [undefined, null, '', 'package', 'Directory', 'openDirectory', 0, {}, []]) {
    assert.equal(normalizeLocalPluginInstallSourceKind(value), 'package')
  }
})

test('未开启开发者模式时目录安装被拒绝，.tep 安装不受影响', () => {
  assert.throws(() => assertLocalPluginInstallSourceAllowed('directory', false), /开发者模式/)
  assert.doesNotThrow(() => assertLocalPluginInstallSourceAllowed('directory', true))
  assert.doesNotThrow(() => assertLocalPluginInstallSourceAllowed('package', false))
})

test('插件管理器按来源类型取对话框，不再硬编码同时选文件与目录', () => {
  assert.match(
    managerSource,
    /dialog\.showOpenDialog\(buildLocalPluginInstallDialogOptions\(kind\)\)/
  )
  assert.doesNotMatch(managerSource, /'openFile',\s*'openDirectory'/)
})

test('chooseAndInstall 的 IPC 入口校验来源并在主进程侧检查开发者模式', () => {
  const handler = pluginIpcSource.slice(
    pluginIpcSource.indexOf("ipcMain.handle('plugins:chooseAndInstall'"),
    pluginIpcSource.indexOf("ipcMain.handle('plugins:enable'")
  )
  assert.ok(handler.length > 0)
  assert.match(handler, /normalizeLocalPluginInstallSourceKind\(kind\)/)
  assert.match(
    handler,
    /assertLocalPluginInstallSourceAllowed\(\s*sourceKind,\s*runtime\.appSettings\.developerMode === true\s*\)/
  )
})

test('开发者模式默认关闭并按布尔归一化', () => {
  assert.match(mainSettingsSource, /normalizePortableSettings/)
  assert.match(normalizationSource, /developerMode: false/)
  assert.match(normalizationSource, /developerMode: settings\.developerMode === true/)
})

test('插件页的目录安装入口跟随持久化的开发者模式设置', () => {
  assert.match(pluginPageSource, /settings\.value\.developerMode === true/)
  assert.doesNotMatch(pluginPageSource, /const devMode = ref\(/)
  assert.match(pluginPageSource, /updateSettings\(\{ developerMode: !devMode\.value \}\)/)
  assert.match(
    pluginPageSource,
    /v-if="activeTab === 'installed' && devMode"[\s\S]{0,240}installFromLocal\('directory'\)/
  )
  assert.match(pluginPageSource, /installFromLocal\('package'\)/)
})
