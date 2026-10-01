import assert from 'node:assert/strict'
import test from 'node:test'
import { confirmAction, promptAction, useAppDialog } from './useAppDialog.ts'

test('queued decisions remain separate and cancellation never confirms an action', async () => {
  const { dialog, resolveDialog } = useAppDialog()
  const first = confirmAction({
    title: '删除主题？',
    message: '删除后不能恢复。',
    destructive: true
  })
  const second = promptAction('新歌单名称', '原名称')
  assert.equal(dialog.value?.title, '删除主题？')
  resolveDialog(null)
  assert.equal(await first, false)
  assert.equal(dialog.value?.input?.value, '原名称')
  resolveDialog('新名称')
  assert.equal(await second, '新名称')
  assert.equal(dialog.value, null)
})
