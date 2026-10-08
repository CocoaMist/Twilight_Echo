import assert from 'node:assert/strict'
import test from 'node:test'
import { useRadioStore } from './useRadioStore.ts'
import {
  MAX_RADIO_STATIONS,
  type RadioStation,
  type RadioStationsDocument
} from '../../../shared/radioStations.ts'
import {
  PersistentDataRevisionConflictError,
  type VersionedDataEnvelope
} from '../../../shared/versionedPersistence.ts'

function station(id: string): RadioStation {
  return {
    id,
    name: id,
    streamUrl: `https://example.test/${id}`,
    allowInsecureHttp: false,
    createdAt: '2026-10-08T00:00:00Z',
    updatedAt: '2026-10-08T00:00:00Z'
  }
}

function fixture(stations: RadioStation[] = []) {
  const store = useRadioStore()
  let disk: VersionedDataEnvelope<RadioStationsDocument> = {
    version: 2,
    revision: store.revision.value + 1,
    savedAt: '2026-10-08T00:00:00Z',
    data: { schemaVersion: 1, stations }
  }
  let saves = 0
  const api = {
    loadStations: async () => structuredClone(disk),
    saveStations: async (next: RadioStationsDocument, revision: number) => {
      saves++
      if (revision !== disk.revision) throw new PersistentDataRevisionConflictError(disk, revision)
      disk = { ...disk, data: structuredClone(next), revision: revision + 1 }
      return structuredClone(disk)
    },
    importPlaylist: async () => [] as RadioStation[]
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { api: { radio: api } }
  })
  return { store, api, disk: () => disk, saves: () => saves }
}

const add = (store: ReturnType<typeof useRadioStore>, id: string) =>
  store.addStation({ name: id, streamUrl: station(id).streamUrl })

test('a failed authoritative read prevents writing a stale radio collection and can be retried', async () => {
  const f = fixture([station('existing')])
  await f.store.ensureLoaded()
  const load = f.api.loadStations
  f.api.loadStations = async () => {
    throw new Error('disk unavailable')
  }
  await assert.rejects(add(f.store, 'new'), /disk unavailable/)
  assert.equal(f.saves(), 0)
  assert.deepEqual(
    f.disk().data.stations.map((item) => item.id),
    ['existing']
  )
  f.api.loadStations = load
  await add(f.store, 'new')
  assert.equal(f.store.error.value, '')
  assert.equal(f.disk().data.stations.length, 2)
})

test('a missing load payload does not turn a stale collection into writable data', async () => {
  const f = fixture([station('existing')])
  f.api.loadStations = async () => null as never
  await assert.rejects(add(f.store, 'new'), /无法读取当前电台/)
  assert.equal(f.saves(), 0)
})

test('adding and importing at capacity preserve every existing favorite without a save', async () => {
  const originals = Array.from({ length: MAX_RADIO_STATIONS }, (_, i) => station(`old-${i}`))
  const f = fixture(originals)
  await assert.rejects(add(f.store, 'overflow'), /数量已达上限/)
  f.api.importPlaylist = async () => [station('overflow')]
  await assert.rejects(f.store.importPlaylistText('list'), /超过上限/)
  assert.equal(f.saves(), 0)
  assert.deepEqual(f.disk().data.stations, originals)
})

test('import counts only unique new stations and a duplicate-only import makes no write', async () => {
  const f = fixture([station('existing')])
  f.api.importPlaylist = async () => [station('existing'), station('new'), station('new')]
  assert.equal(await f.store.importPlaylistText('list'), 1)
  assert.deepEqual(
    f.disk().data.stations.map((item) => item.id),
    ['new', 'existing']
  )
  assert.equal(await f.store.importPlaylistText('same list'), 0)
  assert.equal(f.saves(), 1)
  await assert.rejects(add(f.store, 'existing'), /已收藏/)
  assert.equal(f.saves(), 1)
})

test('rapid mutations wait for pending saves and retain both successful additions', async () => {
  const f = fixture()
  const save = f.api.saveStations
  let release!: () => void
  let started!: () => void
  const pending = new Promise<void>((resolve) => (release = resolve))
  const firstSave = new Promise<void>((resolve) => (started = resolve))
  let calls = 0
  f.api.saveStations = async (next, revision) => {
    if (++calls === 1) {
      started()
      await pending
    }
    return save(next, revision)
  }
  const first = add(f.store, 'first')
  await firstSave
  const second = add(f.store, 'second')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)
  release()
  await Promise.all([first, second])
  assert.deepEqual(
    f.disk().data.stations.map((item) => item.name),
    ['second', 'first']
  )
})

test('save failures remain visible, preserve the disk and do not poison later mutations', async () => {
  const f = fixture([station('existing')])
  const save = f.api.saveStations
  f.api.saveStations = async () => {
    throw new Error('save failed')
  }
  await assert.rejects(f.store.removeStation('existing'), /save failed/)
  assert.equal(f.store.error.value, 'save failed')
  assert.equal(f.disk().data.stations.length, 1)
  f.api.saveStations = save
  await f.store.removeStation('existing')
  assert.equal(f.disk().data.stations.length, 0)
  assert.equal(f.store.error.value, '')
})

test('a reload during playlist parsing cannot authorize saving an older snapshot over a newer revision', async () => {
  const f = fixture([station('existing')])
  let release!: (stations: RadioStation[]) => void
  let started!: () => void
  const parsing = new Promise<void>((resolve) => (started = resolve))
  f.api.importPlaylist = () => {
    started()
    return new Promise((resolve) => (release = resolve))
  }
  const importing = f.store.importPlaylistText('pending list')
  await parsing
  f.disk().data.stations.push(station('other-window'))
  f.disk().revision++
  await f.store.ensureLoaded()
  release([station('new')])
  await assert.rejects(importing, /revision conflict/)
  assert.deepEqual(
    f.disk().data.stations.map((item) => item.id),
    ['existing', 'other-window']
  )
})

test('revision conflicts expose the current collection and report the failed action', async () => {
  const f = fixture([station('existing')])
  const current = {
    ...f.disk(),
    revision: f.disk().revision + 1,
    data: { schemaVersion: 1 as const, stations: [station('other-window')] }
  }
  f.api.saveStations = async (_next, revision) => {
    throw new PersistentDataRevisionConflictError(current, revision)
  }
  await assert.rejects(add(f.store, 'new'), /revision conflict/)
  assert.deepEqual(
    f.store.stations.value.map((item) => item.id),
    ['other-window']
  )
  assert.match(f.store.error.value, /revision conflict/)
})
