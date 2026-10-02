import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createWorkshopProject,
  compileWorkshopProject,
  exportWorkshopEditor,
  isWorkshopProject,
  workshopEditor
} from './themeWorkshop.ts'
import {
  replaceWorkshopAsset,
  setWorkshopControl,
  removeWorkshopControl,
  workshopAssetReferences
} from './themeWorkshopEditing.ts'
import { normalizeThemeEditor, type ThemeEditorControl } from './themeEditor.ts'

const control: ThemeEditorControl = {
  id: 'accent',
  label: 'Accent',
  group: 'Custom',
  type: 'color',
  variable: '--custom-accent',
  defaults: { pureWhite: '#123456', dark: '#abcdef' }
}

test('project declarations inherit, then export all six editable control types', () => {
  const initial = createWorkshopProject('00000000-0000-0000-0000-000000000000', 'Author')
  initial.base.editor = { schemaVersion: 1, controls: [control] }
  assert.equal(workshopEditor(initial), initial.base.editor)
  const original = JSON.stringify(initial.base)
  let next = setWorkshopControl(initial, { ...control, id: 'new-accent' })
  next = setWorkshopControl(next, {
    ...control,
    id: 'size',
    type: 'number',
    variable: '--size',
    min: 0,
    max: 100,
    unit: 'px',
    defaults: { pureWhite: '12px', dark: '24px' }
  })
  next = setWorkshopControl(next, {
    ...control,
    id: 'choice',
    type: 'select',
    variable: '--choice',
    options: ['normal', 'compact'],
    defaults: { pureWhite: 'normal', dark: 'compact' }
  })
  next = setWorkshopControl(next, {
    ...control,
    id: 'switch',
    type: 'boolean',
    variable: '--switch',
    defaults: { pureWhite: '1', dark: '0' }
  })
  next = setWorkshopControl(next, {
    ...control,
    id: 'image',
    type: 'image',
    variable: undefined,
    slot: 'navigation.home',
    defaults: { pureWhite: 'none', dark: 'none' }
  })
  next = setWorkshopControl(next, {
    ...control,
    id: 'text',
    type: 'text',
    variable: '--text',
    defaults: { pureWhite: 'normal', dark: 'normal' }
  })
  assert.equal(JSON.stringify(initial.base), original)
  assert.equal(next.editor!.controls.length, 7)
  assert.ok(isWorkshopProject(JSON.parse(JSON.stringify(next))))
  const exported = exportWorkshopEditor(next)!
  assert.equal(normalizeThemeEditor(exported)?.controls.length, 7)
  const imported = createWorkshopProject('11111111-1111-1111-1111-111111111111', 'Reimport', {
    ...next.base,
    css: compileWorkshopProject(next),
    editor: exported
  })
  assert.equal(
    workshopEditor(imported)?.controls.find((item) => item.id === 'size')?.defaults.dark,
    '24px'
  )
  assert.match(compileWorkshopProject(next), /--size:24px/)
  next.unlinked = { size: true }
  next.values.dark['size.local'] = '50px'
  const removed = removeWorkshopControl(next, 'size')
  assert.equal(removed.values.dark['size.local'], undefined)
  assert.equal(removed.unlinked!.size, undefined)
  assert.equal(next.unlinked.size, true)
})

test('asset replacement preserves IDs and source snapshots across repeated replacements', () => {
  const project = createWorkshopProject('00000000-0000-0000-0000-000000000000', 'Assets')
  const asset = {
    id: 'art',
    type: 'image' as const,
    name: 'Art',
    license: 'MIT',
    source: 'Author',
    dataUrl: 'data:image/png;base64,YWJj'
  }
  project.assets = [asset]
  project.base.css = `.card{background:url('${asset.dataUrl}')}`
  project.base.variables = { '--art': `url('${asset.dataUrl}')` }
  project.base.editor = {
    schemaVersion: 1,
    controls: [
      {
        ...control,
        id: 'art',
        type: 'image',
        variable: '--art',
        defaults: { pureWhite: `url('${asset.dataUrl}')`, dark: 'none' }
      }
    ]
  }
  const source = JSON.stringify(project.base)
  const next = replaceWorkshopAsset(project, 'art', {
    ...asset,
    id: 'new',
    dataUrl: 'data:image/png;base64,ZGVm'
  })
  assert.equal(next.assets![0].id, 'art')
  assert.equal(JSON.stringify(next.base), source)
  assert.equal(JSON.stringify(project.base), source)
  assert.match(compileWorkshopProject(next), /base64,ZGVm/)
  assert.doesNotMatch(compileWorkshopProject(next), /base64,YWJj/)
  const again = replaceWorkshopAsset(next, 'art', {
    ...asset,
    dataUrl: 'data:image/png;base64,Z2hp'
  })
  assert.equal(again.assets![0].originalDataUrl, asset.dataUrl)
  assert.match(compileWorkshopProject(again), /base64,Z2hp/)
  assert.ok(workshopAssetReferences(again, again.assets![0]).includes('来源样式'))
  assert.throws(() => replaceWorkshopAsset(project, 'art', { ...asset, type: 'font' }), /类型/)
})
