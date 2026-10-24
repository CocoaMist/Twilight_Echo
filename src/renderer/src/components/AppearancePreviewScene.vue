<script setup lang="ts">
import { onMounted, ref } from 'vue'
import TitleBar from './TitleBar.vue'
import SideMenu from './SideMenu.vue'
import OnlineHome from './local-dashboard/OnlineHome.vue'
import PlayerBar from './PlayerBar.vue'
import { workshopPreviewTracks } from './theme-workshop/workshopPreviewData'
import type { AppearanceDraft } from '../../../shared/appAppearance'
import type { AppBackgroundPage } from '../../../shared/appSettings'
import type { PlayerBarMode } from '../../../shared/playerBar'
import type { PlayerBarLayoutSettings } from '../../../shared/playerBarLayout'
import type { NavigationPagePreferences } from '../../../shared/navigationPages'
import type { NavigationPageDefinition } from '../app/navigationPages'
import { applyAppearanceReferenceMasks } from './appearanceReferenceMasks'

defineProps<{
  page?: AppBackgroundPage
  nowPlayingBackground?: 'blur' | 'fluid' | 'solid'
  navigationGlass: boolean
  playerGlass: boolean
  playerMode: PlayerBarMode
  navigationExpanded: boolean
  navigationPages: NavigationPagePreferences
  playerLayout: PlayerBarLayoutSettings
  appearance: AppearanceDraft
  pages?: NavigationPageDefinition[]
}>()
const scene = ref<HTMLElement>()
const defaultPreviewCover =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">' +
      '<defs>' +
      '<linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">' +
      '<stop offset="0%" stop-color="#1e293b"/>' +
      '<stop offset="48%" stop-color="#312e81"/>' +
      '<stop offset="100%" stop-color="#0f766e"/>' +
      '</linearGradient>' +
      '<radialGradient id="aurora" cx="72%" cy="28%" r="60%">' +
      '<stop offset="0%" stop-color="#38bdf8" stop-opacity="0.72"/>' +
      '<stop offset="55%" stop-color="#a855f7" stop-opacity="0.38"/>' +
      '<stop offset="100%" stop-color="#0f172a" stop-opacity="0"/>' +
      '</radialGradient>' +
      '<radialGradient id="warm" cx="24%" cy="78%" r="55%">' +
      '<stop offset="0%" stop-color="#f472b6" stop-opacity="0.52"/>' +
      '<stop offset="100%" stop-color="#1e1b4b" stop-opacity="0"/>' +
      '</radialGradient>' +
      '</defs>' +
      '<rect width="400" height="400" fill="url(#bg)"/>' +
      '<rect width="400" height="400" fill="url(#aurora)"/>' +
      '<rect width="400" height="400" fill="url(#warm)"/>' +
      '<circle cx="200" cy="186" r="92" fill="none" stroke="#e2e8f0" stroke-opacity="0.24" stroke-width="2"/>' +
      '<circle cx="200" cy="186" r="56" fill="none" stroke="#bae6fd" stroke-opacity="0.4" stroke-width="1.5"/>' +
      '<circle cx="200" cy="186" r="16" fill="#f8fafc" fill-opacity="0.85"/>' +
      '<path d="M56 312 Q144 268 228 302 T352 284" fill="none" stroke="#7dd3fc" stroke-opacity="0.45" stroke-width="3" stroke-linecap="round"/>' +
      '</svg>'
  )
// These are inert local examples, never a provider lookup or a personal library.
const sampleTracks = workshopPreviewTracks
  .slice(0, 12)
  .map((track) => ({ ...track, source: 'local' }))
const previewCover = sampleTracks[0]?.cover || defaultPreviewCover
// Pass the display component its own static data, without mounting the online
// dashboard's provider/account lifecycle. New local sections use the same props
// when the shared home component gains them.
const homePreview = {
  providers: [],
  provider: null,
  loading: false,
  loggedIn: false,
  error: '',
  tracks: [],
  localTracks: sampleTracks.slice(0, 6),
  localCount: sampleTracks.length,
  playlists: [],
  sectionTitle: '示例歌曲',
  playlistTitle: '示例歌单',
  recent: sampleTracks.slice(0, 6),
  hero: sampleTracks[0],
  isPlaying: false,
  pendingPlaylist: null
}
onMounted(() => {
  applyAppearanceReferenceMasks(scene.value)
})
</script>

