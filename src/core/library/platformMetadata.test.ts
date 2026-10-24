import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LibraryDatabase } from '../../main/library/libraryDatabase.ts'
import { getLibraryDatabasePath } from '../../main/library/libraryDatabase.ts'
import {
  LibraryDatabaseServiceClient,
  type DatabaseUtilityProcess
} from '../../main/library/libraryDatabaseServiceClient.ts'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import type { LibraryDatabaseWorkerRequest } from '../../main/library/libraryDatabaseProtocol.ts'
import type { EntityMetadataDatabaseApi, EntityMetadataFact } from '../../shared/entityMetadata.ts'
import type { MetadataUsage, PlatformMetadataResult } from '../../shared/musicMetadata.ts'
import { validPlatformMetadataResult } from '../../shared/musicMetadata.ts'
import type { CatalogKind } from '../../shared/musicCatalog.ts'
import { validEntityMetadataPayload } from '../../shared/entityMetadata.ts'
import {
  providerSupportsMethod,
  isTwilightMediaProviderMethod
} from '../plugins/providerRouting.ts'
import { PlatformMetadataProvider, platformMetadataApprovals } from './platformMetadataProvider.ts'
import { CoreEntityMetadataService } from './entityMetadataService.ts'
import { MusicBrainzWikiProvider } from './entityMetadataProvider.ts'

