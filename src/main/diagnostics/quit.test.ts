import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { registerDiagnosticQuit } from './quit.ts'

class QuitApp extends EventEmitter {
  attempts = 0
  exited = false
  quit(): void {
    this.attempts++
    let prevented = false
    this.emit('will-quit', {
      preventDefault: () => {
        prevented = true
      }
    })
    this.exited = !prevented
  }
}

test('one user quit resumes automatically when diagnostics finish', async () => {
  const app = new QuitApp()
  let drains = 0
  registerDiagnosticQuit(app, async () => {
    drains++
  })
  app.quit()
  assert.equal(app.exited, false)
  await new Promise((done) => setImmediate(done))
  assert.equal(app.exited, true)
  assert.equal(app.attempts, 2)
  assert.equal(drains, 1)
})

test('a stuck writer cannot hold quit; late completion does not retry again', async () => {
  const app = new QuitApp()
  let finish!: () => void
  let drains = 0
  registerDiagnosticQuit(
    app,
    () => {
      drains++
      return new Promise<void>((resolve) => {
        finish = resolve
      })
    },
    30
  )
  app.quit()
  app.quit()
  assert.equal(app.exited, false)
  await new Promise((done) => setTimeout(done, 60))
  assert.equal(app.exited, true)
  assert.equal(drains, 1)
  assert.equal(app.attempts, 3)
  finish()
  await new Promise((done) => setImmediate(done))
  assert.equal(app.attempts, 3)
})

test('synchronous and asynchronous diagnostic failures both allow quit', async () => {
  for (const drain of [
    () => {
      throw new Error('disk failure')
    },
    async () => {
      throw new Error('worker failure')
    }
  ]) {
    const app = new QuitApp()
    registerDiagnosticQuit(app, drain)
    app.quit()
    await new Promise((done) => setImmediate(done))
    assert.equal(app.exited, true)
  }
})