<template>
  <div
    ref="scene"
    class="app-shell appearance-preview-scene"
    :data-preview-navigation="navigationExpanded ? 'expanded' : 'collapsed'"
    inert
    aria-hidden="true"
  >
    <div class="appearance-window-background">
      <div class="app-background-image" />
      <div class="app-background-dim" />
    </div>
    <div class="app-shell-title" data-preview-module="material">
      <TitleBar
        preview
        :menu-open="navigationExpanded"
        :glass="false"
        :liquid-material="navigationGlass"
      />
    </div>
    <div
      v-show="navigationExpanded"
      class="app-shell-navigation navigation-temporary"
      data-preview-module="navigation"
    >
      <SideMenu
        preview
        :open="navigationExpanded"
        active-key="local-home"
        :pages="pages"
        :preview-preferences="navigationPages"
        :liquid-material="navigationGlass"
      />
    </div>
    <div class="app-shell-content" data-preview-module="background">
      <main class="main-content" :class="{ 'menu-open': navigationExpanded }">
        <section
          v-if="page === 'player'"
          class="appearance-preview-player-stage"
          :data-preview-player-bg="nowPlayingBackground ?? 'blur'"
          aria-label="播放页预览"
        >
          <div class="appearance-preview-player-backdrop" aria-hidden="true">
            <img
              class="appearance-preview-player-cover-glow"
              :src="previewCover"
              alt=""
            />
            <div class="appearance-preview-player-fluid" />
            <div class="appearance-preview-player-scrim" />
          </div>
          <div class="appearance-preview-player-grid">
            <div class="appearance-preview-player-left">
              <div class="appearance-preview-cover-frame">
                <img
                  :src="previewCover"
                  :alt="sampleTracks[0]?.title ?? '夜空中的旋律'"
                />
              </div>
              <div class="appearance-preview-player-meta">
                <h2>{{ sampleTracks[0]?.title ?? '夜航星' }}</h2>
                <p>{{ sampleTracks[0]?.artist ?? 'Twilight Echo' }} · {{ sampleTracks[0]?.album ?? '星海回响' }}</p>
              </div>
            </div>
            <div class="appearance-preview-player-lyrics">
              <div class="appearance-preview-player-time">01:28 / 03:45</div>
              <p class="appearance-preview-lyric-line">穿过静谧的星河与微光</p>
              <div class="appearance-preview-lyric-line is-active">
                <p>
                  <span class="is-karaoke">在夜色中听见</span><span>遥远的回响</span>
                </p>
                <small class="appearance-preview-lyric-trans">Hearing the distant echo in the night</small>
              </div>
              <p class="appearance-preview-lyric-line">每一颗微尘都点亮航向</p>
              <p class="appearance-preview-lyric-line">直到黎明漫过天际线</p>
            </div>
          </div>
        </section>
        <OnlineHome v-else v-bind="homePreview" />
      </main>
    </div>
    <div class="app-shell-player" data-preview-module="player-bar">
      <PlayerBar
        preview
        :mode="playerMode"
        :left-navigation-open="navigationExpanded"
        :glass="false"
        :preview-track="sampleTracks[0]"
        preview-state="idle"
        :preview-appearance="appearance"
      />
    </div>
  </div>
</template>

