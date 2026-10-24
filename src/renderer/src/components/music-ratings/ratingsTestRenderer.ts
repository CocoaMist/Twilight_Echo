/* eslint-disable no-restricted-imports -- Test-only compiled Vue runtime harness. */
import assert from 'node:assert/strict'
import type test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { compileScript, parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import { createRenderer, nextTick, type Component, type VNode } from 'vue'

/** Compiles the real Vue template and handlers; no desktop or layout acceptance. */
export function component(path: string, imports: Record<string, unknown>): Component {
  const { descriptor } = parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
  const compiled = compileScript(descriptor, {
    id: path,
    inlineTemplate: true,
    templateOptions: { compilerOptions: { hoistStatic: false } }
  })
  const code = ts.transpileModule(compiled.content, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
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
  readonly value: unknown
  readonly options: Element[]
  addEventListener(name: string, listener: unknown): void
  focus(): void
}
const element = (tag: string, text = ''): Element => ({
  tag,
  text,
  props: {},
  parent: null,
  children: [],
  style: {},
  get value() {
    return this.props.value
  },
  get options() {
    return this.children.filter((child) => child.tag === 'option')
  },
  addEventListener(name, listener) {
    this.props[`dom:${name}`] = listener
  },
  focus() {
    this.props.focused = true
  }
})
export function mount(t: test.TestContext, render: () => VNode) {
  function remove(node: Element) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
    node.parent = null
  }
  const renderer = createRenderer<Element, Element>({
    createElement: element,
    createText: (text) => element('#text', text),
    createComment: () => element('#comment'),
    setText: (node, text) => {
      node.text = text
    },
    setElementText: (node, text) => {
      node.text = text
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
  const app = renderer.createApp({ render }),
    root = element('root')
  app.mount(root)
  t.after(() => app.unmount())
  const text = (node: Element): string => node.text + node.children.map(text).join('')
  const nodes = (): Element[] => {
    const visit = (node: Element): Element[] => [node, ...node.children.flatMap(visit)]
    return visit(root)
  }
  return {
    nodes,
    text: () => text(root),
    button: (label: string) => {
      const found = nodes().find((node) => node.tag === 'button' && text(node).trim() === label)
      assert.ok(found, `Missing ${label}: ${text(root)}`)
      return found
    }
  }
}
export const settle = async () => {
  await nextTick()
  await new Promise<void>((r) => setImmediate(r))
  await nextTick()
}
