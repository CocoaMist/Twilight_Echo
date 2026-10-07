import type { NavigationPageDefinition } from '@renderer/app/navigationPages.ts'
import type { ThemeIconSlot } from '../../../shared/theme.ts'

export type SidebarGroupId = 'streaming' | 'local-library'

interface SidebarGroup {
  id: SidebarGroupId
  title: string
  icon: ThemeIconSlot
}

export type SidebarEntry =
  | { kind: 'page'; page: NavigationPageDefinition }
  | (SidebarGroup & { kind: 'group'; pages: NavigationPageDefinition[] })

const groups: Record<SidebarGroupId, SidebarGroup> = {
  streaming: { id: 'streaming', title: '流媒体音乐', icon: 'navigation.streaming' },
  'local-library': { id: 'local-library', title: '音乐库', icon: 'navigation.songs' }
}
const membership = new Map<string, SidebarGroupId>([
  ...['streaming-home', 'discover', 'library', 'cloud', 'radio', 'network'].map(
    (id): [string, SidebarGroupId] => [id, 'streaming']
  ),
  ...['allSongs', 'albums', 'artists', 'playlists', 'folders', 'genres', 'analytics'].map(
    (id): [string, SidebarGroupId] => [id, 'local-library']
  )
])

export function sidebarGroupId(pageId: string): SidebarGroupId | undefined {
  return membership.get(pageId)
}

export function sidebarGroupTitle(pageId: string): string | undefined {
  const id = sidebarGroupId(pageId)
  return id ? groups[id].title : undefined
}

export function buildSidebarEntries(pages: NavigationPageDefinition[]): SidebarEntry[] {
  const result: SidebarEntry[] = []
  const entries = new Map<SidebarGroupId, Extract<SidebarEntry, { kind: 'group' }>>()
  for (const page of pages) {
    const id = sidebarGroupId(page.id)
    if (!id) {
      result.push({ kind: 'page', page })
      continue
    }
    let entry = entries.get(id)
    if (!entry) {
      entry = { kind: 'group', ...groups[id], pages: [] }
      entries.set(id, entry)
      result.push(entry)
    }
    entry.pages.push(page)
  }
  const homeIndex = result.findIndex(
    (entry) => entry.kind === 'page' && entry.page.id === 'local-home'
  )
  const searchIndex = result.findIndex(
    (entry) => entry.kind === 'page' && entry.page.id === 'search'
  )
  if (homeIndex >= 0 && searchIndex >= 0 && searchIndex !== homeIndex + 1) {
    const [search] = result.splice(searchIndex, 1)
    result.splice(searchIndex < homeIndex ? homeIndex : homeIndex + 1, 0, search)
  }
  return result
}