const usage: MetadataUsage = { display: true, cache: true, crossSource: true, export: false }
const policy = { enabled: true, publicServiceApproved: false, wikipediaText: false, contact: '' }
const controller = () => new AbortController()
function response(
  kind: 'artist' | 'release' = 'artist',
  texts?: Extract<PlatformMetadataResult, { status: 'ok' }>['metadata']['texts']
): PlatformMetadataResult {
  return {
    status: 'ok',
    metadata: {
      schemaVersion: 1,
      provider: 'ncm',
      kind,
      id: '42',
      name: 'Artist',
      texts: texts ?? [
        {
          field: 'introduction',
          value: '平台人物介绍',
          language: 'zh-Hans',
          url: 'https://music.163.com/#/artist?id=42',
          revision: '7',
          attribution: '网易云音乐',
          license: '',
          licenseUrl: ''
        }
      ]
    }
  }
}
function fixture() {
  const state = {
    configuration: 'account-a',
    enabled: true,
    methods: ['fetchArtistMetadata', 'fetchAlbumMetadata'],
    usage: structuredClone(usage) as MetadataUsage | null,
    raw: response() as unknown,
    calls: [] as unknown[][]
  }
  const provider = new PlatformMetadataProvider('ncm', {
    inventory: () => [
      {
        id: 'ncm',
        enabled: state.enabled,
        supportedMethods: state.methods,
        configuration: state.configuration
      }
    ],
    usage: () => state.usage,
    now: () => 2000,
    call: async (...args) => {
      state.calls.push(args)
      return state.raw
    },
    sourcePage: (_, id) => `https://music.163.com/#/artist?id=${id}`
  })
  return { state, provider }
}
function seed(db: LibraryDatabase, kind: CatalogKind = 'artist') {
  db.replaceDocument({
    version: 2,
    revision: 1,
    folders: ['D:/music'],
    exclusions: [],
    tracks: [
      {
        id: 'one',
        source: 'local',
        filePath: 'D:/music/one.flac',
        title: 'Song',
        artist: 'Artist',
        album: 'Album'
      }
    ]
  })
  while (db.catalogStatus().localPending) db.catalogAdvance()
  let batch = db.catalogSync({ kind: 'begin', revision: 1 })
  batch = db.catalogSync({
    kind: 'append',
    ...batch,
    tracks: [
      {
        id: 'ncm:7',
        source: 'ncm',
        filePath: '',
        fileName: '',
        title: 'Song',
        artist: 'Artist',
        album: 'Album',
        albumId: '42',
        artists: [{ name: 'Artist', id: 42 }],
        duration: 200,
        size: 0,
        cover: null,
        lyrics: null
      }
    ]
  })
  db.catalogSync({ kind: 'commit', ...batch })
  const local = db.catalogQuery({ kind, source: 'local' }).items[0].id
  const online = db.catalogQuery({ kind, source: 'ncm' }).items[0].id
  for (const entityId of [local, online]) {
    const [candidate] = db.identificationPublish(
      db.identificationInput(entityId),
      [
        {
          provider: 'ncm',
          name: 'Artist',
          summary: 'Manually verified native identity',
          matcherVersion: 'fixture-v1',
          references: [{ provider: 'ncm', kind, idType: 'native', value: '42' }],
          evidence: {
            origin: 'search',
            matches: [],
            missing: ['manual'],
            conflicts: [],
            incomplete: true,
            provenance: 'fixture'
          }
        }
      ],
      1000
    )
    db.identificationDecide(
      {
        candidateId: candidate.id,
        revision: candidate.revision,
        linkRevision: candidate.linkRevision,
        decision: 'confirm'
      },
      1001
    )
  }
  return { local, online }
}
function asyncDb(db: LibraryDatabase): EntityMetadataDatabaseApi {
  return new Proxy({} as EntityMetadataDatabaseApi, {
    get:
      (_, key: keyof EntityMetadataDatabaseApi) =>
      async (...args: unknown[]) =>
        (db[key] as (...args: unknown[]) => unknown).apply(db, args)
  })
}
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 500; i++) {
    if (await check()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error('Native metadata condition timed out')
}
function service(db: LibraryDatabase, provider: PlatformMetadataProvider) {
  return new CoreEntityMetadataService({
    database: asyncDb(db),
    provider: new MusicBrainzWikiProvider(() => policy),
    enrichmentProviders: () => [provider],
    policy: () => policy,
    now: () => 2000,
    changed() {},
    failed(error) {
      throw error
    }
  })
}

test('native-only local and platform artists share one durable text task without MB service permission', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'native-metadata-')),
    path = join(root, 'library.sqlite')
  let db = new LibraryDatabase(path)
  const { local, online } = seed(db),
    { state, provider } = fixture()
  const core = service(db, provider)
  t.after(async () => {
    await core.shutdown()
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  assert.deepEqual(
    db.identificationDetail(local).references.map((r) => r.provider),
    ['ncm']
  )
  assert.throws(
    () =>
      db.metadataEnqueue(
        { type: 'enrich', entityId: local, language: 'zh-Hans', batchId: 'old' },
        2000
      ),
    /MusicBrainz/
  )
  const first = await core.enrich({
    entityId: local,
    language: 'zh-Hans',
    batchId: 'local',
    provider: 'platform.ncm'
  })
  const second = await core.enrich({
    entityId: online,
    language: 'zh-Hans',
    batchId: 'platform',
    provider: 'platform.ncm'
  })
  assert.equal(first.id, second.id)
  core.activate()
  await until(() => db.metadataJobs({ jobId: first.id }).items[0].state === 'completed')
  assert.equal(state.calls.length, 1)
  assert.equal((await core.detail(local, 'zh-Hans')).introduction?.value, '平台人物介绍')
  assert.equal(
    (await core.detail(online, 'zh-Hans')).introduction?.attribution?.provider,
    'platform.ncm'
  )
  await core.shutdown()
  db.close()
  db = new LibraryDatabase(path)
  const restarted = service(db, provider)
  try {
    assert.equal((await restarted.detail(local, 'zh-Hans')).introduction?.value, '平台人物介绍')
    assert.equal(state.calls.length, 1, 'offline reads never fetch')
    state.configuration = 'account-b'
    assert.equal(
      (await restarted.detail(local, 'zh-Hans')).introduction,
      null,
      'old account facts cannot reappear after restart'
    )
  } finally {
    await restarted.shutdown()
  }
})

