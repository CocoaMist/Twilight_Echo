import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  CoreClientIdentity,
  CoreClientMessage,
  CoreRequestEnvelope,
  CoreSnapshot
} from '../../shared/coreProtocol.ts'
import type { LibraryPage } from '../../shared/libraryDatabase.ts'
import { createDefaultSettings } from '../settings/normalization.ts'
import { CoreRemoteService } from './service.ts'
import type { CorePlaybackSession } from '../playback/session.ts'

const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
const track = (id: string) => ({
  id,
  title: 'Song',
  artist: 'Artist',
  album: 'Album',
  duration: 120,
  source: 'local'
})
function fixture(t: test.TestContext, enabled = false) {
  const settings = createDefaultSettings('win32')
  settings.remoteControlEnabled = enabled
  let state = {
    phase: 'ready',
    epoch: 'test',
    presentationRevision: 0,
    playlistsRevision: 2,
    versionsRevision: 3,
    queue: { id: 'queue', revision: 7, total: 2, index: 0 },
    playback: { state: 'playing', playMode: 'shuffle', position: 23, volume: 0.5 },
    track: track('now'),
    mute: { muted: true },
    cast: null
  } as unknown as CoreSnapshot
  const starts: string[] = [],
    requests: CoreRequestEnvelope[] = [],
    identities: CoreClientIdentity[] = []
  const rows: unknown[] = [],
    edits: unknown[] = [],
    selected: number[] = [],
    failures: unknown[] = []
  let castActive = false,
    running = false,
    mode = 'full',
    pin = '111111'
  let receive!: (message: CoreClientMessage) => void
  let snapshot: unknown,
    disconnected = false
  let query = async (request: CoreRequestEnvelope): Promise<unknown> => {
    if (request.name === 'player.presentation') return { cover: null }
    if (request.name === 'library.tracks')
      return { tracks: [track('D:/private-song')], offset: 0, total: 1, revision: 4 }
    if (request.name === 'playlists.catalog')
      return { items: [{ id: 'mix', name: 'Mix', count: 2 }], total: 1, offset: 0, revision: 2 }
    if (request.name === 'playlists.view')
      return {
        revision: 2,
        page: {
          tracks: [track('one'), track('one')],
          entryIds: ['a', 'b'],
          total: 2,
          offset: 0,
          revision: 4
        }
      }
    if (request.name === 'queue.page')
      return {
        items: [{ position: 0, queueEntryId: 'occurrence-a', track: track('one') }],
        total: 2,
        offset: 0,
        revision: 7
      }
    return undefined
  }
  let privatePage: LibraryPage = {
    tracks: [
      {
        ...track('one'),
        filePath: 'D:/private.cue',
        cueRange: { startSeconds: 5, endSeconds: 10 }
      },
      { ...track('one'), source: 'network', filePath: 'private-network-source' }
    ],
    entryIds: ['a', 'b'],
    total: 2,
    offset: 0,
    revision: 4,
    versions: {}
  }
  const server = {
    setCommandHandler() {},
    setBrowseHandler() {},
    getStatus: () => ({
      running,
      enabled: running && mode === 'full',
      mediaOnly: running && mode === 'mediaOnly',
      pin
    }),
    start: async (_port: number, next: { mode: string }) => {
      running = true
      mode = next.mode
      starts.push(mode)
    },
    stop: async () => {
      running = false
      starts.push('stop')
    },
    rotatePin: () => {
      pin = '222222'
      return pin
    },
    updatePlaybackSnapshot: (value: unknown) => {
      snapshot = value
    }
  }
  const application = {
    connect: (identity: CoreClientIdentity, send: typeof receive) => {
      identities.push(identity)
      receive = send
      send({ kind: 'state', epoch: 'test', sequence: 0, snapshot: state })
    },
    disconnect: () => {
      disconnected = true
    },
    request: async (_id: string, request: CoreRequestEnvelope) => {
      requests.push(request)
      try {
        receive({
          kind: 'response',
          requestId: request.requestId,
          epoch: request.epoch,
          ok: true,
          value: await query(request)
        })
      } catch (error) {
        receive({
          kind: 'response',
          requestId: request.requestId,
          epoch: request.epoch,
          ok: false,
          error: { code: 'FAILED', message: String(error) }
        })
      }
    }
  }
  const service = new CoreRemoteService({
    server: server as never,
    settings: { read: () => settings, update: (patch) => Object.assign(settings, patch) },
    playback: {
      fromPages: async (produce, options) => {
        await produce(async (page) => {
          rows.push(...page)
        })
        options?.guard?.()
        selected.push(
          typeof options?.selectedIndex === 'function'
            ? options.selectedIndex()
            : (options?.selectedIndex ?? 0)
        )
      },
      edit: async (...args) => {
        edits.push(args)
      },
      snapshot: () => state as never
    } satisfies Pick<CorePlaybackSession, 'fromPages' | 'edit' | 'snapshot'>,
    playlistRecords: async () => ({
      revision: 2,
      versionsRevision: 3,
      viewId: 'mix-view',
      page: privatePage
    }),
    castActive: () => castActive,
    resolveCover: async () => null,
    now: () => 123,
    failed: (error) => failures.push(error)
  })
  service.attach(application)
  t.after(() => service.shutdown())
  return {
    service,
    starts,
    requests,
    identities,
    rows,
    edits,
    selected,
    failures,
    snapshot: () => snapshot,
    disconnected: () => disconnected,
    cast(value: boolean) {
      castActive = value
    },
    state(value: CoreSnapshot) {
      state = value
      receive({ kind: 'state', epoch: value.epoch, sequence: 1, snapshot: value })
    },
    query(value: typeof query) {
      query = value
    },
    page(value: LibraryPage) {
      privatePage = value
    }
  }
}

