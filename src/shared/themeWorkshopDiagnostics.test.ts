import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkshopProject, isWorkshopProject } from './themeWorkshop.ts'
import { diagnoseWorkshopProject } from './themeWorkshopDiagnostics.ts'
import { diagnoseWorkshopCss, diagnoseWorkshopCssSupport } from './themeWorkshopCssDiagnostics.ts'
import { repairWorkshopDiagnostic } from './themeWorkshopEditing.ts'
import { workshopTemplate } from './themeWorkshopTemplates.ts'
import { WORKSHOP_TEMPLATES } from './themeWorkshop.ts'
import { WORKSHOP_LAYOUTS } from './themeWorkshopLayouts.ts'
import { findInvalidThemeShellLayoutFields } from './theme.ts'
import { createWorkshopLayer } from './themeWorkshopLayers.ts'

test('CSS diagnostics locate syntax and resources without treating quoted text as a URL', () => {
  const problems = diagnoseWorkshopCss(
    '.card {\n color red;\n background: url(art.png);\n}',
    'draft'
  )
  assert.equal(problems.find((item) => item.code === 'css.syntax')?.location.line, 2)
  assert.equal(problems.find((item) => item.code === 'css.resource')?.location.line, 3)
  assert.equal(
    diagnoseWorkshopCss(
      '.x{content:"url(file.png)";background:url(data:image/png;base64,YWJj)}',
      'draft'
    ).length,
    0
  )
  assert.equal(diagnoseWorkshopCss('@import "x.css";', 'base')[0].location.source, 'base')
  assert.equal(
    diagnoseWorkshopCss('.x{background:u\\72l(https://example.com/art)}', 'draft')[0].severity,
    'error'
  )
  const unsupported = diagnoseWorkshopCssSupport(
    '.x{future-property:future(1);--x:anything}',
    () => false
  )
  assert.equal(unsupported.length, 1)
  assert.equal(unsupported[0].severity, 'warning')
  assert.equal(unsupported[0].location.column, 4)
})

test('invalid tone values and missing references have reversible explicit repairs', () => {
  const project = workshopTemplate('00000000-0000-0000-0000-000000000000', 'minimal')
  const control = project.base.editor!.controls.find((item) => item.type === 'number')!
  project.values.dark[control.id] = '100000px'
  project.tokens.pureWhite['navigation.text'] = '#ffffff'
  project.tokens.pureWhite['navigation.surface'] = '#ffffff'
  const layer = createWorkshopLayer('missing', 'image')
  layer.assetId = 'missing'
  project.layers = { pureWhite: { app: [layer] }, dark: {} }
  project.fonts = { sans: 'missing' }
  const report = diagnoseWorkshopProject(project)
  assert.ok(report.errors >= 3)
  const value = report.diagnostics.find((item) => item.code === 'control.value')!
  assert.equal(value.location.tone, 'dark')
  const repaired = repairWorkshopDiagnostic(project, value)
  assert.equal(repaired.values.dark[control.id], undefined)
  assert.equal(project.values.dark[control.id], '100000px')
  const missing = report.diagnostics.find((item) => item.code === 'layer.asset')!
  assert.equal(repairWorkshopDiagnostic(project, missing).layers!.pureWhite.app![0].visible, false)
  assert.equal(
    repairWorkshopDiagnostic(
      project,
      report.diagnostics.find((item) => item.code === 'font.asset')!
    ).fonts!.sans,
    undefined
  )
  const contrast = report.diagnostics.find(
    (item) => item.code === 'contrast.tokens' && item.location.id === 'navigation.text'
  )!
  assert.ok(contrast.repair)
  assert.ok(
    !diagnoseWorkshopProject(repairWorkshopDiagnostic(project, contrast)).diagnostics.some(
      (item) =>
        item.code === 'contrast.tokens' &&
        item.location.id === 'navigation.text' &&
        item.location.tone === 'pureWhite'
    )
  )
  assert.ok(isWorkshopProject(project))
})

test('all templates and narrow-window layouts satisfy the host contract', () => {
  for (const template of WORKSHOP_TEMPLATES) {
    const project = workshopTemplate('00000000-0000-0000-0000-000000000000', template.id)
    assert.ok(isWorkshopProject(project), template.id)
    assert.equal(diagnoseWorkshopProject(project).errors, 0, template.id)
  }
  for (const preset of WORKSHOP_LAYOUTS) {
    assert.deepEqual(findInvalidThemeShellLayoutFields(preset.layout), [], preset.id)
    assert.ok(preset.layout.compact)
  }
  assert.equal(
    diagnoseWorkshopProject(
      createWorkshopProject('00000000-0000-0000-0000-000000000000', 'Old project')
    ).errors,
    0
  )
})
