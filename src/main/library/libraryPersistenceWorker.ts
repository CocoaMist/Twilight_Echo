import { parentPort } from 'node:worker_threads'
import {
  loadMusicLibraryDocument,
  persistMusicLibraryDocument,
  MAX_MUSIC_LIBRARY_BYTES
} from './libraryRepository.ts'
import {
  loadLocalLibraryFileIndex,
  persistLocalLibraryFileIndex,
  resetLocalLibraryFileIndex,
  synchronizeLocalLibraryFileIndexRevision
} from './fileIndex.ts'
import { recoverLocalLibraryRemoval, recoverLocalLibraryRemovalResult } from './removal.ts'
import { stringifyJsonForIpcStorage } from '../security/ipcValidation.ts'
import type {
  LocalMusicLibraryDocument,
  LocalLibraryTrackSelection
} from '../../shared/localLibrary.ts'
import type { LocalLibraryFileIndexDocument } from '../../shared/localLibraryScan.ts'

export type LibraryPersistenceOperation =
  | 'load'
  | 'persist'
  | 'validate'
  | 'loadIndex'
  | 'persistIndex'
  | 'resetIndex'
  | 'alignIndex'
  | 'recoverRemoval'
  | 'recoverRemovalResult'

type WorkerRequest = {
  id: number
  operation: LibraryPersistenceOperation
  args: unknown[]
  kind?: 'begin' | 'tracks' | 'finish'
  tracks?: unknown[]
}
let assembled: WorkerRequest | null = null
let assembledBytes = 0

parentPort?.on('message', (incoming: WorkerRequest) => {
  let request = incoming
  try {
    if (incoming.kind === 'begin') {
      const json = stringifyJsonForIpcStorage(
        incoming.args[1],
        'music library',
        MAX_MUSIC_LIBRARY_BYTES
      )
      assembledBytes = Buffer.byteLength(json)
      assembled = incoming
      return
    }
    if (incoming.kind === 'tracks') {
      if (!assembled || assembled.id !== incoming.id) throw new Error('Invalid library transfer')
      const document = assembled.args[1] as { tracks: unknown[] }
      const tracks = incoming.tracks ?? []
      const json = stringifyJsonForIpcStorage(tracks, 'music library', MAX_MUSIC_LIBRARY_BYTES)
      assembledBytes +=
        Buffer.byteLength(json) - 2 + (document.tracks.length && tracks.length ? 1 : 0)
      if (assembledBytes > MAX_MUSIC_LIBRARY_BYTES) throw new Error('music library is too large')
      for (const track of tracks) document.tracks.push(track)
      return
    }
    if (incoming.kind === 'finish') {
      if (!assembled || assembled.id !== incoming.id) throw new Error('Incomplete library transfer')
      request = assembled
      assembled = null
    }
    const [filePath, value, items] = request.args
    let result: unknown
    switch (request.operation) {
      case 'load':
        result = loadMusicLibraryDocument(filePath as string)
        break
      case 'persist':
        persistMusicLibraryDocument(filePath as string, value as LocalMusicLibraryDocument)
        break
      case 'validate':
        stringifyJsonForIpcStorage(value, 'music library', MAX_MUSIC_LIBRARY_BYTES)
        break
      case 'loadIndex':
        result = loadLocalLibraryFileIndex(filePath as string)
        break
      case 'persistIndex':
        persistLocalLibraryFileIndex(filePath as string, value as LocalLibraryFileIndexDocument)
        break
      case 'resetIndex':
        resetLocalLibraryFileIndex(filePath as string, value as number)
        break
      case 'alignIndex':
        synchronizeLocalLibraryFileIndexRevision(filePath as string, value as number)
        break
      case 'recoverRemoval':
        result = recoverLocalLibraryRemoval(filePath as string)
        break
      case 'recoverRemovalResult':
        result = recoverLocalLibraryRemovalResult(
          filePath as string,
          value as LocalMusicLibraryDocument,
          items as LocalLibraryTrackSelection[]
        )
        break
      default:
        throw new Error('Unknown library persistence operation')
    }
    parentPort!.postMessage({ id: request.id, ok: true, result })
  } catch (error) {
    assembled = null
    const failure = error instanceof Error ? error : new Error(String(error))
    parentPort!.postMessage({
      id: request.id,
      ok: false,
      error: {
        ...failure,
        name: failure.name,
        message: failure.message
      }
    })
  }
})