test('LAN stays disabled by default and remote toggles share the Cast media server', async (t) => {
  const f = fixture(t)
  await turn()
  assert.deepEqual(f.starts, ['stop'])
  assert.deepEqual(f.identities[0].permissions, ['playback:read', 'playback:write', 'library:read'])
  assert.equal((await f.service.setEnabled(true)).enabled, true)
  f.cast(true)
  assert.equal((await f.service.setEnabled(false)).mediaOnly, true)
  f.cast(false)
  await f.service.sync(true)
  assert.deepEqual(f.starts, ['stop', 'full', 'mediaOnly', 'stop'])
  assert.equal(f.service.rotatePin().pin, '222222')
  assert.deepEqual(f.failures, [])
})

test('renderer-free browsing issues opaque bounded identities and native Core transport commands', async (t) => {
  const f = fixture(t, true)
  await turn()
  const page = await f.service.browse({ view: 'library', query: 'album', offset: 0, limit: 40 })
  assert.doesNotMatch(JSON.stringify(page), /D:\/private/)
  await f.service.command({ action: 'playTrack', id: page.items[0].id })
  assert.deepEqual(f.requests.at(-1)?.payload, {
    query: { search: 'album', searchLiteral: true, sort: 'insertion', direction: 'asc' },
    selectedId: 'D:/private-song'
  })
  await f.service.command({ action: 'pause' })
  assert.equal(f.requests.at(-1)?.name, 'playback.pause')
  const calls = f.requests.length
  await assert.rejects(
    f.service.command({ action: 'removeQueue', index: 0, revision: 6 }),
    /queue_changed/
  )
  assert.equal(f.requests.length, calls)
  await f.service.command({ action: 'removeQueue', index: 0, revision: 7 })
  assert.deepEqual(f.requests.at(-1)?.payload, {
    id: 'queue',
    revision: 7,
    edit: { kind: 'remove', entryIds: ['occurrence-a'] }
  })
  assert.equal((f.snapshot() as { playMode: string }).playMode, 'shuffle')
})

test('mixed playlist playback keeps private sources, CUE and repeated occurrence selection in Core', async (t) => {
  const f = fixture(t, true)
  await turn()
  const lists = await f.service.browse({ view: 'playlists', query: '', offset: 0, limit: 40 })
  const members = await f.service.browse({
    view: 'playlists',
    playlistId: lists.items[0].id,
    query: '',
    offset: 0,
    limit: 40
  })
  await f.service.command({ action: 'playTrack', id: members.items[1].id })
  assert.deepEqual(f.selected, [1])
  assert.equal(
    (f.rows[0] as { localSnapshot: { filePath: string } }).localSnapshot.filePath,
    'D:/private.cue'
  )
  assert.equal(
    (f.rows[1] as { snapshot: { filePath: string } }).snapshot.filePath,
    'private-network-source'
  )
  assert.doesNotMatch(JSON.stringify(members), /private/)
  await f.service.command({ action: 'enqueueTrack', id: members.items[1].id })
  assert.equal(f.edits.length, 1)
  await f.service.shutdown()
  assert.equal(f.disconnected(), true)
  await assert.rejects(f.service.command({ action: 'play' }), /core_not_ready/)
})
