import { tmpdir } from 'node:os'
import {
  OutputTest as CoreOutputTest,
  type OutputTestDependencies
} from '../../core/audio/outputTest.ts'
export * from '../../core/audio/outputTest.ts'

export class OutputTest extends CoreOutputTest {
  constructor(dependencies: Omit<OutputTestDependencies, 'temporaryDirectory' | 'timers'>) {
    super({
      ...dependencies,
      temporaryDirectory: tmpdir(),
      timers: {
        setTimeout: (callback, delay) => setTimeout(callback, delay),
        clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout)
      }
    })
  }
}
