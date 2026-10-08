import { computed, readonly, ref } from 'vue'
import {
  DEFAULT_RADIO_STATIONS,
  MAX_RADIO_STATIONS,
  cloneRadioStationsDocument,
  isInsecureHttpUrl,
  isHttpOrHttpsUrl,
  type RadioStation,
  type RadioStationsDocument
} from '../../../shared/radioStations.ts'
import { isPersistentDataRevisionConflict } from '../../../shared/versionedPersistence.ts'
import type { Track } from '../types/music'

const document = ref<RadioStationsDocument>(cloneRadioStationsDocument(DEFAULT_RADIO_STATIONS))
const revision = ref(0)
const loading = ref<Promise<void> | null>(null)
const error = ref('')
let mutation: Promise<unknown> = Promise.resolve()

function applyDocument(next: RadioStationsDocument, nextRevision: number): void {
  if (nextRevision < revision.value) return
  document.value = cloneRadioStationsDocument(next)
  revision.value = nextRevision
}

async function ensureLoaded(): Promise<void> {
  if (loading.value) return loading.value
  loading.value = (async () => {
    try {
      const result = await window.api.radio.loadStations()
      if (!result?.data) throw new Error('无法读取当前电台，请稍后重试')
      applyDocument(result.data, result.revision)
      error.value = ''
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    }
  })().finally(() => {
    loading.value = null
  })
  return loading.value
}

async function persist(next: RadioStationsDocument, expectedRevision: number): Promise<void> {
  try {
    const saved = await window.api.radio.saveStations(next, expectedRevision)
    applyDocument(saved.data, saved.revision)
    error.value = ''
  } catch (err) {
    if (isPersistentDataRevisionConflict(err) && err.current) {
      applyDocument(err.current.data as RadioStationsDocument, err.current.revision)
    }
    error.value = err instanceof Error ? err.message : String(err)
    throw err
  }
}

/** Serialize read/modify/write operations so rapid actions keep every successful change. */
function mutateStations(
  update: (next: RadioStationsDocument) => number | Promise<number>
): Promise<number> {
  const result = mutation.then(async () => {
    try {
      await ensureLoaded()
      if (error.value) throw new Error(error.value)
      const next = cloneRadioStationsDocument(document.value)
      const expectedRevision = revision.value
      const changed = await update(next)
      if (changed) await persist(next, expectedRevision)
      return changed
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      throw err
    }
  })
  mutation = result.catch(() => {})
  return result
}

export function radioStationToTrack(station: RadioStation): Track {
  return {
    id: station.id,
    title: station.name,
    artist: '网络电台',
    album: 'Radio',
    filePath: station.streamUrl,
    fileName: station.name,
    duration: 0,
    size: 0,
    cover: station.favicon ?? null,
    lyrics: null,
    source: 'radio',
    streamUrl: station.streamUrl
  }
}

export function useRadioStore() {
  const stations = computed(() => document.value.stations)

  async function addStation(input: {
    name: string
    streamUrl: string
    homepage?: string
    tags?: string[]
    allowInsecureHttp?: boolean
  }): Promise<RadioStation> {
    const streamUrl = input.streamUrl.trim()
    if (!isHttpOrHttpsUrl(streamUrl)) throw new Error('电台地址无效')
    if (isInsecureHttpUrl(streamUrl) && !input.allowInsecureHttp) {
      throw new Error('HTTP 电台需要先确认允许明文流')
    }
    const now = new Date().toISOString()
    const station: RadioStation = {
      id: `radio_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name: input.name.trim().slice(0, 120) || '未命名电台',
      streamUrl,
      homepage: input.homepage?.trim() || undefined,
      tags: input.tags,
      allowInsecureHttp: isInsecureHttpUrl(streamUrl) ? true : Boolean(input.allowInsecureHttp),
      createdAt: now,
      updatedAt: now
    }
    await mutateStations((next) => {
      if (next.stations.some((item) => item.streamUrl === streamUrl)) {
        throw new Error('该电台已收藏')
      }
      if (next.stations.length >= MAX_RADIO_STATIONS) {
        throw new Error('电台数量已达上限，请先删除其他电台')
      }
      next.stations.unshift(station)
      return 1
    })
    return station
  }

  async function removeStation(id: string): Promise<void> {
    await mutateStations((next) => {
      const before = next.stations.length
      next.stations = next.stations.filter((station) => station.id !== id)
      return before - next.stations.length
    })
  }

  async function searchDirectory(
    query: string,
    options: { limit?: number; offset?: number } = {}
  ): Promise<
    Array<{
      stationuuid: string
      name: string
      url: string
      urlResolved: string
      homepage?: string
      favicon?: string
      tags: string[]
      countryCode?: string
      bitrate?: number
      codec?: string
      votes?: number
    }>
  > {
    return window.api.radio.searchDirectory({
      query,
      limit: options.limit,
      offset: options.offset
    })
  }

  async function importPlaylistText(
    text: string,
    options: { fileNameHint?: string; allowInsecureHttp?: boolean } = {}
  ): Promise<number> {
    return mutateStations(async (next) => {
      const imported = await window.api.radio.importPlaylist({
        text,
        fileNameHint: options.fileNameHint,
        allowInsecureHttp: options.allowInsecureHttp
      })
      const existingUrls = new Set(next.stations.map((station) => station.streamUrl))
      let added = 0
      for (const station of imported) {
        if (existingUrls.has(station.streamUrl)) continue
        next.stations.unshift(station)
        existingUrls.add(station.streamUrl)
        added++
      }
      if (next.stations.length > MAX_RADIO_STATIONS) {
        throw new Error('导入后电台数量将超过上限，请先删除其他电台或减少导入条目')
      }
      return added
    })
  }

  return {
    stations,
    revision: readonly(revision),
    error: readonly(error),
    ensureLoaded,
    addStation,
    removeStation,
    searchDirectory,
    importPlaylistText,
    radioStationToTrack
  }
}
