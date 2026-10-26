import assert from 'node:assert/strict'
import test from 'node:test'
import { h, shallowRef } from 'vue'
import { component, mount, settle } from '../music-ratings/ratingsTestRenderer.ts'
import * as model from './libraryHealthView.ts'
import * as reasons from '../music-metadata/metadataTasksView.ts'
import {
  HEALTH_CATEGORIES,
  HEALTH_STATES,
  type LibraryHealthIssue,
  type LibraryHealthState
} from '../../../../shared/libraryHealth.ts'

function fixture() {
  const snapshot: LibraryHealthState = {
    phase: 'ready',
    inspected: 8,
    error: '',
    repair: null,
    report: {
      id: 'report',
      checkedAt: Date.now(),
      libraryRevision: 1,
      catalogRevision: 2,
      metadataRevision: 3,
      language: 'zh-Hans',
      totals: { tracks: 1, artists: 2, albums: 1, releases: 1 },
      policy: { enabled: true, identity: true, introduction: true, reason: null },
      metrics: Object.fromEntries(
        HEALTH_CATEGORIES.map((category) => [
          category,
          {
            total: 2,
            present: 1,
            hidden: 0,
            missing: 1,
            repairable: category === 'artist_intro' ? 1 : 0
          }
        ])
      ) as NonNullable<LibraryHealthState['report']>['metrics'],
      states: Object.fromEntries(
        HEALTH_STATES.map((s) => [s, s === 'unavailable' || s === 'ready' ? 1 : 0])
      ) as NonNullable<LibraryHealthState['report']>['states']
    }
  }
  const issues: LibraryHealthIssue[] = [
    {
      index: 0,
      category: 'artist_intro',
      state: 'ready',
      title: 'Artist',
      subtitle: '',
      reason: '可补简介',
      canRepair: true,
      entity: { id: 'artist', kind: 'artist', title: 'Artist', artist: '' }
    },
    {
      index: 1,
      category: 'artist_image',
      state: 'unavailable',
      title: 'Artist',
      subtitle: '',
      reason: '资料源暂无许可图片',
      canRepair: false,
      entity: { id: 'artist', kind: 'artist', title: 'Artist', artist: '' }
    }
  ]
  const calls: Array<{ name: string; input?: unknown }> = []
  const api = {
    status: async () => {
      calls.push({ name: 'status' })
      return structuredClone(snapshot)
    },
    start: async () => {
      calls.push({ name: 'start' })
      return structuredClone(snapshot)
    },
    repair: async (input) => {
      calls.push({ name: 'repair', input })
      return { ...structuredClone(snapshot), phase: 'repairing' as const }
    },
    page: async (query) => {
      calls.push({ name: 'page', input: query })
      const filtered = issues.filter(
        (i) =>
          (!query.category || i.category === query.category) &&
          (!query.state || i.state === query.state)
      )
      return { id: query.id, total: filtered.length, offset: query.offset ?? 0, items: filtered }
    }
  } satisfies Parameters<typeof model.createLibraryHealthView>[0]
  return { api, calls, snapshot, issues }
}

test('opening an existing health report never starts networking; filters are bounded Core pages', async (t) => {
  const f = fixture(),
    view = model.createLibraryHealthView(f.api)
  t.after(view.dispose)
  await view.open()
  assert.deepEqual(
    f.calls.map((c) => c.name),
    ['status', 'page']
  )
  await view.filter('artist_image', 'unavailable')
  assert.equal(view.state.value.page?.total, 1)
  assert.deepEqual(f.calls.at(-1)?.input, {
    id: 'report',
    category: 'artist_image',
    state: 'unavailable',
    offset: 0,
    limit: 20
  })
  await view.repair('artist_intro')
  assert.deepEqual(f.calls.find((c) => c.name === 'repair')?.input, {
    id: 'report',
    category: 'artist_intro'
  })
  assert.equal(view.state.value.snapshot?.phase, 'repairing')
})

test('lost repair reply is reconciled by status, never automatically replayed', async (t) => {
  const f = fixture()
  f.api.repair = async () => {
    f.calls.push({ name: 'repair' })
    f.snapshot.phase = 'repairing'
    throw new Error('reply lost')
  }
  const view = model.createLibraryHealthView(f.api)
  t.after(view.dispose)
  await view.open()
  await view.repair()
  assert.equal(f.calls.filter((c) => c.name === 'repair').length, 1)
  assert.equal(view.state.value.snapshot?.phase, 'repairing')
  assert.match(view.state.value.error, /reply lost/)
})

