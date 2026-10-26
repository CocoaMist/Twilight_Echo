import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { compileScript, parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import { createRenderer, h, nextTick, shallowRef, type Component } from 'vue'
import * as workspaceModel from './genreWorkspaceView.ts'
import type { MusicGenreNode } from '../../../../shared/musicGenres.ts'

const jazz: MusicGenreNode = {
  id: 'jazz',
  name: '爵士',
  nameEn: 'Jazz',
  parentId: null,
  ancestorIds: [],
  dictionaryVersion: 1,
  userModified: false,
  childCount: 1
}
const raw = {
  provider: 'platform.fixture',
  value: 'Jazz / Fusion',
  normalized: 'jazz / fusion',
  ignored: false,
  targetCount: 2
}
function fixture(t: test.TestContext) {
  const queries: Array<{ name: string; payload: any }> = [],
    writes: Array<{ name: string; payload: any }> = []
  const state = shallowRef({ epoch: 'one', genresRevision: 5 })
  let revision = 5,
    conflict = false,
    changes = 0
  const core = {
    state,
    query: async (name: string, payload: any) => {
      queries.push({ name, payload })
      if (name === 'genres.tree')
        return {
          revision,
          dictionaryVersion: 1,
          offset: payload.offset,
          total: 1,
          items:
            payload.parentId === 'jazz'
              ? [
                  {
                    ...jazz,
                    id: 'fusion',
                    name: '融合爵士',
                    nameEn: 'Jazz fusion',
                    parentId: 'jazz',
                    ancestorIds: ['jazz'],
                    childCount: 0
                  }
                ]
              : [jazz]
        }
      assert.equal(name, 'genres.unmapped')
      return { revision, offset: payload.offset, total: 21, items: [raw] }
    },
    command: async (name: string, payload: any) => {
      writes.push({ name, payload })
      if (conflict) throw new Error('REVISION_CONFLICT')
      return { revision: ++revision }
    }
  }
  const Panel = component('./GenreWorkspacePanel.vue', {
    './genreWorkspaceView.ts': workspaceModel,
    '../../stores/coreConnection.ts': { useCoreConnection: () => core }
  })
  const ui = mount(t, () =>
    h(Panel, {
      onChanged: () => {
        changes++
      }
    })
  )
  return {
    ...ui,
    queries,
    writes,
    state,
    changes: () => changes,
    conflict: (value: boolean) => {
      conflict = value
    }
  }
}

test('compiled genre controls open lazily, require an explicit mapping target, and retain structured raw words', async (t) => {
  const f = fixture(t)
  await settle()
  assert.equal(f.queries.length, 0)
  f.button('整理流派与未映射原词').props.onClick()
  await settle()
  assert.deepEqual(
    f.queries.map((query) => query.name),
    ['genres.tree', 'genres.unmapped']
  )
  assert.equal(f.writes.length, 0)
  const rawButton = f.nodes().find((n) => n.tag === 'button' && text(n).includes('Jazz / Fusion'))!
  rawButton.props.onClick()
  await settle()
  assert.equal(f.button('确认映射').props.disabled, true)
  f.button('用作映射目标').props.onClick()
  await settle()
  assert.equal(f.button('确认映射').props.disabled, false)
  f.button('确认映射').props.onClick()
  await settle()
  assert.deepEqual(f.writes, [
    {
      name: 'genres.map',
      payload: {
        revision: 5,
        provider: 'platform.fixture',
        value: 'Jazz / Fusion',
        genreId: 'jazz'
      }
    }
  ])
  assert.equal(f.changes(), 1)
})

test('compiled rename controls retain typed values across conflicts and only retry after an explicit refresh', async (t) => {
  const f = fixture(t)
  f.button('整理流派与未映射原词').props.onClick()
  await settle()
  f.button('爵士Jazz').props.onClick()
  await settle()
  const name = f.nodes().find((n) => n.tag === 'input' && n.props.value === '爵士')!
  name.props.onInput({ target: { value: '我的爵士' } })
  await settle()
  f.conflict(true)
  const form = f.nodes().find((n) => n.tag === 'form' && n.props['aria-label'] === '编辑流派')!
  form.props.onSubmit({ preventDefault() {} })
  await settle()
  assert.equal(f.button('保存流派').props.disabled, true)
  assert.match(f.text(), /REVISION_CONFLICT/)
  assert.equal(
    f.nodes().find((n) => n.tag === 'input' && n.props.value === '我的爵士')?.props.value,
    '我的爵士'
  )
  f.conflict(false)
  f.button('重新读取分类').props.onClick()
  await settle()
  assert.equal(f.button('保存流派').props.disabled, false)
  form.props.onSubmit({ preventDefault() {} })
  await settle()
  assert.equal(f.writes.length, 2)
  assert.equal(f.writes[1].name, 'genres.edit')
  assert.deepEqual(f.writes[1].payload, {
    action: 'update',
    revision: 5,
    genreId: 'jazz',
    name: '我的爵士',
    nameEn: 'Jazz',
    parentId: null
  })
})

test('compiled parent picker disables self and descendant choices while keeping navigation usable', async (t) => {
  const f = fixture(t)
  f.button('整理流派与未映射原词').props.onClick()
  await settle()
  f.button('爵士Jazz').props.onClick()
  await settle()
  f.button('选择上级').props.onClick()
  await settle()
  assert.equal(f.button('用作上级').props.disabled, true)
  f.button('下一级（1）').props.onClick()
  await settle()
  assert.equal(f.queries.at(-1)?.payload.parentId, 'jazz')
  assert.equal(f.button('用作上级').props.disabled, true)
  assert.equal(f.writes.length, 0)
})

test('compiled workspace retains edits and blocks stale writes when another window changes classification', async (t) => {
  const f = fixture(t)
  f.button('整理流派与未映射原词').props.onClick()
  await settle()
  f.button('爵士Jazz').props.onClick()
  await settle()
  const name = f.nodes().find((n) => n.tag === 'input' && n.props.value === '爵士')!
  name.props.onInput({ target: { value: '保留此名称' } })
  f.state.value = { ...f.state.value, genresRevision: 6 }
  await settle()
  assert.match(f.text(), /分类已在其他位置更新/)
  assert.equal(f.button('保存流派').props.disabled, true)
  assert.equal(
    f.nodes().some((n) => n.tag === 'input' && n.props.value === '保留此名称'),
    true
  )
  assert.equal(f.writes.length, 0)
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
