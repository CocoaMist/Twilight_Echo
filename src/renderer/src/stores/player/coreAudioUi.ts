import type { CorePlayerClient } from './corePlayerTypes.ts'
import type { CoreDspEdit, CoreDspImport, CoreVst3Edit } from '../../../../shared/coreDsp.ts'
import type { DspAsset, Vst3CatalogEntry, Vst3CatalogState } from '../../../../shared/dspGraph.ts'

type AudioUiMethod =
  | 'getDspSceneState' | 'getDspGraphStatus' | 'setDspScenes' | 'applyDspScene'
  | 'getDspAssets' | 'getDspCorrectionProfile' | 'importDspAsset'
  | 'importDspCorrectionProfile' | 'deleteDspAsset' | 'exportDspProfile'
  | 'importDspProfile' | 'importFrequencyResponse' | 'getVst3Catalog'
  | 'scanVst3Plugins' | 'clearVst3Quarantine' | 'setVst3Enabled'
  | 'selectVst3SearchPath' | 'setVst3SearchPaths'
type AudioUi = Pick<Window['api']['audioEngine'], AudioUiMethod>

/** UI drafts retain the revision they were read from; Core alone applies them. */
export function createCoreAudioUi(core: CorePlayerClient): AudioUi {
  let sceneRevision: number | null = null
  let catalogRevision: number | null = null
  async function scenes() {
    const state = await core.query('audio.dsp', {})
    sceneRevision = state.revision
    return state.scenes
  }
  async function revision() {
    if (sceneRevision === null) await scenes()
    return sceneRevision!
  }
  async function edit(edit: CoreDspEdit['edit']) {
    await core.command('audio.dsp.edit', { revision: await revision(), edit })
    return scenes()
  }
  async function assets(): Promise<DspAsset[]> {
    const first = await core.query('audio.dsp.assets', { offset: 0, limit: 200 })
    const items = first.items
    for (let offset = items.length; offset < first.total; offset = items.length) {
      const page = await core.query('audio.dsp.assets', { offset, limit: 200 })
      if (page.revision !== first.revision || !page.items.length)
        throw new Error('DSP 资源已变化，请刷新后重试')
      items.push(...page.items)
    }
    return items
  }
  async function catalog(): Promise<Vst3CatalogState> {
    const first = await core.query('audio.vst3', { offset: 0, limit: 200 })
    const items = first.items
    for (let offset = items.length; offset < first.total; offset = items.length) {
      const page = await core.query('audio.vst3', { offset, limit: 200 })
      if (page.revision !== first.revision || !page.items.length)
        throw new Error('VST3 列表已变化，请刷新后重试')
      items.push(...page.items)
    }
    const entries: Vst3CatalogEntry[] = []
    for (const item of items) {
      const parameters: Vst3CatalogEntry['parameters'] = []
      let total = 1
      while (parameters.length < total) {
        const page = await core.query('audio.vst3.parameters', {
          id: item.id, revision: first.revision, offset: parameters.length, limit: 200
        })
        total = page.total
        if (parameters.length < total && !page.items.length)
          throw new Error('VST3 参数分页中断')
        parameters.push(...page.items)
      }
      entries.push({ ...item, parameters })
    }
    catalogRevision = first.revision
    return { enabled: first.enabled, searchPaths: first.searchPaths, helpers: first.helpers, entries }
  }
  async function editCatalog(edit: CoreVst3Edit['edit']) {
    if (catalogRevision === null) await catalog()
    await core.command('audio.vst3.edit', { revision: catalogRevision!, edit })
    return catalog()
  }
  async function importAsset<T>(kind: CoreDspImport['kind']): Promise<T> {
    const result = await core.command('audio.dsp.import', { revision: await revision(), kind })
    await scenes()
    return result as T
  }
  return {
    getDspSceneState: scenes,
    getDspGraphStatus: () => core.query('audio.dsp.status', {}),
    setDspScenes: (scenes, pinnedSceneId) => edit({ kind: 'scenes', scenes, pinnedSceneId: pinnedSceneId ?? null }),
    applyDspScene: (id, confirmDsdPcmFallback) => edit({ kind: 'apply', id, confirmDsdPcmFallback }),
    getDspAssets: assets,
    getDspCorrectionProfile: id => core.query('audio.dsp.correction', { id }),
    importDspAsset: kind => importAsset(kind),
    importDspCorrectionProfile: () => importAsset('correctionProfile'),
    deleteDspAsset: async id => {
      await core.command('audio.dsp.assetRemove', { revision: await revision(), id })
      await scenes()
      return assets()
    },
    exportDspProfile: async name => await core.command('audio.dsp.export', {
      revision: await revision(), name: name || 'Rhine Music'
    }) as Awaited<ReturnType<AudioUi['exportDspProfile']>>,
    importDspProfile: () => importAsset('profile'),
    importFrequencyResponse: () => importAsset('frequencyResponse'),
    getVst3Catalog: catalog,
    scanVst3Plugins: () => editCatalog({ kind: 'scan' }),
    clearVst3Quarantine: id => editCatalog({ kind: 'clearQuarantine', id }),
    setVst3Enabled: enabled => editCatalog({ kind: 'enabled', enabled }),
    setVst3SearchPaths: paths => editCatalog({ kind: 'searchPaths', paths }),
    selectVst3SearchPath: () => core.command('audio.vst3.chooseDirectory', {}).then(value => value as string | null)
  }
}
