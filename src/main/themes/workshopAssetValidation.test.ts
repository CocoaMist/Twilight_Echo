import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkshopProject } from '../../shared/themeWorkshop.ts'
import { diagnoseWorkshopAssetEncoding } from './workshopAssetValidation.ts'

test('corrupt images and font headers are blocked independently of renderer diagnostics', () => {
  const project = createWorkshopProject('00000000-0000-0000-0000-000000000000', 'Assets')
  project.assets = [
    {
      id: 'art',
      type: 'image',
      name: 'Art',
      dataUrl: 'data:image/png;base64,YWJj',
      source: '',
      license: ''
    },
    {
      id: 'font',
      type: 'font',
      name: 'Font',
      dataUrl: 'data:font/woff2;base64,YWJj',
      source: '',
      license: ''
    }
  ]
  assert.equal(diagnoseWorkshopAssetEncoding(project, () => false).length, 2)
  assert.equal(diagnoseWorkshopAssetEncoding(project, () => true)[0].location.id, 'font')
})
