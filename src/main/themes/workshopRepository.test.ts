import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkshopRepository } from './workshopRepository.ts'
import { createWorkshopProject } from '../../shared/themeWorkshop.ts'

test('projects survive reopening and stale writes cannot overwrite newer drafts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'workshop-test-'))
  try {
    const repo = new WorkshopRepository(directory)
    const initial = createWorkshopProject('00000000-0000-0000-0000-000000000000', '我的主题')
    const saved = repo.save(initial)
    assert.equal(saved.revision, 1)
    assert.deepEqual(new WorkshopRepository(directory).get(initial.id), saved)
    assert.throws(() => repo.save(initial), /其他窗口/)
    assert.throws(() => repo.get('../outside'), /无效/)
    const applied = repo.saveApplied({ ...saved, name: '已应用' })
    repo.save({ ...applied, name: '未应用草稿' })
    const restored = new WorkshopRepository(directory).restoreApplied(initial.id)
    assert.equal(restored.name, '已应用')
    assert.equal(restored.revision, 4)
    assert.equal(repo.list().length, 1)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('duplicate clears applied state and remove only deletes the selected draft and backups', () => {
  const directory = mkdtempSync(join(tmpdir(), 'workshop-copy-test-'))
  try {
    const repo = new WorkshopRepository(directory)
    const applied = repo.saveApplied({
      ...createWorkshopProject('00000000-0000-0000-0000-000000000000', 'Original'),
      lastApplied: { version: '1.0.0', at: 'now' }
    })
    const saved = repo.save({ ...applied, name: 'New name' })
    const copy = repo.duplicate(saved.id, saved.revision)
    assert.notEqual(copy.id, saved.id)
    assert.equal(copy.lastApplied, undefined)
    assert.throws(() => repo.duplicate(saved.id, applied.revision), /其他窗口/)
    assert.throws(() => repo.remove(saved.id, applied.revision), /其他窗口/)
    writeFileSync(join(directory, saved.id + '.applied.json.bak'), JSON.stringify(applied))
    writeFileSync(join(directory, 'installed-theme.tep'), 'installed')
    repo.remove(saved.id, saved.revision)
    assert.ok(readdirSync(directory).every((name) => !name.startsWith(saved.id)))
    assert.ok(readdirSync(directory).includes('installed-theme.tep'))
    assert.equal(repo.get(copy.id)?.name, copy.name)
    assert.throws(() => repo.remove('../escape', 1), /无效/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
