import {
  isRecord,
  PERSONAL_STORAGE_KEYS,
  validatePersonalDomain,
  mergePersonalDomain,
  type PersonalData
} from '../../../shared/personalBackup.ts'
import { ListeningStatsDatabase } from '../stores/listeningStatsDatabase.ts'
import type { ListeningStats } from '../stores/useListeningStatsStore.ts'

export function readPersonalRendererData(): PersonalData {
  return Object.fromEntries(
    Object.entries(PERSONAL_STORAGE_KEYS).flatMap(([domain, key]) => {
      const raw = localStorage.getItem(key)
      return raw === null ? [] : [[domain, JSON.parse(raw)]]
    })
  )
}
export async function applyPersonalRendererRestore(): Promise<void> {
  const request = await window.api.data.readRendererRestore()
  if (request === null) return
  if (
    !isRecord(request) ||
    typeof request.id !== 'string' ||
    !isRecord(request.data) ||
    !['keep-local', 'use-backup'].includes(String(request.conflict))
  )
    throw new Error('个人数据恢复请求无效')
  const markerKey = 'twilight.personal-restore-applied'
  if (localStorage.getItem(markerKey) !== request.id) {
    const previous = new Map<string, string | null>()
    const current = readPersonalRendererData()
    const database =
      typeof indexedDB === 'undefined' || !('statistics' in request.data)
        ? null
        : new ListeningStatsDatabase(indexedDB)
    const writes: [string, string][] = []
    let statistics: ListeningStats | undefined
    let statisticsCommitted = false
    try {
      const previousStatistics = await database?.load()
      if (previousStatistics) current.statistics = previousStatistics
      for (const domain of ['statistics', 'versions'] as const) {
        if (!(domain in request.data)) continue
        const result = mergePersonalDomain(
          domain,
          current[domain],
          request.data[domain],
          request.conflict as 'keep-local' | 'use-backup'
        )
        if (!validatePersonalDomain(domain, result)) throw new Error('统计或版本关系恢复校验失败')
        if (domain === 'statistics' && database) statistics = result as ListeningStats
        else writes.push([PERSONAL_STORAGE_KEYS[domain], JSON.stringify(result)])
      }
      if (statistics && database) {
        database.invalidate()
        await database.save(statistics)
        statisticsCommitted = true
      }
      for (const [key, value] of writes) {
        previous.set(key, localStorage.getItem(key))
        localStorage.setItem(key, value)
      }
      localStorage.setItem(markerKey, request.id)
    } catch (e) {
      for (const [key, value] of previous) {
        if (value === null) localStorage.removeItem(key)
        else localStorage.setItem(key, value)
      }
      if (statisticsCommitted && database) {
        database.invalidate()
        await database.save((current.statistics ?? { days: {}, tracks: {} }) as ListeningStats)
      }
      throw e
    } finally {
      await database?.close()
    }
  }
  await window.api.data.acknowledgeRendererRestore(request.id)
}
