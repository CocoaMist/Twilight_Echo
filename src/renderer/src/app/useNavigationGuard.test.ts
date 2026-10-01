import assert from 'node:assert/strict'
import test from 'node:test'
import { effectScope } from 'vue'
import { navigateWithGuard, registerNavigationGuard } from './useNavigationGuard.ts'

test('cancelled navigation preserves the destination and disposing an editor removes its guard', async () => {
  const scope = effectScope()
  let destination = 'editor'
  scope.run(() => registerNavigationGuard(async () => false))
  assert.equal(
    await navigateWithGuard(() => {
      destination = 'library'
    }),
    false
  )
  assert.equal(destination, 'editor')
  scope.stop()
  assert.equal(
    await navigateWithGuard(() => {
      destination = 'library'
    }),
    true
  )
  assert.equal(destination, 'library')
})

test('repeated navigation waits for one decision and an exception releases the guard lock', async () => {
  const scope = effectScope()
  let decide!: (accepted: boolean) => void
  scope.run(() =>
    registerNavigationGuard(
      () =>
        new Promise((resolve) => {
          decide = resolve
        })
    )
  )
  let count = 0
  const first = navigateWithGuard(() => {
    count += 1
  })
  assert.equal(
    await navigateWithGuard(() => {
      count += 1
    }),
    false
  )
  decide(true)
  assert.equal(await first, true)
  assert.equal(count, 1)
  scope.stop()
  await assert.rejects(
    navigateWithGuard(() => {
      throw new Error('destination unavailable')
    })
  )
  assert.equal(
    await navigateWithGuard(() => {
      count += 1
    }),
    true
  )
  assert.equal(count, 2)
})
