import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { compileScript, parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import { createRenderer, h, nextTick, shallowRef, type Component } from 'vue'
import * as browseModel from './genreBrowseView.ts'
import * as dimensions from '../../../../shared/musicClassificationDimensions.ts'
import type { GenreBrowseToken } from '../../../../shared/musicGenreBrowse.ts'

const genre = {
  id: 'jazz',
  name: '爵士',
  nameEn: 'Jazz',
  parentId: null,
  ancestorIds: [],
  dictionaryVersion: 1,
  userModified: false,
  childCount: 1
}
const genreSummary = {
  items: [{ id: 'jazz', name: '爵士', nameEn: 'Jazz' }],
  total: 1,
  truncated: false
}
const entity = {
  id: 'release-one',
  kind: 'release',
  title: '测试专辑',
  artist: '测试艺人',
  identity: 'manual',
  sourceCount: 2,
  genres: genreSummary,
  classification: 'from-tracks'
}
const source = {
  sourceId: 'source-one',
  provider: 'local',
  title: '歌曲 A',
  artist: '测试艺人',
  availability: 'indexed',
  sourceTarget: { kind: 'source', id: 'source-one' },
  collectionTarget: { kind: 'collection', id: 'precise-collection' },
  sourceClassification: { genres: genreSummary, origin: 'source' },
  collectionClassification: { genres: { items: [], total: 0, truncated: false }, origin: 'none' }
}
function fixture(t: test.TestContext) {
  const queries: Array<{ name: string; payload: any }> = [],
    writes: Array<{ name: string; payload: any }> = []
  const state = shallowRef({
    epoch: 'one',
    genresRevision: 3,
    catalogRevision: 5,
    libraryRevision: 7,
    entityMetadataRevision: 1,
    classificationMetadataRevision: 2,
    pluginsRevision: 1,
    settingsRevision: 1
  })
  let token: GenreBrowseToken = {
      genresRevision: 3,
      catalogRevision: 5,
      contentRevision: 7,
      metadataRevision: 2,
      asOf: 100,
      expiresAt: null,
      contextKey: 'one'
    },
    conflict = false
  const core = {
    state,
    query: async (name: string, payload: any) => {
      queries.push({ name, payload })
      if (conflict) throw new Error('SNAPSHOT_EXPIRED')
      if (name === 'genres.tree')
        return {
          revision: token.genresRevision,
          dictionaryVersion: 1,
          offset: payload.offset,
          total: 21,
          items: [
            {
              ...genre,
              ...(payload.parentId
                ? {
                    id: 'bebop',
                    name: '比波普',
                    nameEn: 'Bebop',
                    parentId: 'jazz',
                    ancestorIds: ['jazz'],
                    childCount: 0
                  }
                : {})
            }
          ]
        }
      if (name === 'genres.browse')
        return {
          token,
          offset: payload.offset,
          total: 21,
          items: [entity],
          providers: ['local', 'fixture']
        }
      if (name === 'genres.members')
        return {
          token,
          offset: payload.offset,
          total: 21,
          entity,
          items: [
            source,
            {
              ...source,
              sourceId: 'source-two',
              provider: 'fixture',
              title: '歌曲 B',
              sourceTarget: { kind: 'source', id: 'source-two' }
            }
          ]
        }
      if (name === 'genres.facets')
        return {
          token,
          dimension: payload.dimension,
          available: true,
          reason: null,
          offset: payload.offset,
          total: 21,
          items: [
            {
              value: payload.offset ? '32' : '24',
              label: payload.offset ? '32-bit' : '24-bit',
              count: 1
            }
          ]
        }
      assert.equal(name, 'genres.evidence')
      return {
        revision: token.genresRevision,
        offset: payload.offset,
        total: 21,
        selection: {
          target: payload.target,
          revision: token.genresRevision,
          genreIds: ['jazz'],
          override: null,
          origin: 'source'
        },
        items: [
          {
            key: 'local-tags',
            provider: 'local',
            provenance: '文件原始标签',
            values: [{ value: 'Jazz', normalized: 'jazz', genreId: 'jazz', ignored: false }]
          }
        ]
      }
    },
    command: async (name: string, payload: any) => {
      writes.push({ name, payload })
      if (conflict) throw new Error('REVISION_CONFLICT')
      if (name === 'catalog.play') return {}
      if (name === 'catalog.playUnified') return { status: 'played', requestedSourceId: payload.sourceId,
        sourceId: 'source-two', versionId: 'equivalent', attempts: [
          { sourceId: 'source-two', provider: 'fixture', status: 'selected', code: null, message: null }
        ] }
      assert.equal(name, 'genres.override')
      token = { ...token, genresRevision: token.genresRevision + 1 }
      return {
        target: payload.target,
        revision: token.genresRevision,
        genreIds: payload.genreIds ?? ['jazz'],
        override: payload.genreIds,
        origin: payload.genreIds === null ? 'source' : 'manual'
      }
    }
  }
  const Panel = component('./GenreBrowsePanel.vue', {
    './genreBrowseView.ts': browseModel,
    '../../../../shared/musicClassificationDimensions.ts': dimensions,
    '../../stores/coreConnection.ts': { useCoreConnection: () => core }
  })
  return {
    ...mount(t, () => h(Panel)),
    queries,
    writes,
    state,
    conflict: (value: boolean) => {
      conflict = value
    }
  }
}

test('compiled classification browser keeps string navigation out of ID filters and never autoplays the first source', async (t) => {
  const f = fixture(t)
  await settle()
  assert.deepEqual(
    f.queries.map((query) => query.name),
    ['genres.browse', 'genres.tree']
  )
  assert.equal(f.writes.length, 0)
  f.button('爵士Jazz').props.onClick()
  await settle()
  assert.equal(
    f.queries.findLast((query) => query.name === 'genres.browse')?.payload.genreId,
    'jazz'
  )
  f.button('专辑').props.onClick()
  await settle()
  assert.match(f.text(), /来自曲目/)
  f.button('测试专辑测试艺人').props.onClick()
  await settle()
  assert.equal(f.writes.length, 0)
  const plays = f.nodes().filter((node) => node.tag === 'button' && text(node) === '播放此来源')
  assert.equal(plays.length, 2)
  plays[1].props.onClick()
  await settle()
  assert.deepEqual(f.writes, [
    { name: 'catalog.play', payload: { sourceId: 'source-two', revision: 5 } }
  ])
  f.button('下一页来源').props.onClick()
  await settle()
  assert.equal(f.queries.findLast((query) => query.name === 'genres.members')?.payload.offset, 20)
})

test('compiled unified playback button sends frozen classification scope without changing the explicit-source entry', async t => {
  const f = fixture(t)
  await settle()
  f.button('爵士Jazz').props.onClick()
  await settle()
  f.button('测试专辑测试艺人').props.onClick()
  await settle()
  const unified = f.nodes().filter(node => node.tag === 'button' && text(node).trim() === '按偏好选源播放')
  assert.equal(unified.length, 2)
  unified[0].props.onClick()
  await settle()
  assert.equal(f.writes[0].name, 'catalog.playUnified')
  assert.equal(f.writes[0].payload.sourceId, 'source-one')
  assert.equal(f.writes[0].payload.scope.entityId, entity.id)
  assert.equal(f.writes[0].payload.scope.genreId, 'jazz')
  assert.equal(f.writes[0].payload.scope.token.contextKey, 'one')
  assert.match(f.text(), /已按偏好选择等价来源/)
  assert.equal(f.writes.some(item => item.name === 'catalog.play'), false)
})

test('compiled source/collection editing uses exact targets, explicit empty/reset, and source provenance', async (t) => {
  const f = fixture(t)
  await settle()
  f.button('测试专辑测试艺人').props.onClick()
  await settle()
  f.nodes()
    .find((node) => node.tag === 'button' && text(node).trim() === '专辑分类出处')!
    .props.onClick()
  await settle()
  assert.match(f.text(), /文件原始标签/)
  f.button('明确清空流派').props.onClick()
  await settle()
  assert.deepEqual(f.writes[0], {
    name: 'genres.override',
    payload: { target: { kind: 'collection', id: 'precise-collection' }, revision: 3, genreIds: [] }
  })
  f.button('恢复自动分类').props.onClick()
  await settle()
  assert.equal(f.writes[1].payload.genreIds, null)
  assert.equal(f.writes[1].payload.target.id, 'precise-collection')
})

test('compiled dimension controls retain cross-page selections and apply all values together', async (t) => {
  const f = fixture(t)
  await settle()
  const selector = f
    .nodes()
    .find(
      (node) =>
        node.tag === 'select' && node.children.some((child) => text(child) === '选择分类维度')
    )!
  selector.props.onChange({ target: { value: 'bitDepth' } })
  await settle()
  f.nodes()
    .find(
      (node) =>
        node.tag === 'input' &&
        node.props.type === 'checkbox' &&
        node.parent &&
        text(node.parent).includes('24-bit')
    )!
    .props.onChange()
  await settle()
  f.button('下一页选项').props.onClick()
  await settle()
  f.nodes()
    .find(
      (node) =>
        node.tag === 'input' &&
        node.props.type === 'checkbox' &&
        node.parent &&
        text(node.parent).includes('32-bit')
    )!
    .props.onChange()
  await settle()
  f.button('应用所选条件').props.onClick()
  await settle()
  assert.deepEqual(f.queries.findLast((query) => query.name === 'genres.browse')?.payload.filters, [
    { dimension: 'bitDepth', values: ['24', '32'] }
  ])
})

test('compiled browser keeps current selection when a snapshot becomes stale and only rereads on request', async (t) => {
  const f = fixture(t)
  await settle()
  f.button('爵士Jazz').props.onClick()
  await settle()
  f.conflict(true)
  f.button('下一页音乐').props.onClick()
  await settle()
  assert.match(f.text(), /SNAPSHOT_EXPIRED/)
  assert.match(f.text(), /当前选择已保留/)
  assert.equal(
    f.nodes().some((node) => node.tag === 'button' && text(node).trim() === '下一页音乐'),
    false
  )
  const reads = f.queries.length
  await settle()
  assert.equal(f.queries.length, reads)
  f.conflict(false)
  f.button('重新读取结果').props.onClick()
  await settle()
  assert.equal(f.button('下一页音乐').props.disabled, false)
  assert.equal(
    f.queries.findLast((query) => query.name === 'genres.browse')?.payload.genreId,
    'jazz'
  )
  const refreshedReads = f.queries.length
  f.state.value = { ...f.state.value, classificationMetadataRevision: 3 }
  await settle()
  assert.equal(f.queries.length, refreshedReads)
  assert.equal(f.text().includes('测试专辑'), false)
  assert.match(f.text(), /当前选择和人工集合已保留/)
})
test('compiled metadata/account context watchers hide stale facts without resetting selection or rereading', async (t) => {
  const f = fixture(t)
  await settle()
  f.button('爵士Jazz').props.onClick()
  await settle()
  const reads = f.queries.length
  f.state.value = { ...f.state.value, entityMetadataRevision: 2 }
  await settle()
  assert.equal(f.queries.length, reads)
  assert.equal(f.text().includes('测试专辑'), false)
  assert.match(f.text(), /当前选择和人工集合已保留/)
  f.button('重新读取结果').props.onClick()
  await settle()
  assert.equal(
    f.queries.findLast((query) => query.name === 'genres.browse')?.payload.genreId,
    'jazz'
  )
})

function component(path: string, imports: Record<string, unknown>): Component {
  const { descriptor } = parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
  const compiled = compileScript(descriptor, {
    id: path,
    inlineTemplate: true,
    templateOptions: { compilerOptions: { hoistStatic: false } }
  })
  const code = ts.transpileModule(compiled.content, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS
    }
  }).outputText
  const require = createRequire(import.meta.url),
    module = { exports: {} as { default: Component } }
  new Function('require', 'module', 'exports', code)(
    (name: string) => (Object.hasOwn(imports, name) ? imports[name] : require(name)),
    module,
    module.exports
  )
  return module.exports.default
}
interface Element {
  tag: string
  text: string
  props: Record<string, any>
  parent: Element | null
  children: Element[]
  style: Record<string, string>
  value: unknown
  addEventListener(name: string, listener: unknown): void
}
const element = (tag: string, value = ''): Element => ({
  tag,
  text: value,
  props: {},
  parent: null,
  children: [],
  style: {},
  get value() {
    return this.props.value
  },
  set value(value) {
    this.props.value = value
  },
  addEventListener(name, listener) {
    this.props[`dom:${name}`] = listener
  }
})
const text = (node: Element): string => node.text + node.children.map(text).join('')
function mount(t: test.TestContext, render: () => ReturnType<typeof h>) {
  function remove(node: Element) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
    node.parent = null
  }
  const renderer = createRenderer<Element, Element>({
    createElement: element,
    createText: (value) => element('#text', value),
    createComment: () => element('#comment'),
    setText: (node, value) => {
      node.text = value
    },
    setElementText: (node, value) => {
      node.text = value
      node.children = []
    },
    insert(node, parent, anchor) {
      remove(node)
      const index = anchor ? parent.children.indexOf(anchor) : -1
      parent.children.splice(index < 0 ? parent.children.length : index, 0, node)
      node.parent = parent
    },
    remove,
    parentNode: (node) => node.parent,
    nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    patchProp: (node, key, _previous, value) => {
      node.props[key] = value
    }
  })
  const root = element('root'),
    app = renderer.createApp({ render })
  app.mount(root)
  t.after(() => app.unmount())
  const nodes = (): Element[] => {
    const visit = (node: Element): Element[] => [node, ...node.children.flatMap(visit)]
    return visit(root)
  }
  const button = (label: string) => {
    const found = nodes().find((node) => node.tag === 'button' && text(node).trim() === label)
    assert.ok(found, `Missing ${label}: ${text(root)}`)
    return found
  }
  return { nodes, button, text: () => text(root) }
}
async function settle() {
  await nextTick()
  await new Promise<void>((resolve) => setImmediate(resolve))
  await nextTick()
}
