import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BUILTIN_NAVIGATION_PAGES,
  buildNavigationPages,
  createNavigationPageDraft,
  isNavigationPageVisible,
  moveNavigationPage,
  navigationTargetId,
  orderNavigationPages
} from './navigationPages.ts'
import { normalizeNavigationPagePreferences } from '../../../shared/navigationPages.ts'
import type { UiContribution } from '@renderer/extensions/registry'

const defaults = normalizeNavigationPagePreferences(undefined)
const plugin = (id: string): UiContribution => ({
  pluginId: id,
  id: 'page',
  kind: 'sidebarPage',
  title: id,
  command: 'open'
})
const ids = (preferences = defaults, pages = BUILTIN_NAVIGATION_PAGES) =>
  orderNavigationPages(pages, preferences)
    .filter((page) => isNavigationPageVisible(page, preferences))
    .map((page) => page.id)

test('the default directory has thirteen stable visible entries and the optional pages remain reachable', () => {
  assert.deepEqual(ids(), [
    'local-home',
    'streaming-home',
    'discover',
    'library',
    'cloud',
    'allSongs',
    'albums',
    'artists',
    'playlists',
    'folders',
    'genres',
    'search',
    'recent'
  ])
  assert.equal(BUILTIN_NAVIGATION_PAGES.length, 16)
  assert.equal(
    navigationTargetId({ kind: 'local', category: 'aggregate', filter: 'mix' }),
    'playlists'
  )
  assert.equal(navigationTargetId({ kind: 'streaming', tab: 'search' }), 'search')
})

test('draft moves, hides and cancellation never mutate saved preferences or navigate', () => {
  const draft = createNavigationPageDraft(BUILTIN_NAVIGATION_PAGES, defaults)
  const moved = moveNavigationPage(draft, 'recent', 'local-home')
  assert.equal(moved.order[0], 'recent')
  assert.equal(draft.order[0], 'local-home')
  const hidden = { ...moved, hidden: [...moved.order] }
  assert.deepEqual(ids(hidden), [])
  assert.equal(orderNavigationPages(BUILTIN_NAVIGATION_PAGES, hidden).length, 16)
  assert.deepEqual(defaults, { version: 1, order: [], hidden: [] })
  assert.deepEqual(ids(), ids(normalizeNavigationPagePreferences(undefined)))
})

test('disabled plugin slots and visibility survive editing, restoration and newly installed pages', () => {
  const all = buildNavigationPages([plugin('alpha'), plugin('beta')])
  const saved = moveNavigationPage(
    createNavigationPageDraft(all, defaults),
    'plugin:alpha:page',
    'search'
  )
  saved.hidden.push('plugin:alpha:page')
  const disabled = buildNavigationPages([plugin('beta')])
  const edited = createNavigationPageDraft(disabled, saved)
  assert.ok(edited.order.includes('plugin:alpha:page'))
  const restored = buildNavigationPages([plugin('beta'), plugin('alpha'), plugin('gamma')])
  assert.deepEqual(
    orderNavigationPages(restored, edited).map((page) => page.id),
    [...saved.order, 'plugin:gamma:page']
  )
  assert.equal(
    isNavigationPageVisible(restored.find((page) => page.id === 'plugin:alpha:page')!, edited),
    false
  )
  assert.equal(ids(edited, restored).at(-1), 'plugin:gamma:page')
})
