import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSidebarEntries, sidebarGroupId } from './sidebarNavigation.ts'
import {
  BUILTIN_NAVIGATION_PAGES,
  buildNavigationPages,
  createNavigationPageDraft,
  isNavigationPageVisible,
  moveNavigationPage,
  orderNavigationPages
} from './navigationPages.ts'

const defaults = { version: 1 as const, order: [], hidden: [] }
const visible = BUILTIN_NAVIGATION_PAGES.filter((page) => isNavigationPageVisible(page, defaults))

test('the default sidebar collects streaming and local pages into two compact branches', () => {
  const entries = buildSidebarEntries(visible)
  assert.deepEqual(
    entries.map((entry) => (entry.kind === 'page' ? entry.page.id : entry.id)),
    ['local-home', 'search', 'streaming', 'local-library', 'recent']
  )
  assert.deepEqual(
    entries
      .filter((entry) => entry.kind === 'group')
      .map((entry) => entry.pages.map((page) => page.id)),
    [
      ['streaming-home', 'discover', 'library', 'cloud'],
      ['allSongs', 'albums', 'artists', 'playlists', 'folders', 'genres']
    ]
  )
  assert.equal(visible[0].title, '主页')
  assert.equal(sidebarGroupId('recent'), undefined)
})

test('saved order determines branch placement and child order without mutating preferences', () => {
  const preferences = moveNavigationPage(
    createNavigationPageDraft(BUILTIN_NAVIGATION_PAGES, defaults),
    'albums',
    'local-home'
  )
  const entries = buildSidebarEntries(orderNavigationPages(BUILTIN_NAVIGATION_PAGES, preferences))
  assert.equal(entries[0].kind, 'group')
  if (entries[0].kind === 'group') {
    assert.equal(entries[0].id, 'local-library')
    assert.equal(entries[0].pages[0].id, 'albums')
  }
  assert.equal(preferences.order[0], 'albums')
  assert.equal(BUILTIN_NAVIGATION_PAGES[0].id, 'local-home')
})

test('hidden children and empty branches disappear, plugin pages retain independent identity', () => {
  const pages = buildNavigationPages([
    { pluginId: 'extension', id: 'cloud', title: 'Extension', kind: 'sidebarPage', command: 'open' }
  ])
  const preferences = { ...defaults, hidden: ['streaming-home', 'discover', 'library', 'cloud'] }
  const entries = buildSidebarEntries(
    pages.filter((page) => isNavigationPageVisible(page, preferences))
  )
  assert.ok(entries.every((entry) => entry.kind !== 'group' || entry.id !== 'streaming'))
  assert.equal(sidebarGroupId('plugin:extension:cloud'), undefined)
  assert.equal(entries.at(-1)?.kind, 'page')
  assert.deepEqual(buildSidebarEntries([]), [])
})

test('search follows home with a saved order while hidden entries and the input remain unchanged', () => {
  const pages = [
    visible.find((page) => page.id === 'search')!,
    ...visible.filter((page) => page.id !== 'search')
  ]
  const original = pages.map((page) => page.id)
  const entries = buildSidebarEntries(pages)
  assert.deepEqual(
    entries.slice(0, 2).map((entry) => entry.kind === 'page' && entry.page.id),
    ['local-home', 'search']
  )
  assert.deepEqual(
    pages.map((page) => page.id),
    original
  )
  assert.ok(
    buildSidebarEntries(pages.filter((page) => page.id !== 'search')).every(
      (entry) => entry.kind !== 'page' || entry.page.id !== 'search'
    )
  )
})
