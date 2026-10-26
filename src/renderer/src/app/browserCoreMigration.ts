import {
  CORE_STATE_DOMAINS,
  coreStateBatches,
  emptyCoreStateCounts,
  type CoreMigrationManifest,
  type CoreMigrationStatus,
  type CoreStateApi,
  type CoreStateDomain,
  type CoreStateRow
} from '../../../shared/coreState.ts'
import { isRecord, validatePersonalDomain } from '../../../shared/personalBackup.ts'

type MigrationApi = Pick<
  CoreStateApi,
  'coreStateStatus' | 'coreMigrationBegin' | 'coreMigrationStage' | 'coreMigrationCommit'
>
export interface BrowserMusicMigrationSource {
  counts(): Promise<Record<CoreStateDomain, number>>
  pages(domain: CoreStateDomain): AsyncIterable<CoreStateRow[]>
  close(): Promise<void>
}

/**
 * One-shot client in the normal window. freezeBusinessWrites must take effect
 * before constructing/reading the source and stays in effect on failure. It is
 * released by switching to Core projections, never by reviving old writers.
 */
export async function migrateBrowserMusicData(options: {
  api: MigrationApi
  storage: Pick<Storage, 'getItem' | 'setItem'>
  freezeBusinessWrites(): void
  source(): Promise<BrowserMusicMigrationSource>
  newId(): string
}): Promise<CoreMigrationStatus> {
  options.freezeBusinessWrites()
  const status = await options.api.coreStateStatus()
  if (status.complete) return status
  const source = await options.source()
  try {
    const manifest: CoreMigrationManifest = { version: 1, counts: await source.counts() }
    const key = 'twilight.core-migration.session.v1'
    const id = status.id ?? options.storage.getItem(key) ?? options.newId()
    options.storage.setItem(key, id)
    const started = await options.api.coreMigrationBegin(id, manifest)
    if (started.complete) return started
    let batch = 0
    for (const domain of CORE_STATE_DOMAINS)
      for await (const rows of coreStateBatches(domain, source.pages(domain))) {
        // Re-send only explicitly idempotent migration stages. A changed source
        // cannot overwrite a previous batch: the database compares its content.
        await options.api.coreMigrationStage(id, batch++, domain, rows)
      }
    const committed = await options.api.coreMigrationCommit(id)
    if (!committed.complete) throw new Error('Core did not confirm migration publication')
    options.storage.setItem('twilight.core-migration.complete.v1', id)
    return committed
  } finally {
    await source.close()
  }
}