test('native text and source context traverse the actual database worker and remain readable after its replacement', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'native-metadata-worker-')),
    json = join(root, 'library.json')
  const seeded = new LibraryDatabase(getLibraryDatabasePath(json)),
    { online, local } = seed(seeded)
  seeded.close()
  const children: ChildProcess[] = []
  const createClient = () =>
    new LibraryDatabaseServiceClient({
      libraryFilePath: json,
      serviceEntry: fileURLToPath(
        new URL('../../main/library/libraryDatabaseService.ts', import.meta.url)
      ),
      fork: (entry) => {
        const child = fork(entry, [], {
          execArgv: ['--experimental-strip-types'],
          stdio: ['ignore', 'ignore', 'pipe', 'ipc']
        })
        children.push(child)
        Object.assign(child, {
          postMessage: (message: LibraryDatabaseWorkerRequest) => child.send(message)
        })
        return child as unknown as DatabaseUtilityProcess
      }
    })
  let client = createClient()
  const { provider, state } = fixture()
  state.usage!.crossSource = false
  const core = new CoreEntityMetadataService({
    database: client,
    provider: new MusicBrainzWikiProvider(() => policy),
    enrichmentProviders: () => [provider],
    policy: () => policy,
    now: () => 2000,
    changed() {},
    failed(error) {
      throw error
    }
  })
  t.after(async () => {
    await core.shutdown()
    await client.close()
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    rmSync(root, { recursive: true, force: true })
  })
  const job = await core.enrich({
    entityId: online,
    language: 'zh-Hans',
    batchId: 'worker',
    provider: 'platform.ncm'
  })
  core.activate()
  await until(
    async () => (await client.metadataJobs({ jobId: job.id })).items[0].state === 'completed'
  )
  assert.equal((await core.detail(online, 'zh-Hans', 'ncm')).introduction?.value, '平台人物介绍')
  assert.equal((await core.detail(local, 'zh-Hans')).introduction, null)
  await core.shutdown()
  await client.close()
  if (children[0].exitCode === null && children[0].signalCode === null)
    await once(children[0], 'exit')
  client = createClient()
  const options = {
    sourceProvider: 'ncm',
    platformContexts: { ncm: provider.context() },
    now: 2001
  }
  assert.equal(
    (await client.metadataDetail(online, 'zh-Hans', options)).introduction?.value,
    '平台人物介绍'
  )
  options.platformContexts.ncm = 'new-account'
  assert.equal((await client.metadataDetail(online, 'zh-Hans', options)).introduction, null)
  assert.equal(state.calls.length, 1)
  assert.equal((await client.metadataCredits({ entityId: online, limit: 200 })).total, 0)
})

test('platform album details share confirmed native release identity, preserving local override, reset and detach', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const { local, online } = seed(db, 'release'),
    { provider, state } = fixture()
  state.raw = response('release')
  const core = service(db, provider)
  t.after(() => core.shutdown())
  const job = await core.enrich({
    entityId: local,
    language: 'zh-Hans',
    batchId: 'album',
    provider: 'platform.ncm'
  })
  core.activate()
  await until(() => db.metadataJobs({ jobId: job.id }).items[0].state === 'completed')
  assert.equal((state.calls[0] as unknown[])[1], 'fetchAlbumMetadata')
  let detail = await core.detail(local, 'zh-Hans')
  detail = await core.override({
    entityId: local,
    revision: detail.revision,
    language: 'zh-Hans',
    mode: 'value',
    value: '我的专辑介绍'
  })
  assert.equal(detail.introduction?.value, '我的专辑介绍')
  assert.equal((await core.detail(online, 'zh-Hans')).introduction?.value, '平台人物介绍')
  await core.override({
    entityId: local,
    revision: detail.revision,
    language: 'zh-Hans',
    mode: 'clear'
  })
  detail = await core.detail(local, 'zh-Hans')
  assert.equal(detail.introduction, null)
  await core.override({
    entityId: local,
    revision: detail.revision,
    language: 'zh-Hans',
    mode: 'reset'
  })
  detail = await core.detail(local, 'zh-Hans')
  assert.equal(detail.introduction?.value, '平台人物介绍')
  await core.detach(local, detail.revision)
  assert.equal((await core.detail(local, 'zh-Hans')).introduction, null)
  assert.equal((await core.detail(online, 'zh-Hans')).introduction?.value, '平台人物介绍')
})

test('restricted text uses the actual platform source, not a caller-selected context on a local entity', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const { local, online } = seed(db),
    { provider, state } = fixture()
  state.usage!.crossSource = false
  const core = service(db, provider)
  t.after(() => core.shutdown())
  const job = await core.enrich({
    entityId: online,
    language: 'zh-Hans',
    batchId: 'scoped',
    provider: 'platform.ncm'
  })
  core.activate()
  await until(() => db.metadataJobs({ jobId: job.id }).items[0].state === 'completed')
  assert.equal((await core.detail(local, 'zh-Hans')).introduction, null)
  assert.equal((await core.detail(online, 'zh-Hans', 'ncm')).introduction?.value, '平台人物介绍')
  await assert.rejects(core.detail(local, 'zh-Hans', 'ncm'), /不属于当前来源/)
  state.enabled = false
  assert.equal((await core.detail(online, 'zh-Hans')).introduction, null)
})