<style src="./appearanceReferenceMasks.css" />
<style scoped>
.appearance-preview-player-stage {
  position: relative;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-height: 460px;
  padding: 28px 40px 96px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  isolation: isolate;
  color: var(--te-neutral-900);
}
.appearance-preview-player-backdrop {
  position: absolute;
  inset: 0;
  z-index: -1;
  overflow: hidden;
  background-color: var(--te-player-bg, var(--te-app-bg));
  background-image: var(--te-player-bg-image, var(--te-app-bg-image, none));
  background-size: cover;
  background-position: center;
}
:global(html[data-te-player-custom-background='on']) .appearance-preview-player-backdrop {
  display: none;
}
.appearance-preview-player-cover-glow {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transform: scale(1.12);
  filter: blur(46px) saturate(1.32);
  opacity: 0.62;
}
.appearance-preview-player-fluid {
  position: absolute;
  inset: -24%;
  opacity: 0;
  background:
    radial-gradient(
      circle at 22% 28%,
      color-mix(in srgb, var(--te-playback-accent) 52%, transparent),
      transparent 54%
    ),
    radial-gradient(
      circle at 78% 70%,
      color-mix(in srgb, var(--te-primary-500) 44%, transparent),
      transparent 58%
    );
  filter: blur(36px);
}
.appearance-preview-player-scrim {
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--te-player-bg, var(--te-app-bg)) 42%, transparent);
}
.appearance-preview-player-stage[data-preview-player-bg='fluid']
  .appearance-preview-player-cover-glow {
  opacity: 0.28;
  filter: blur(68px) saturate(1.55);
}
.appearance-preview-player-stage[data-preview-player-bg='fluid'] .appearance-preview-player-fluid,
:global(html[data-te-player-backdrop='fluid']) .appearance-preview-player-fluid {
  opacity: 0.9;
}
.appearance-preview-player-stage[data-preview-player-bg='solid']
  .appearance-preview-player-cover-glow {
  opacity: 0;
}
:global(html[data-te-player-backdrop='cover-blur']) .appearance-preview-player-cover-glow {
  opacity: 0.62;
  filter: blur(46px) saturate(1.32);
}
:global(html[data-te-player-backdrop='cover-blur']) .appearance-preview-player-fluid {
  opacity: 0;
}
:global(html[data-te-player-backdrop='solid']) .appearance-preview-player-cover-glow,
:global(html[data-te-player-backdrop='solid']) .appearance-preview-player-fluid,
:global(html[data-te-player-backdrop='image']) .appearance-preview-player-cover-glow,
:global(html[data-te-player-backdrop='image']) .appearance-preview-player-fluid {
  opacity: 0;
}
:global(html[data-te-player-backdrop='fluid']) .appearance-preview-player-cover-glow {
  filter: blur(68px) saturate(1.55);
  opacity: 0.32;
}
.appearance-preview-player-grid {
  width: min(
    100%,
    calc(
      320px + var(--te-lyric-cover-gap, var(--te-playback-stage-spread, 44px)) +
        var(--te-lyric-max-width, var(--te-playback-stage-span, 640px))
    )
  );
  display: grid;
  grid-template-columns: minmax(220px, 320px) minmax(260px, 1fr);
  gap: var(--te-lyric-cover-gap, var(--te-playback-stage-spread, 44px));
  align-items: center;
}
:global(html[data-te-player-stage-align='top']) .appearance-preview-player-grid {
  align-items: flex-start;
}
:global(html[data-te-player-stage-align='bottom']) .appearance-preview-player-grid {
  align-items: flex-end;
}
:global(html[data-te-player-layout='full-cover']) .appearance-preview-player-grid {
  width: min(100%, 1040px);
  grid-template-columns: minmax(280px, 420px) minmax(260px, 1fr);
}
:global(html[data-te-player-layout='lyrics-focus']) .appearance-preview-player-grid {
  grid-template-columns: minmax(150px, 210px) minmax(300px, 1fr);
}
:global(html[data-te-player-layout='minimal']) .appearance-preview-player-grid {
  grid-template-columns: minmax(260px, 420px);
  justify-content: center;
}
:global(html[data-te-player-layout='minimal']) .appearance-preview-player-lyrics {
  display: none;
}
:global(html[data-te-player-layout='split']) .appearance-preview-player-lyrics {
  padding: 24px 28px;
  border-radius: var(--te-radius-lg, 18px);
  background: color-mix(in srgb, var(--te-card-bg, var(--te-app-bg)) 72%, transparent);
  border: 1px solid var(--te-card-border, transparent);
}
.appearance-preview-player-left {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
}
.appearance-preview-cover-frame {
  width: min(
    100%,
    calc(260px * var(--te-playback-cover-size, var(--te-playback-cover-scale, 100%)) / 100%)
  );
  aspect-ratio: 1;
  border-radius: var(--te-playback-cover-radius, 20px);
  box-shadow: var(--te-playback-cover-shadow);
  overflow: hidden;
  border: 1px solid var(--te-playback-cover-border, transparent);
  background: var(--te-playback-cover-surface, var(--te-card-bg));
}
:global(html[data-te-artwork-shadow='off']) .appearance-preview-cover-frame {
  box-shadow: none;
}
:global(html[data-te-artwork-frame='subtle-ring']) .appearance-preview-cover-frame {
  border: 2px solid var(--te-playback-cover-border);
}
:global(html[data-te-artwork-frame='glass-frame']) .appearance-preview-cover-frame {
  padding: 10px;
  border: 1px solid var(--te-playback-cover-border);
  background: color-mix(in srgb, var(--te-card-bg) 45%, transparent);
  backdrop-filter: blur(16px);
}
:global(html[data-te-artwork-frame='glass-frame']) .appearance-preview-cover-frame img {
  border-radius: calc(var(--te-playback-cover-radius, 20px) - 6px);
}
:global(html[data-te-artwork-frame='polaroid']) .appearance-preview-cover-frame {
  padding: 12px 12px 34px;
  border: 1px solid var(--te-playback-cover-border);
  background: color-mix(in srgb, var(--te-playback-cover-surface, var(--te-card-bg)) 75%, transparent);
  backdrop-filter: blur(18px);
}
:global(html[data-te-artwork-frame='polaroid']) .appearance-preview-cover-frame img {
  border-radius: calc(max(0px, var(--te-playback-cover-radius, 20px) - 8px));
}
:global(html[data-te-artwork-frame='vinyl']) .appearance-preview-cover-frame,
:global(html[data-te-player-layout='vinyl']) .appearance-preview-cover-frame {
  border-radius: 999px;
  padding: 28px;
  border: 2px solid var(--te-playback-cover-border);
  background: radial-gradient(
    circle,
    var(--te-card-bg) 0%,
    color-mix(in srgb, var(--te-neutral-900) 82%, var(--te-app-bg)) 100%
  );
}
:global(html[data-te-artwork-frame='vinyl']) .appearance-preview-cover-frame img,
:global(html[data-te-player-layout='vinyl']) .appearance-preview-cover-frame img,
:global(html[data-te-artwork-spin='on']) .appearance-preview-cover-frame img {
  border-radius: 999px;
}
.appearance-preview-cover-frame img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.appearance-preview-player-meta {
  width: 100%;
  max-width: 260px;
  text-align: left;
}
:global(html[data-te-player-title-align='center']) .appearance-preview-player-meta {
  text-align: center;
}
.appearance-preview-player-meta h2 {
  margin: 0 0 6px;
  font-family: var(--te-font-display, var(--te-font-sans));
  font-size: 22px;
  font-weight: 700;
  color: var(--te-neutral-900);
}
.appearance-preview-player-meta p {
  margin: 0;
  font-size: 13px;
  color: var(--te-neutral-600);
}
.appearance-preview-player-lyrics {
  display: flex;
  flex-direction: column;
  gap: var(--te-playback-lyric-density, 14px);
  font-family: var(--te-font-rounded, var(--te-font-sans));
  text-align: left;
}
:global(html[data-te-player-lyrics-align='center']) .appearance-preview-player-lyrics,
:global(html[data-te-player-lyrics-align='follow'][data-te-player-title-align='center'])
  .appearance-preview-player-lyrics {
  text-align: center;
  align-items: center;
}
:global(html[data-te-player-lyrics-align='right']) .appearance-preview-player-lyrics {
  text-align: right;
  align-items: flex-end;
}
.appearance-preview-player-time {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  padding: 4px 12px;
  border-radius: 999px;
  background: var(--te-player-time-surface, var(--te-playback-control-surface));
  color: var(--te-playback-control-text, var(--te-neutral-700));
  border: 1px solid var(--te-playback-control-border, transparent);
  font-family: var(--te-font-mono);
  font-size: 12px;
}
:global(html[data-te-player-lyrics-align='center']) .appearance-preview-player-time,
:global(html[data-te-player-lyrics-align='follow'][data-te-player-title-align='center'])
  .appearance-preview-player-time {
  align-self: center;
}
:global(html[data-te-player-lyrics-align='right']) .appearance-preview-player-time {
  align-self: flex-end;
}
:global(html[data-te-player-time-style='minimal']) .appearance-preview-player-time {
  background: transparent;
  border-color: transparent;
  padding-inline: 0;
}
:global(html[data-te-player-time-style='glass']) .appearance-preview-player-time {
  backdrop-filter: blur(12px);
  border: 1px solid var(--te-playback-cover-border);
}
.appearance-preview-lyric-line {
  margin: 0;
  font-size: 16px;
  line-height: 1.5;
  color: var(--te-playback-lyric-text, var(--te-neutral-500));
  opacity: var(--te-playback-lyric-inactive-opacity, 66%);
  filter: blur(var(--te-playback-lyric-inactive-blur, 0px));
  padding: 6px 12px;
  border-radius: 12px;
}
.appearance-preview-lyric-line.is-active {
  font-size: calc(21px * var(--te-playback-lyric-active-scale, 102%) / 100%);
  font-weight: 700;
  color: var(--te-playback-lyric-active-text, var(--te-neutral-900));
  opacity: 1;
  filter: none;
}
.appearance-preview-lyric-line.is-active p {
  margin: 0;
}
.appearance-preview-lyric-line.is-active .is-karaoke {
  color: var(--te-playback-lyric-karaoke, var(--te-playback-lyric-active-text));
}
:global(html[data-te-player-lyric-highlight='surface']) .appearance-preview-lyric-line.is-active {
  background: var(--te-playback-lyric-active-surface, color-mix(in srgb, var(--te-playback-accent) 14%, transparent));
  border: 1px solid var(--te-playback-lyric-active-border, transparent);
}
:global(html[data-te-player-lyric-highlight='glow']) .appearance-preview-lyric-line.is-active {
  background: var(--te-playback-lyric-active-surface, color-mix(in srgb, var(--te-playback-accent) 12%, transparent));
  backdrop-filter: blur(14px);
  box-shadow: var(--te-playback-lyric-active-shadow);
  text-shadow: 0 0 18px color-mix(in srgb, var(--te-playback-accent) 48%, transparent);
}
.appearance-preview-lyric-trans {
  display: block;
  margin-top: 4px;
  font-size: calc(13px * var(--te-playback-lyric-scale, 100%) / 100%);
  font-weight: 500;
  color: var(--te-playback-lyric-translation);
}
</style>
