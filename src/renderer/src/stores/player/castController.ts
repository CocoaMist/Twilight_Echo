import type { Ref } from 'vue'
import type { Track } from '../../types/music'

export function createCastController({
  currentTrack,
  currentTime,
  castTargetName,
  castTargetUsn,
  getRemoteApi,
  resolvePlayTarget,
  isCurrentTrackLiveStream,
  recordPlaybackStart
}: {
  currentTrack: Ref<Track | null>
  currentTime: Ref<number>
  castTargetName: Ref<string | null>
  castTargetUsn: Ref<string | null>
  getRemoteApi: () => typeof window.api.remote | undefined
  resolvePlayTarget: (track: Track) => Promise<string>
  isCurrentTrackLiveStream: () => boolean
  recordPlaybackStart: (track: Track) => void
}) {
  async function castCurrentTrackToDevice(usn: string): Promise<void> {
    const track = currentTrack.value
    if (!track) throw new Error('当前没有可投送的曲目')
    const remoteApi = getRemoteApi()
    if (!remoteApi?.castToDevice) throw new Error('远程控制 API 不可用')

    // Prefer a resolved local library / managed-cache path when available;
    // otherwise resolve the live stream URL (podcast / radio / provider) and
    // cast via the remote media token proxy. Provider streams may be
    // twilight-media:// grants — main resolves those to the real upstream.
    let filePath: string | undefined
    let mediaUrl: string | undefined
    const classifyCastTarget = (target: string): void => {
      if (!target) return
      if (target.startsWith('twilight-media:') || /^https?:\/\//i.test(target)) {
        mediaUrl = target
        return
      }
      // Local path (no scheme or file-like absolute path).
      if (!/^[a-z][a-z\d+.-]*:\/\//i.test(target)) {
        filePath = target
      }
    }
    try {
      classifyCastTarget(await resolvePlayTarget(track))
    } catch {
      // Fall through to direct fields when resolvePlayTarget fails.
    }
    if (!filePath && !mediaUrl) {
      classifyCastTarget(track.streamUrl || track.filePath || '')
    }
    if (!filePath && !mediaUrl) {
      throw new Error('当前曲目不支持投送（缺少本地路径或流地址）')
    }

    const result = await remoteApi.castToDevice({
      usn,
      ...(filePath ? { filePath } : { mediaUrl }),
      title: track.title,
      artist: track.artist,
      album: track.album,
      // Live radio: do not seek after load.
      positionSeconds: isCurrentTrackLiveStream() ? 0 : currentTime.value
    })
    castTargetUsn.value = result.usn
    castTargetName.value = result.friendlyName
    recordPlaybackStart(track)
    // Main process already dispatches a 'pause' shortcut for local engine.
  }

  async function stopCastSession(): Promise<void> {
    const remoteApi = getRemoteApi()
    if (remoteApi?.stopCast) await remoteApi.stopCast()
    castTargetUsn.value = null
    castTargetName.value = null
  }

  async function discoverCastDevices(): Promise<
    import('../../../../shared/remoteControl.ts').DlnaDeviceInfo[]
  > {
    const remoteApi = getRemoteApi()
    if (!remoteApi?.discoverDlna) return []
    return await remoteApi.discoverDlna()
  }

  async function refreshCastTarget(): Promise<void> {
    const remoteApi = getRemoteApi()
    if (!remoteApi?.getCastTarget) {
      castTargetUsn.value = null
      castTargetName.value = null
      return
    }
    const target = await remoteApi.getCastTarget()
    castTargetUsn.value = target?.usn ?? null
    castTargetName.value = target?.friendlyName ?? null
  }
  return { castCurrentTrackToDevice, stopCastSession, discoverCastDevices, refreshCastTarget }
}