test('language comes before provider and local same-language defaults to Wikipedia while platform favors its own text', (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const { local, online } = seed(db),
    { provider } = fixture()
  const job = db.metadataEnqueue(
    {
      entityId: local,
      type: 'enrich',
      language: 'zh-Hans',
      batchId: 'langs',
      provider: 'platform.ncm'
    },
    2000
  )
  const work = db.metadataClaim(2000)!
  assert.equal(work.job.id, job.id)
  const facts = (response() as Extract<PlatformMetadataResult, { status: 'ok' }>).metadata.texts[0]
  const fact = (value: string, language: string, platform = false): EntityMetadataFact => ({
    field: 'introduction',
    value,
    language,
    ...(platform ? { sourceProvider: 'ncm', providerContext: provider.context(), usage } : {}),
    attribution: {
      provider: platform ? 'platform.ncm' : 'wikipedia',
      externalId: '42',
      url: facts.url,
      revision: '7',
      attribution: 'fixture',
      license: '',
      licenseUrl: '',
      retrievedAt: 2000
    }
  })
  db.metadataFinish(
    work,
    {
      state: 'completed',
      outcome: 'matched',
      facts: [
        fact('繁体百科', 'zh-Hant'),
        fact('English', 'en'),
        fact('平台简体', 'zh-CN', true),
        fact('平台繁体', 'zh-Hant', true),
        fact('未知语种', 'und', true)
      ]
    },
    2001
  )
  const opts = { platformContexts: { ncm: provider.context() }, now: 2001 }
  assert.equal(db.metadataDetail(local, 'zh-Hans', opts).introduction?.value, '平台简体')
  assert.equal(db.metadataDetail(local, 'zh-Hans', opts).introduction?.language, 'zh-CN')
  assert.equal(db.metadataDetail(local, 'zh-Hant', opts).introduction?.value, '繁体百科')
  assert.equal(db.metadataDetail(online, 'zh-Hant', opts).introduction?.value, '平台繁体')
  assert.equal(db.metadataDetail(local, 'en', opts).introduction?.value, 'English')
})

test('permissions are per text, capped by reviewed deployment approval and expire without displaying old content', async () => {
  const { state, provider } = fixture()
  const texts = (response() as Extract<PlatformMetadataResult, { status: 'ok' }>).metadata.texts
  state.raw = response('artist', [
    { ...texts[0], value: 'display only', usage: { ...usage, cache: false } },
    { ...texts[0], value: 'expired', usage: { ...usage, expiresAt: 1999 } },
    { ...texts[0], value: 'valid', usage: { ...usage, export: true, expiresAt: 3000 } }
  ])
  const result = await provider.enrich(
    { kind: 'artist', externalId: '42', language: 'en' },
    controller().signal
  )
  assert.deepEqual(
    result.facts.map((f) => f.value),
    ['valid']
  )
  assert.equal(result.facts[0].usage?.export, false)
  assert.equal(result.facts[0].usage?.expiresAt, 3000)
  state.usage = null
  await assert.rejects(
    provider.enrich({ kind: 'artist', externalId: '42', language: 'en' }, controller().signal),
    /cache_not_approved/
  )
  assert.equal(state.calls.length, 1)
})

test('cache deadlines retire persisted text but preserve manual values and confirmed identities', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const { local } = seed(db),
    { provider, state } = fixture()
  state.usage!.expiresAt = 3000
  const core = service(db, provider)
  t.after(() => core.shutdown())
  const job = await core.enrich({
    entityId: local,
    language: 'zh-Hans',
    batchId: 'expires',
    provider: 'platform.ncm'
  })
  core.activate()
  await until(() => db.metadataJobs({ jobId: job.id }).items[0].state === 'completed')
  await core.shutdown()
  const detail = db.metadataDetail(local, 'zh-Hans', {
    now: 2000,
    platformContexts: { ncm: provider.context() }
  })
  db.metadataOverride(
    { entityId: local, language: 'en', mode: 'value', value: 'My note', revision: detail.revision },
    2001
  )
  // The override API's read uses wall time, so insert a fresh cached record to
  // independently exercise background retirement at a deterministic deadline.
  const fact = {
    field: 'introduction',
    value: 'cached',
    language: 'en',
    usage: { ...usage, expiresAt: 3000 },
    sourceProvider: 'ncm',
    providerContext: provider.context(),
    attribution: { provider: 'platform.ncm', externalId: '42' }
  }
  db.sql
    .prepare('INSERT OR REPLACE INTO metadata_facts VALUES(?,?,?,?,?)')
    .run(detail.targetId!, 'platform.ncm', 'introduction', 'en', JSON.stringify(fact))
  assert.equal(db.metadataNextAttempt(), 3000)
  assert.equal(db.metadataClaim(3000), null)
  assert.equal(db.sql.prepare('SELECT count(*) n FROM metadata_facts').get()!.n, 0)
  assert.equal(db.metadataDetail(local, 'en').introduction?.value, 'My note')
  assert.equal(db.identificationDetail(local).link?.state, 'confirmed')
  assert.equal(db.metadataNextAttempt(), null)
})

