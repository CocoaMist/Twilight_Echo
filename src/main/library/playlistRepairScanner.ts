import type { LocalLibraryFileIdentity, RepairScanCall } from '../../shared/localLibraryScan.ts'
import { PLAYLIST_REPAIR_BATCH_SIZE } from '../../shared/playlistRepair.ts'
import type { LibraryTrackRecord } from '../../shared/libraryDatabase.ts'
import { compactPlaylistRecord } from '../../shared/playlistSnapshot.ts'
import type { DirectoryScanPage } from './libraryDatabaseScanner.ts'

/** Depth-first directory pages, four parsers, one awaited ACK. Neither file
 * identities nor candidate details accumulate across the selected directory. */
export async function runPlaylistRepairScan(options: {
  root: string
  enumerate(directory: string): AsyncIterable<DirectoryScanPage>
  parse(identity: LocalLibraryFileIdentity): Promise<LibraryTrackRecord[]>
  call(call: RepairScanCall): Promise<void>
}): Promise<void> {
  let pending: LibraryTrackRecord[] = []
  const flush = async () => {
    if (!pending.length) return
    const tracks = pending
    pending = []
    await options.call({ kind: 'append', tracks })
  }
  async function visit(directory: string): Promise<void> {
    for await (const page of options.enumerate(directory)) {
      for (let offset = 0; offset < page.identities.length; offset += PLAYLIST_REPAIR_BATCH_SIZE) {
        const identities = page.identities.slice(offset, offset + PLAYLIST_REPAIR_BATCH_SIZE)
        await options.call({ kind: 'authorize', paths: identities.map((file) => file.filePath) })
        for (let index = 0; index < identities.length; index += 4) {
          const results = await Promise.all(identities.slice(index, index + 4).map(options.parse))
          for (const tracks of results)
            for (const track of tracks) {
              pending.push(compactPlaylistRecord(track))
              if (pending.length === PLAYLIST_REPAIR_BATCH_SIZE) await flush()
            }
        }
      }
      // Also authorize each child before opening it. A junction/symlink swap
      // between enumeration and traversal must not escape the selected root.
      for (const child of page.children) {
        await options.call({ kind: 'authorize', paths: [child] })
        await visit(child)
      }
    }
  }
  await visit(options.root)
  await flush()
}