test('late opening status cannot replace a newly requested report', async (t) => {
  const f = fixture()
  let resolveStatus!: (value: LibraryHealthState) => void
  f.api.status = () =>
    new Promise((resolve) => {
      resolveStatus = resolve
    })
  const view = model.createLibraryHealthView(f.api)
  t.after(view.dispose)
  const opening = view.open()
  f.snapshot.report!.id = 'new-report'
  await view.refresh()
  resolveStatus({
    ...structuredClone(f.snapshot),
    report: { ...f.snapshot.report!, id: 'old-report' }
  })
  await opening
  assert.equal(view.state.value.snapshot?.report?.id, 'new-report')
})

test('compact health panel keeps optional coverage lazy and preserves tag editing and one-click completion', async (t) => {
  const f = fixture()
  f.snapshot.report!.metrics.artist_image.hidden = 1
  f.snapshot.report!.metrics.artist_image.missing = 0
  f.issues.push({
    index: 2,
    category: 'track_genre',
    state: 'manual',
    title: 'Local song',
    subtitle: '',
    reason: '缺少文件流派',
    canRepair: false,
    track: {
      id: 'local-song',
      title: 'Local song',
      artist: 'Artist',
      album: 'Album',
      duration: 200,
      size: 0
    }
  })
  const core = {
    state: shallowRef({
      epoch: 'one',
      libraryRevision: 1,
      catalogRevision: 2,
      entityMetadataRevision: 3
    }),
    attach: async () => {},
    query: (name: string, input: any) =>
      name === 'library.health.status' ? f.api.status() : f.api.page(input),
    command: (name: string, input: any) =>
      name === 'library.health.start' ? f.api.start() : f.api.repair(input)
  }
  const Panel = component('../library-inbox/LibraryHealthPanel.vue', {
    './libraryHealthView.ts': model,
    '../music-metadata/metadataTasksView.ts': reasons,
    '../../stores/coreConnection.ts': { useCoreConnection: () => core }
  })
  let navigation = ''
  let edited: unknown[] = []
  const ui = mount(t, () =>
    h(Panel, {
      onEdit: (track, revision) => {
        edited = [track.id, revision]
      },
      onNavigate: (section) => {
        navigation = section
      }
    })
  )
  await settle()
  assert.doesNotMatch(ui.text(), /歌手头像|需手动整理|待身份复核/)
  assert.equal(
    f.calls.some((c) => c.name === 'page'),
    false
  )
  assert.equal(
    f.calls.some((c) => c.name === 'repair' || c.name === 'start'),
    false
  )
  ui.button('补充资料').props.onClick()
  await settle()
  assert.equal(f.calls.filter((c) => c.name === 'repair').length, 1)
  assert.deepEqual(f.calls.find((c) => c.name === 'repair')!.input, { refresh: true })
  assert.equal(ui.button('补充中…').props.disabled, true)
  const coverage = ui
    .nodes()
    .find((node) => node.tag === 'details' && node.props.class === 'coverage-disclosure')!
  coverage.props.onToggle({ target: { open: true } })
  await settle()
  assert.match(ui.text(), /歌手头像/)
  assert.match(ui.text(), /已隐藏 1/)
  assert.match(ui.text(), /资料源暂无内容/)
  assert.match(ui.text(), /按资料字段统计/)
  ui.button('整理流派').props.onClick()
  await settle()
  assert.equal(navigation, 'genres')
  ui.button('预览并编辑标签').props.onClick()
  assert.deepEqual(edited, ['local-song', 1])
})

test('compact opening reads saved state only; the completion command owns fresh diagnosis and work', async (t) => {
  const f = fixture()
  f.snapshot.phase = 'idle'
  f.snapshot.report = null
  const view = model.createLibraryHealthView(f.api, { findings: false, scanOnOpen: false })
  t.after(view.dispose)
  await view.open()
  assert.deepEqual(
    f.calls.map((c) => c.name),
    ['status']
  )
  await view.complete()
  assert.deepEqual(f.calls.find((c) => c.name === 'repair')!.input, { refresh: true })
  assert.equal(
    f.calls.some((c) => c.name === 'start'),
    false
  )
})

test('coverage pages are requested only while the disclosure is open', async (t) => {
  const f = fixture()
  const view = model.createLibraryHealthView(f.api, { findings: false })
  t.after(view.dispose)
  await view.open()
  assert.equal(
    f.calls.some((c) => c.name === 'page'),
    false
  )
  await view.findings(true)
  assert.equal(f.calls.filter((c) => c.name === 'page').length, 1)
  await view.findings(false)
  f.snapshot.report!.id = 'updated'
  await view.refresh()
  assert.equal(f.calls.filter((c) => c.name === 'page').length, 1)
})