test('legacy string capability retains und and requires a canonical source page; new method wins when available', async () => {
  const { state, provider } = fixture()
  state.methods = ['fetchArtistIntro']
  state.raw = '旧的纯字符串'
  const result = await provider.enrich(
    { kind: 'artist', externalId: '42', language: 'en' },
    controller().signal
  )
  assert.equal(result.facts[0].language, 'und')
  assert.equal(result.facts[0].attribution.license, '')
  state.methods.push('fetchArtistMetadata')
  state.raw = response()
  await provider.enrich(
    { kind: 'artist', externalId: '42', language: 'zh-Hans' },
    controller().signal
  )
  assert.deepEqual(
    state.calls.map((c) => c[1]),
    ['fetchArtistIntro', 'fetchArtistMetadata']
  )
})

test('missing, unsupported and absent text remain distinct and never remove previous facts', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const { online } = seed(db),
    { provider, state } = fixture()
  const core = service(db, provider)
  t.after(() => core.shutdown())
  const original = await core.enrich({
    entityId: online,
    language: 'en',
    batchId: 'original',
    provider: 'platform.ncm'
  })
  core.activate()
  await until(() => db.metadataJobs({ jobId: original.id }).items[0].state === 'completed')
  for (const status of ['not_found', 'not_provided', 'unsupported'] as const) {
    state.raw = { status }
    state.configuration = status
    const job = await core.enrich({
      entityId: online,
      language: 'en',
      batchId: status,
      provider: 'platform.ncm'
    })
    core.activate()
    core.refreshIdentification()
    await until(() => db.metadataJobs({ jobId: job.id }).items[0].state === 'completed')
    assert.equal(db.metadataJobs({ jobId: job.id }).items[0].reason, `platform_metadata_${status}`)
  }
  assert.equal(db.sql.prepare('SELECT count(*) n FROM metadata_facts').get()!.n, 1)
  state.configuration = 'account-a'
  assert.equal((await core.detail(online, 'zh-Hans')).introduction?.value, '平台人物介绍')
})

test('Core recovers an in-flight native text task on account switch and discards the old reply', async (t) => {
  const db = new LibraryDatabase(':memory:')
  t.after(() => db.close())
  const { online } = seed(db)
  let account = 'a',
    calls = 0,
    resolve!: (value: unknown) => void
  const provider = new PlatformMetadataProvider('ncm', {
    inventory: () => [
      {
        id: 'ncm',
        enabled: true,
        supportedMethods: ['fetchArtistMetadata'],
        configuration: account
      }
    ],
    usage: () => usage,
    call: async () => {
      calls++
      if (calls === 1)
        return new Promise((r) => {
          resolve = r
        })
      return response()
    }
  })
  const core = service(db, provider)
  t.after(() => core.shutdown())
  const job = await core.enrich({
    entityId: online,
    language: 'en',
    batchId: 'switch',
    provider: 'platform.ncm'
  })
  core.activate()
  await until(() => calls === 1)
  account = 'b'
  core.refreshIdentification(false, 'platform.ncm')
  const old = response() as Extract<PlatformMetadataResult, { status: 'ok' }>
  old.metadata.texts[0].value = '旧账号正文'
  resolve(old)
  await until(() => db.metadataJobs({ jobId: job.id }).items[0].state === 'completed')
  assert.equal(calls, 2)
  assert.equal(db.metadataJobs({ jobId: job.id }).items[0].generation, 2)
  assert.equal((await core.detail(online, 'zh-Hans')).introduction?.value, '平台人物介绍')
  assert.ok(
    !JSON.stringify(db.sql.prepare('SELECT payload FROM metadata_facts').all()).includes(
      '旧账号正文'
    )
  )
})

