import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./PlaybackSettingsSection.vue', import.meta.url), 'utf8')

test('automatic exclusive release uses the persisted setting and an accessible dependent switch', () => {
  assert.match(source, /audioExclusiveAutoRelease: !settings\.value\.audioExclusiveAutoRelease/)
  assert.match(source, /aria-label="独占模式自动启停"/)
  assert.match(source, /:aria-checked="settings\.audioExclusiveAutoRelease"/)
  assert.match(
    source,
    /:disabled="!exclusiveAvailable \|\| !exclusiveMode \|\| exclusiveAutoReleaseApplying"/
  )
  assert.match(source, /outputInfo\?\.outputReleased && playbackInfo\?\.state === 'paused'/)
})

test('playback diagnostics expose the active PCM provider implementation', () => {
  assert.match(
    source,
    /const outputProviderImplementation = computed\(\s*\(\) => outputInfo\.value\?\.providerImplementation \?\? ''\s*\)/
  )
  assert.match(
    source,
    /<span v-if="outputProviderImplementation">[\s\S]*Provider \{\{ outputProviderImplementation \}\}/
  )
})

test('released output replaces playback proof and the HiFi occupancy label', () => {
  const playerBar = readFileSync(new URL('../PlayerBar.vue', import.meta.url), 'utf8')
  const sidebar = readFileSync(new URL('../player-bar/HiFiSidebar.vue', import.meta.url), 'utf8')
  assert.match(playerBar, /if \(outputInfo\.value\?\.outputReleased\) \{\s*return \[/)
  assert.match(playerBar, /:output-released="outputInfo\?\.outputReleased"/)
  assert.match(sidebar, /if \(props\.outputReleased\) return `\$\{backend\} · RELEASED`/)
})
