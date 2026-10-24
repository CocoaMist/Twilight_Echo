import { shallowRef } from 'vue'
import type { EntityMetadataPolicyView } from '../../../../shared/entityMetadata.ts'
import type { MusicIdentificationSettings } from '../../../../shared/musicIdentificationSchedule.ts'

const reasons: Record<string, string> = {
  metadata_disabled: '此版本未启用在线资料',
  public_service_not_approved: '此版本尚未批准使用公共资料服务',
  missing_application_contact: '应用未配置公共服务联系信息',
  provider_disabled: '平台插件未启用',
  provider_not_available: '平台插件不可用',
  provider_method_not_supported: '平台不支持此识别能力',
  metadata_capability_not_supported: '平台不支持此资料能力',
  platform_metadata_cache_not_approved: '平台文字展示与缓存权限尚未获批',
  platform_metadata_permission_expired: '平台资料使用权限已到期',
  commons_images_not_permitted: '此版本尚未启用人物公共图片',
  caa_artwork_cache_not_approved: '专辑图片展示与缓存权限尚未获批或已到期',
  caa_artwork_cross_source_not_approved: '专辑图片尚未获准跨来源使用',
  source_not_registered: '当前没有此资料源适配器'
}
export const metadataReason = (reason: string) => reasons[reason] ?? `暂不可用（${reason}）`
const kinds = { artist: '艺人', recording: '歌曲', album_project: '专辑作品', release: '具体发行' }

export function metadataSourceOptions(policy: EntityMetadataPolicyView | null, selected: string[]) {
  const sources = policy?.sources ?? []
  return [...new Set([...sources.map((s) => s.provider), ...selected])].map((provider) => {
    const source = sources.find((s) => s.provider === provider)
    const groups = new Map<string, string[]>()
    const capabilities = [
      ...(source?.identification.map((c) => ({ ...c, label: '识别' })) ?? []),
      ...(source?.enrichment.map((c) => ({
        ...c,
        label: c.provider === 'public-artwork' ? '图片' : '资料'
      })) ?? [])
    ]
    for (const c of capabilities) {
      const label = c.reason ? `${c.label} · ${metadataReason(c.reason)}` : `${c.label}可用`
      const list = groups.get(label) ?? []
      if (!list.includes(kinds[c.kind])) list.push(kinds[c.kind])
      groups.set(label, list)
    }
    return {
      provider,
      label:
        provider === 'musicbrainz'
          ? 'MusicBrainz / Wikipedia / 公共图片'
          : `平台 · ${provider.replace(/^platform\./, '')}`,
      available: capabilities.some((c) => !c.reason),
      descriptions: groups.size
        ? [...groups].map(([label, list]) => `${label}：${list.join('、')}`)
        : [
            source
              ? '未提供音乐库识别或资料能力'
              : policy
                ? metadataReason('source_not_registered')
                : '尚未读取资料源能力'
          ]
    }
  })
}

/** Settings stay authoritative in the original queued settings store, not in this view. */
export function createMusicMetadataSettings(api: {
  current(): MusicIdentificationSettings
  save(settings: MusicIdentificationSettings): Promise<unknown>
  policy(signal: AbortSignal): Promise<EntityMetadataPolicyView>
}) {
  const state = shallowRef({
    policy: null as EntityMetadataPolicyView | null,
    loading: false,
    saving: false,
    policyError: '',
    error: '',
    notice: ''
  })
  let request: AbortController | null = null
  let disposed = false
  async function refresh() {
    if (disposed) return
    request?.abort()
    const work = new AbortController()
    request = work
    state.value = { ...state.value, loading: true, policyError: '' }
    try {
      const policy = await api.policy(work.signal)
      if (!disposed && request === work) state.value = { ...state.value, policy, loading: false }
    } catch (error) {
      if (!disposed && request === work)
        state.value = {
          ...state.value,
          policy: null,
          loading: false,
          policyError: String(error instanceof Error ? error.message : error)
        }
    }
  }
  async function change(patch: Partial<MusicIdentificationSettings>) {
    if (disposed || state.value.saving) return
    const next = { ...api.current(), ...patch }
    if (patch.language === undefined && Object.hasOwn(patch, 'language')) delete next.language
    state.value = { ...state.value, saving: true, error: '', notice: '' }
    try {
      await api.save(next)
      if (!disposed) state.value = { ...state.value, notice: '已保存' }
    } catch (error) {
      if (!disposed)
        state.value = {
          ...state.value,
          error: `设置保存未确认，请核对当前值：${error instanceof Error ? error.message : String(error)}`
        }
    } finally {
      if (!disposed) state.value = { ...state.value, saving: false }
    }
  }
  return {
    state,
    refresh,
    scope: (scope: 'newImports' | 'history') => change({ [scope]: !api.current()[scope] }),
    language: (language: MusicIdentificationSettings['language']) => change({ language }),
    source(provider: string, selected: boolean) {
      if (disposed || state.value.saving) return Promise.resolve()
      const current = api.current().sources
      if (selected) {
        if (state.value.loading) return Promise.resolve()
        if (
          !metadataSourceOptions(state.value.policy, current).some(
            (s) => s.provider === provider && s.available
          )
        )
          return Promise.resolve()
        if (!current.includes(provider) && current.length >= 16) {
          state.value = {
            ...state.value,
            error: '最多选择 16 个资料源，请先取消一个。',
            notice: ''
          }
          return Promise.resolve()
        }
      }
      return change({
        sources: selected
          ? [...new Set([...current, provider])]
          : current.filter((s) => s !== provider)
      })
    },
    dispose() {
      disposed = true
      request?.abort()
      request = null
    }
  }
}