test('native adapter rejects wrong identities and malformed wire text without publishing candidates or facts', async () => {
  const { state, provider } = fixture()
  for (const edit of [
    (m: any) => {
      m.id = 'other'
    },
    (m: any) => {
      m.provider = 'other'
    },
    (m: any) => {
      m.kind = 'release'
    },
    (m: any) => {
      m.texts[0].url = 'https://example.org/page?cookie=secret'
    },
    (m: any) => {
      m.texts[0].value = 'x'.repeat(20001)
    },
    (m: any) => {
      m.texts[0].language = 'invented-language'
    },
    (m: any) => {
      m.texts[0].cookie = 'secret'
    }
  ]) {
    const raw = response() as Extract<PlatformMetadataResult, { status: 'ok' }>
    edit(raw.metadata)
    state.raw = raw
    await assert.rejects(
      provider.enrich({ kind: 'artist', externalId: '42', language: 'en' }, controller().signal),
      /Invalid|mismatch/
    )
  }
})

test('cancellation and configuration changes fence an adapter that finishes late', async () => {
  let resolve!: (value: unknown) => void
  let context = 'account-a'
  const provider = new PlatformMetadataProvider('ncm', {
    inventory: () => [
      {
        id: 'ncm',
        enabled: true,
        supportedMethods: ['fetchArtistMetadata'],
        configuration: context
      }
    ],
    usage: () => usage,
    call: () =>
      new Promise((r) => {
        resolve = r
      })
  })
  const cancelled = controller()
  const first = provider.enrich(
    { kind: 'artist', externalId: '42', language: 'en' },
    cancelled.signal
  )
  cancelled.abort(new Error('user cancelled'))
  resolve(response())
  await assert.rejects(first, /user cancelled/)
  const second = provider.enrich(
    { kind: 'artist', externalId: '42', language: 'en' },
    controller().signal
  )
  context = 'account-b'
  resolve(response())
  await assert.rejects(second, /provider_configuration_changed/)
})

test('public requests select a provider, never its external ID, account epoch, facts or arbitrary URL', () => {
  const payload = {
    entityId: 'entity',
    language: 'zh-Hans',
    batchId: 'batch',
    provider: 'platform.ncm'
  }
  assert.equal(validEntityMetadataPayload('metadata.entity.enrich', payload), true)
  for (const key of ['externalId', 'providerContext', 'facts', 'url'])
    assert.equal(
      validEntityMetadataPayload('metadata.entity.enrich', { ...payload, [key]: 'untrusted' }),
      false
    )
  assert.equal(
    validEntityMetadataPayload('metadata.entity.enrich', { ...payload, provider: 'musicbrainz' }),
    false
  )
  assert.equal(
    validEntityMetadataPayload('metadata.entity.detail', {
      entityId: 'entity',
      language: 'en',
      sourceProvider: 'ncm'
    }),
    true
  )
  assert.equal(
    validEntityMetadataPayload('metadata.entity.resolve', {
      ...payload,
      mbid: 'a223958d-5c56-4b2c-a30a-87e357bc121b'
    }),
    false
  )
})

test('new optional metadata methods are routed only to declared handlers and host registration includes them', () => {
  for (const method of ['fetchArtistMetadata', 'fetchAlbumMetadata'] as const) {
    const provider = {
      id: 'ncm',
      name: 'NCM',
      capabilities: ['library' as const, 'playlist' as const],
      supportedMethods: [method]
    }
    assert.equal(isTwilightMediaProviderMethod(method), true)
    assert.equal(providerSupportsMethod(provider, method), true)
    assert.equal(
      providerSupportsMethod({ ...provider, supportedMethods: undefined }, method),
      false
    )
    assert.equal(providerSupportsMethod({ ...provider, capabilities: [] }, method), false)
    assert.ok(
      readFileSync(new URL('../../main/plugins/host.ts', import.meta.url), 'utf8').includes(
        `'${method}'`
      )
    )
  }
  assert.equal(validPlatformMetadataResult(response()), true)
  assert.deepEqual(platformMetadataApprovals(undefined), {})
  assert.deepEqual(platformMetadataApprovals(JSON.stringify({ ncm: usage })), { ncm: usage })
  assert.throws(() => platformMetadataApprovals('{"ncm":true}'), /reviewed field permissions/)
})
