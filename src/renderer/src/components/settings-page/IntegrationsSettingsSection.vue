<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import QRCode from 'qrcode'
import SettingsGroup from './SettingsGroup.vue'
import type { RemoteControlStatus } from '../../../../shared/remoteControl.ts'
import { useVisibleSettingsPolling } from './useVisibleSettingsPolling.ts'

const props = defineProps<{
  active?: boolean
  discordEnabled: boolean
  remoteEnabled: boolean
}>()

const emit = defineEmits<{
  'update:discordEnabled': [enabled: boolean]
  'update:remoteEnabled': [enabled: boolean]
}>()

const remoteStatus = ref<RemoteControlStatus | null>(null)
const remoteStatusError = ref('')
const remoteBusy = ref(false)
const remoteQrDataUrl = ref('')
const remoteQrUrl = ref('')
const discordStatus = ref<{
  enabled: boolean
  connected: boolean
  lastError: string | null
} | null>(null)
const notice = ref('')

async function refreshDiscordStatus(isCurrent: () => boolean): Promise<void> {
  try {
    if (!window.api?.discord?.getStatus) {
      if (isCurrent()) discordStatus.value = null
      return
    }
    const status = await window.api.discord.getStatus()
    if (isCurrent()) discordStatus.value = status
  } catch {
    if (isCurrent()) discordStatus.value = null
  }
}

const refreshConnectionStatuses = useVisibleSettingsPolling(
  () => props.active ?? true,
  8_000,
  async (isCurrent, reason) => {
    await Promise.all([
      reason !== 'poll' ? refreshRemoteStatus(isCurrent) : Promise.resolve(),
      reason !== 'poll' || props.discordEnabled
        ? refreshDiscordStatus(isCurrent)
        : Promise.resolve()
    ])
  }
)

watch(
  () => props.discordEnabled,
  () => void refreshConnectionStatuses()
)

const discordStatusText = computed(() => {
  if (!props.discordEnabled) return '已关闭'
  if (!discordStatus.value) return '状态未知'
  if (discordStatus.value.connected) return '已连接'
  return discordStatus.value.lastError
    ? `未连接：${discordStatus.value.lastError}`
    : '未连接（等待 Discord）'
})

async function refreshRemoteStatus(isCurrent: () => boolean): Promise<void> {
  remoteStatusError.value = ''
  try {
    if (!window.api?.remote?.getStatus) {
      if (isCurrent()) remoteStatus.value = null
      return
    }
    const status = await window.api.remote.getStatus()
    if (isCurrent()) remoteStatus.value = status
  } catch (err) {
    if (isCurrent()) remoteStatusError.value = err instanceof Error ? err.message : String(err)
  }
}

async function refreshRemoteQr(urls: string[] | undefined | null): Promise<void> {
  const primary = urls?.find((u) => typeof u === 'string' && u.trim()) ?? ''
  if (!primary) {
    remoteQrDataUrl.value = ''
    remoteQrUrl.value = ''
    return
  }
  if (primary === remoteQrUrl.value && remoteQrDataUrl.value) return
  try {
    remoteQrDataUrl.value = await QRCode.toDataURL(primary, {
      margin: 1,
      width: 160,
      errorCorrectionLevel: 'M'
    })
    remoteQrUrl.value = primary
  } catch {
    remoteQrDataUrl.value = ''
    remoteQrUrl.value = ''
  }
}

watch(
  () => remoteStatus.value?.urls,
  (urls) => {
    void refreshRemoteQr(urls)
  },
  { deep: true }
)

watch(
  () => props.remoteEnabled,
  (enabled) => {
    if (!enabled) {
      remoteQrDataUrl.value = ''
      remoteQrUrl.value = ''
    }
  }
)

function toggleDiscord(): void {
  emit('update:discordEnabled', !props.discordEnabled)
}

async function toggleRemote(): Promise<void> {
  remoteBusy.value = true
  remoteStatusError.value = ''
  try {
    const next = !props.remoteEnabled
    emit('update:remoteEnabled', next)
    if (window.api?.remote?.setEnabled) {
      remoteStatus.value = await window.api.remote.setEnabled(next)
    } else {
      await refreshConnectionStatuses()
    }
  } catch (err) {
    remoteStatusError.value = err instanceof Error ? err.message : String(err)
  } finally {
    remoteBusy.value = false
  }
}

async function rotateRemotePin(): Promise<void> {
  remoteBusy.value = true
  remoteStatusError.value = ''
  try {
    if (!window.api?.remote?.rotatePin) return
    const result = await window.api.remote.rotatePin()
    remoteStatus.value = result.status
  } catch (err) {
    remoteStatusError.value = err instanceof Error ? err.message : String(err)
  } finally {
    remoteBusy.value = false
  }
}

