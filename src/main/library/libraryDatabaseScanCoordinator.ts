import { randomUUID } from 'node:crypto'
import {
  LibraryDatabaseScanCoordinator as CoreScanCoordinator,
  type CoreScanCoordinatorOptions
} from '../../core/library/scanCoordinator.ts'
export type { DatabaseScanStatus } from '../../core/library/scanCoordinator.ts'
/** Existing main callers keep their contract until the production cutover. */
export class LibraryDatabaseScanCoordinator extends CoreScanCoordinator {
  constructor(options: Omit<CoreScanCoordinatorOptions, 'now' | 'newId'>) {
    super({ ...options, now: Date.now, newId: randomUUID })
  }
}