/** Read-only legacy source; no localStorage key or IndexedDB record is removed. */
export async function openBrowserMusicMigrationSource(
  storage: Pick<Storage, 'getItem'>,
  factory?: IDBFactory
): Promise<BrowserMusicMigrationSource> {
  const rows = new Map<CoreStateDomain, CoreStateRow[]>(
    CORE_STATE_DOMAINS.map((domain) => [domain, []])
  )
  const parse = (key: string) => {
    const raw = storage.getItem(key)
    return raw === null ? null : (JSON.parse(raw) as unknown)
  }
  const versions = parse('twilight.music-versions.v1')
  if (versions !== null) {
    if (!validatePersonalDomain('versions', versions))
      throw new Error('旧版本关系校验失败；原数据已保留')
    const document = versions as {
      tracks: { versions: { id: string }[]; families: { id: string }[] }
      albums: { versions: { id: string }[]; families: { id: string }[] }
    }
    for (const scope of ['tracks', 'albums'] as const)
      for (const kind of ['versions', 'families'] as const)
        for (const value of document[scope][kind])
          rows.get('versions')!.push({ key: `${scope}:${kind}:${value.id}`, value })
  }
  const inbox = parse('twilight.library-inbox.v1')
  if (inbox !== null) {
    if (!isRecord(inbox) || inbox.version !== 1 || !Array.isArray(inbox.entries))
      throw new Error('旧整理记录格式无效')
    // Preserve the existing last-20,000 decision retention and last-write wins semantics.
    const decisions = new Map<string, unknown>()
    for (const entry of inbox.entries.slice(-20000))
      if (
        Array.isArray(entry) &&
        typeof entry[0] === 'string' &&
        isRecord(entry[1]) &&
        typeof entry[1].fingerprint === 'string' &&
        ['ignored', 'done'].includes(String(entry[1].status))
      )
        decisions.set(entry[0], { fingerprint: entry[1].fingerprint, status: entry[1].status })
    rows.set(
      'inbox',
      [...decisions].map(([key, value], index) => ({
        key,
        value: { ...(value as Record<string, unknown>), order: index + 1 }
      }))
    )
  }
  const rate = storage.getItem('twilight.podcast.defaultPlaybackRate')
  if (rate !== null) {
    const value = Number(rate)
    if (!Number.isFinite(value) || value < 0.5 || value > 2) throw new Error('旧播客速度无效')
    rows.get('podcast-preferences')!.push({ key: 'defaultPlaybackRate', value })
  }
  const automatic = storage.getItem('twilight-echo:eq-auto-preamp:v1')
  if (automatic !== null)
    rows.get('eq-preferences')!.push({ key: 'autoPreamp', value: automatic === '1' })
  const manual = storage.getItem('twilight-echo:eq-manual-preamp:v1')
  if (manual !== null) {
    const value = Number(manual)
    if (!Number.isFinite(value)) throw new Error('旧 EQ 前级偏好无效')
    rows.get('eq-preferences')!.push({ key: 'manualPreamp', value })
  }
  const database = factory ? await openExistingHistory(factory) : null
  let history: { count: number; days: unknown } | null = null
  try {
    if (database) {
      const transaction = database.transaction(['tracks', 'meta'])
      const [days, count] = await Promise.all([
        idbResult(transaction.objectStore('meta').get('days')),
        idbResult(transaction.objectStore('tracks').count())
      ])
      if (days !== undefined || count > 0) history = { count, days: days ?? {} }
    }
    if (history) {
      if (
        !isRecord(history.days) ||
        !Object.values(history.days).every(
          (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
        )
      )
        throw new Error('旧 IndexedDB 日期统计无效')
      rows.set(
        'statistics-days',
        Object.entries(history.days).map(([key, value]) => ({ key, value }))
      )
    } else {
      const legacy = parse('twilight-echo:listening-stats:v1')
      if (legacy !== null) {
        if (!validatePersonalDomain('statistics', legacy)) throw new Error('旧收听统计校验失败')
        const statistics = legacy as {
          days: Record<string, number>
          tracks: Record<string, unknown>
        }
        rows.set(
          'statistics-days',
          Object.entries(statistics.days).map(([key, value]) => ({ key, value }))
        )
        rows.set(
          'statistics-tracks',
          Object.entries(statistics.tracks).map(([key, value]) => ({ key, value }))
        )
      }
    }
  } catch (error) {
    database?.close()
    throw error
  }
  for (const page of rows.values())
    page.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const counts = emptyCoreStateCounts()
  for (const domain of CORE_STATE_DOMAINS) counts[domain] = rows.get(domain)!.length
  if (history) counts['statistics-tracks'] = history.count
  return {
    async counts() {
      return { ...counts }
    },
    async *pages(domain) {
      if (domain === 'statistics-tracks' && history && database) {
        let after: IDBValidKey | undefined
        for (;;) {
          const store = database.transaction('tracks').objectStore('tracks')
          const range = after === undefined ? undefined : IDBKeyRange.lowerBound(after, true)
          const [keys, values] = await Promise.all([
            idbResult(store.getAllKeys(range, 128)),
            idbResult(store.getAll(range, 128))
          ])
          if (keys.length)
            yield keys.map((key, index) => ({ key: String(key), value: values[index] }))
          if (keys.length < 128) break
          after = keys.at(-1)
        }
      } else {
        const entries = rows.get(domain)!
        for (let offset = 0; offset < entries.length; offset += 128)
          yield entries.slice(offset, offset + 128)
      }
    },
    async close() {
      database?.close()
    }
  }
}
function idbResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
function openExistingHistory(factory: IDBFactory): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    let missing = false
    const request = factory.open('twilight-echo:listening-stats:v2', 1)
    request.onupgradeneeded = () => {
      missing = true
      request.transaction!.abort()
    }
    request.onsuccess = () => {
      if (
        !request.result.objectStoreNames.contains('tracks') ||
        !request.result.objectStoreNames.contains('meta')
      ) {
        request.result.close()
        reject(new Error('旧 IndexedDB 结构不完整'))
        return
      }
      resolve(request.result)
    }
    request.onerror = () => (missing ? resolve(null) : reject(request.error))
    request.onblocked = () => reject(new Error('旧收听统计数据库正被其他窗口占用'))
  })
}