async function copyRemoteUrl(url: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(url)
    notice.value = '已复制远程地址'
  } catch {
    notice.value = url
  }
}
</script>

<template>
  <SettingsGroup
    id="external-connections"
    title="社交与远程控制"
    :summary="
      'Discord：' + discordStatusText + ' · 远程控制：' + (remoteEnabled ? '已开启' : '已关闭')
    "
    :attention="
      remoteStatusError ||
      remoteStatus?.lastError ||
      discordStatus?.lastError ||
      (remoteBusy ? '正在更新远程连接…' : '')
    "
    description="需要分享听歌状态，或从同一局域网的手机控制播放时展开。"
  >
    <div class="section-block">
      <h3>社交与远程控制</h3>
      <div class="setting-list">
        <div data-setting-id="discord" id="setting-discord" class="setting-item">
          <div class="setting-copy">
            <strong>Discord Rich Presence <i class="pi pi-discord discord-icon"></i></strong>
            <span>在 Discord 状态中向好友展示您正在播放的音乐。</span>
            <span class="setting-substatus" aria-live="polite">{{ discordStatusText }}</span>
          </div>
          <button
            type="button"
            aria-label="Discord Rich Presence"
            class="toggle-switch"
            :class="{ active: props.discordEnabled, inactive: !props.discordEnabled }"
            role="switch"
            :aria-checked="props.discordEnabled"
            @click="toggleDiscord"
          ></button>
        </div>
        <hr />
        <div
          data-setting-id="remote-control"
          id="setting-remote-control"
          class="setting-item top-align"
        >
          <div class="setting-copy">
            <strong>局域网远程控制</strong>
            <span>
              默认关闭。开启后在局域网提供 Web 遥控页（PIN 配对 + Token），并支持 DLNA 投送。
            </span>
          </div>
          <button
            type="button"
            aria-label="局域网远程控制"
            class="toggle-switch"
            :class="{
              active: props.remoteEnabled,
              inactive: !props.remoteEnabled
            }"
            role="switch"
            :aria-checked="props.remoteEnabled"
            :aria-busy="remoteBusy"
            @click="toggleRemote"
          ></button>
        </div>
        <div
          data-setting-id="remote-pairing"
          id="setting-remote-pairing"
          v-if="props.remoteEnabled"
          class="setting-item top-align remote-control-panel"
        >
          <div class="setting-copy">
            <strong>配对 PIN / 访问地址</strong>
            <span>
              状态：
              {{ remoteStatus?.running ? `运行中 · 端口 ${remoteStatus.port ?? '—'}` : '未运行' }}
              <template v-if="remoteStatus?.paired"> · 已配对</template>
              <template v-if="(remoteStatus?.clientCount ?? 0) > 0">
                · {{ remoteStatus?.clientCount }} 客户端
              </template>
            </span>
            <div v-if="remoteStatus?.pin" class="remote-pin-row">
              <code class="remote-pin">{{ remoteStatus.pin }}</code>
              <button
                type="button"
                class="soft-button"
                :disabled="remoteBusy"
                @click="rotateRemotePin"
              >
                更换 PIN
              </button>
              <button
                type="button"
                class="soft-button"
                :disabled="remoteBusy"
                @click="refreshConnectionStatuses()"
              >
                刷新
              </button>
            </div>
            <div
              v-if="remoteQrDataUrl || (remoteStatus?.urls?.length ?? 0) > 0"
              class="remote-access-row"
            >
              <div v-if="remoteQrDataUrl" class="remote-qr-block">
                <img
                  class="remote-qr"
                  :src="remoteQrDataUrl"
                  :alt="`远程控制二维码：${remoteQrUrl}`"
                  width="160"
                  height="160"
                />
                <span class="remote-qr-hint">手机扫码打开遥控页</span>
              </div>
              <ul v-if="(remoteStatus?.urls?.length ?? 0) > 0" class="remote-url-list">
                <li v-for="url in remoteStatus?.urls ?? []" :key="url">
                  <button type="button" class="linkish" @click="copyRemoteUrl(url)">
                    {{ url }}
                  </button>
                </li>
              </ul>
            </div>
            <span v-if="remoteStatus?.lastError" class="remote-error">
              {{ remoteStatus.lastError }}
            </span>
            <span v-if="remoteStatusError" class="remote-error">{{ remoteStatusError }}</span>
            <span v-if="notice" class="setting-substatus">{{ notice }}</span>
          </div>
        </div>
      </div>
    </div>
  </SettingsGroup>
</template>
