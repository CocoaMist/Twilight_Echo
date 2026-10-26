import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import {
  createSftpSystemAdapter as createAdapter,
  sftpBatch,
  type SftpBatchRunner
} from '../../../core/network/adapters/sftpSystemAdapter.ts'
import { runSftpBatch } from '../systemRunners.ts'
export * from '../../../core/network/adapters/sftpSystemAdapter.ts'
export function createSftpSystemAdapter(
  deps: { runBatch?: SftpBatchRunner; tempDir?: string } = {}
): ReturnType<typeof createAdapter> {
  return createAdapter({
    tempDir: deps.tempDir ?? tmpdir(),
    newId: randomUUID,
    runOperation: (operation, connection, signal) =>
      (deps.runBatch ?? runSftpBatch)(sftpBatch(operation), connection, signal)
  })
}
