import {
  isRecord,
  PERSONAL_STORAGE_KEYS,
  validatePersonalDomain,
  mergePersonalDomain,
  type PersonalData
} from '../../../shared/personalBackup.ts'

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
    const writes: [string, string][] = []
    for (const domain of ['statistics', 'versions'] as const) {
      if (!(domain in request.data)) continue
      const result = mergePersonalDomain(
        domain,
        current[domain],
        request.data[domain],
        request.conflict as 'keep-local' | 'use-backup'
      )
      if (!validatePersonalDomain(domain, result)) throw new Error('统计或版本关系恢复校验失败')
      writes.push([PERSONAL_STORAGE_KEYS[domain], JSON.stringify(result)])
    }
    try {
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
      throw e
    }
  }
  await window.api.data.acknowledgeRendererRestore(request.id)
}
