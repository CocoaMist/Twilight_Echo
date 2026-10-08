import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * Style-unification guardrail.
 *
 * The shared control primitives live as design tokens in `assets/base.css`
 * (`--te-control-*`, `--te-switch-*`, `--te-badge-*`) so every button, switch,
 * badge, field and dialog converges on one geometry/colour contract. Component
 * styles must consume those tokens rather than re-declaring their own literal
 * radii, heights or palette values. Without this guard the divergence the
 * inventory captured in `output/ui-inventory` would creep back in.
 */
const base = readFileSync(new URL('../assets/base.css', import.meta.url), 'utf8')
const settings = readFileSync(
  new URL('./settings-page/SettingsPage.css', import.meta.url),
  'utf8'
)
const hiFiSidebar = readFileSync(new URL('./player-bar/HiFiSidebar.css', import.meta.url), 'utf8')
const onboarding = readFileSync(
  new URL('./onboarding/OnboardingWizard.css', import.meta.url),
  'utf8'
)
const pluginPage = readFileSync(new URL('./PluginPage.vue', import.meta.url), 'utf8')
const radioPodcast = readFileSync(new URL('./RadioPodcastPage.vue', import.meta.url), 'utf8')
const networkSources = readFileSync(new URL('./NetworkSourcesPage.vue', import.meta.url), 'utf8')
const importDialog = readFileSync(new URL('./ImportDialog.vue', import.meta.url), 'utf8')
const trackInfoDialog = readFileSync(new URL('./TrackInfoDialog.vue', import.meta.url), 'utf8')
const queueWorkspace = readFileSync(
  new URL('./player-bar/QueueWorkspaceDialog.vue', import.meta.url),
  'utf8'
)

function rule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`))
  assert.ok(match, `expected a rule for ${selector}`)
  return match[1]
}

test('base.css owns the unified control token contract', () => {
  for (const token of [
    '--te-control-radius-sm',
    '--te-control-radius-md',
    '--te-control-radius-lg',
    '--te-control-radius-pill',
    '--te-control-height-sm',
    '--te-control-height-md',
    '--te-control-height-lg',
    '--te-control-height-field',
    '--te-control-pad-x-sm',
    '--te-control-pad-x-md',
    '--te-control-gap',
    '--te-control-focus-color',
    '--te-control-accent',
    '--te-control-danger',
    '--te-switch-width',
    '--te-switch-height',
    '--te-switch-thumb',
    '--te-switch-travel',
    '--te-badge-radius',
    '--te-badge-pad-x'
  ]) {
    assert.match(base, new RegExp(`${token}:`), `base.css must define ${token}`)
  }
  assert.match(base, /--te-dialog-radius:\s*16px;/)
})

test('the three switch families share one geometry contract', () => {
  for (const [name, style] of [
    ['.toggle-switch', settings],
    ['.deck-switch', hiFiSidebar],
    ['.onb-toggle', onboarding]
  ] as const) {
    const block = rule(style, name)
    assert.match(block, /--te-switch-width/, `${name} must use --te-switch-width`)
    assert.match(block, /--te-switch-height/, `${name} must use --te-switch-height`)
    assert.match(
      block,
      /--te-control-radius-pill/,
      `${name} must use the shared pill radius`
    )
  }
  // Knob geometry travels on the same tokens in every family.
  assert.match(
    rule(settings, '.toggle-switch::after'),
    /--te-switch-thumb/
  )
  assert.match(
    rule(hiFiSidebar, '.deck-switch-knob'),
    /--te-switch-thumb/
  )
  assert.match(
    rule(onboarding, '.onb-toggle::after'),
    /--te-switch-thumb/
  )
})

test('button, pill and badge families consume control tokens', () => {
  const pill = rule(settings, '.pill-action')
  assert.match(pill, /--te-control-height-sm/)
  assert.match(pill, /--te-control-radius-sm/)
  assert.match(pill, /--te-control-accent/)

  const networkPill = rule(networkSources, '.pill-action')
  assert.match(networkPill, /--te-control-height-sm/)
  assert.match(networkPill, /--te-control-radius-sm/)

  const pluginBadge = rule(pluginPage, '.badge')
  assert.match(pluginBadge, /--te-badge-font-size/)
  assert.match(pluginBadge, /--te-badge-radius/)

  const radioBadge = rule(radioPodcast, '.badge')
  assert.match(radioBadge, /--te-badge-radius/)
  assert.match(radioBadge, /--te-badge-pad-x/)

  const primary = rule(base, '.primary-button')
  assert.match(primary, /--te-control-accent/)
  assert.match(primary, /--te-control-radius-md/)
})

test('dialog surfaces derive their radius from the single dialog token', () => {
  for (const [name, source] of [
    ['.import-dialog', importDialog],
    ['.track-info-dialog', trackInfoDialog],
    ['.queue-workspace', queueWorkspace]
  ] as const) {
    assert.match(
      rule(source, name),
      /border-radius:\s*var\(--te-dialog-radius\)/,
      `${name} must use var(--te-dialog-radius)`
    )
  }
})
