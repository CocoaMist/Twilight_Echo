/* eslint-disable vue/one-component-per-file */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { compile, parse as parseTemplate } from '@vue/compiler-dom'
import { parse as parseSfc } from '@vue/compiler-sfc'
import { h, shallowRef } from 'vue'
import { component, mount, settle } from '../music-ratings/ratingsTestRenderer.ts'
import * as draftModel from './musicFocusDraft.ts'
import * as viewModel from './musicFocusView.ts'
import { CLASSIFICATION_DIMENSIONS } from '../../../../shared/musicClassificationDimensions.ts'
import { focusFixture } from './musicFocusTest.fixture.ts'

function fixture(count = 23, saved = 12) {
  const f = focusFixture(count, saved),
    snapshot = shallowRef({
      epoch: 'one',
      focusRevision: 1,
      focusHistoryRevision: 1,
      catalogRevision: 1,
      libraryRevision: 1,
      tagsLinkRevision: 0,
      pluginsRevision: 1,
      settingsRevision: 1,
      sequence: 1
    })
  f.onChanged((revision) => {
    snapshot.value = { ...snapshot.value, focusRevision: revision }
  })
  const core = {
    state: snapshot,
    query: async (name: string, input: any, signal: AbortSignal): Promise<any> => {
      if (name === 'focus.query') return f.api.query(input, signal)
      if (name === 'focus.facets') return f.api.facets(input, signal)
      if (name === 'focus.saved.list') return f.api.saved(input, signal)
      if (name === 'focus.play.status') return f.api.playStatus(input, signal)
      if (name === 'genres.tree') return f.api.genres(input, signal)
      if (name === 'tags.list') return f.api.tags(input, signal)
      throw new Error(`Unexpected query ${name}`)
    },
    command: async (
      name: string,
      input: any,
      signal: AbortSignal,
      requestId: string
    ): Promise<any> => {
      if (name === 'focus.saved.create') return f.api.create(input)
      if (name === 'focus.saved.rename') return f.api.rename(input)
      if (name === 'focus.saved.update') return f.api.update(input)
      if (name === 'focus.saved.delete') return f.api.delete(input)
      if (name === 'focus.play') return f.api.play(input, signal, requestId)
      throw new Error(`Unexpected command ${name}`)
    }
  }
  const Numbers = component('../music-focus/FocusNumberFields.vue', {})
  const Node = component('../music-focus/FocusConditionNode.vue', {
    './musicFocusDraft.ts': draftModel,
    './musicFocusView.ts': viewModel,
    '../../../../shared/musicClassificationDimensions.ts': { CLASSIFICATION_DIMENSIONS },
    './FocusNumberFields.vue': { default: Numbers }
  })
  const Panel = component('../music-focus/MusicFocusPanel.vue', {
    './musicFocusView.ts': viewModel,
    './FocusConditionNode.vue': { default: Node },
    '../../stores/coreConnection.ts': { useCoreConnection: () => core }
  })
  return { ...f, core, snapshot, Panel }
}
type Ui = ReturnType<typeof mount>
function text(node: { text: string; children: any[] }): string {
  return node.text + node.children.map(text).join('')
}
function byAria(ui: Ui, label: string) {
  const found = ui.nodes().find((node) => node.props['aria-label'] === label)
  assert.ok(found, `Missing aria-label ${label}`)
  return found
}
function field(ui: Ui, label: string, value: string, tag = 'input') {
  const container = ui.nodes().find((node) => node.tag === 'label' && text(node).startsWith(label))
  assert.ok(container, `Missing label ${label}`)
  const node = container.children.find((child) => child.tag === tag)!
  const handler = tag === 'select' ? node.props.onChange : node.props.onInput
  if (handler) handler({ target: { value } })
  else node.props['onUpdate:modelValue'](value)
}
function submit(ui: Ui, label: string) {
  const form = ui.nodes().find((node) => node.tag === 'form' && text(node).includes(label))
  assert.ok(form)
  form.props.onSubmit({ preventDefault() {} })
}
async function add(ui: Ui, kind: string) {
  field(ui, '添加条件', kind, 'select')
  await settle()
  const button = ui.nodes().find((node) => node.props['aria-label']?.startsWith('添加到 '))!
  button.props.onClick()
  await settle()
}

test('compiled empty-library controls save conditions with no rows, providers or playback queries', async (t) => {
  const f = fixture(0, 0),
    ui = mount(t, () => h(f.Panel))
  await settle()
  assert.equal(f.queries.length, 0)
  ui.button('展开 Focus').props.onClick()
  await settle()
  field(ui, '新查询名称', '将来听')
  await settle()
  submit(ui, '保存为新查询')
  await settle()
  assert.equal(f.writes[0].name, 'focus.saved.create')
  assert.equal(f.writes[0].query.query.entity, 'recording')
  assert.equal(f.writes[0].query.query.scope, 'library')
  assert.equal(f.writes[0].query.query.where, undefined)
  assert.equal(
    f.queries.every((query) => query.name === 'focus.saved.list'),
    true
  )
  ui.button('刷新 Focus 结果').props.onClick()
  await settle()
  assert.match(ui.text(), /当前结果 · 0 个录音/)
  assert.match(ui.text(), /当前条件没有结果/)
  assert.equal(ui.button('播放 Focus 集合').props.disabled, true)
})

test('compiled tree builds correlated sources, ratings, recent history and bans rather than a JSON editor', async (t) => {
  const f = fixture(),
    ui = mount(t, () => h(f.Panel))
  ui.button('展开 Focus').props.onClick()
  await settle()
  await add(ui, 'source')
  field(ui, '音频格式', 'FLAC')
  field(ui, '位深 (bit)至少', '24')
  await settle()
  await add(ui, 'rating')
  field(ui, '评分至少', '4.5')
  await settle()
  await add(ui, 'notPlayedWithinDays')
  field(ui, '最近未播放的天数', '90')
  await settle()
  await add(ui, 'automaticPlaybackBlocked')
  ui.button('刷新 Focus 结果').props.onClick()
  await settle()
  const query = f.queries.findLast((item) => item.name === 'focus.query')!.query.query
  assert.deepEqual(query.where, {
    all: [
      { source: { provider: 'local', format: 'FLAC', bitDepth: { gte: 24 } } },
      { rating: { target: 'self', mode: 'personal', gteStars: 4.5 } },
      { notPlayedWithinDays: 90 },
      { automaticPlaybackBlocked: false }
    ]
  })
  assert.match(ui.text(), /4 星/)
  assert.doesNotMatch(ui.text(), /2 星|从未听过/)
  assert.equal(
    ui.nodes().some((node) => node.tag === 'textarea'),
    false
  )
  assert.deepEqual(f.queries.at(-1)!.query.token, { ...f.token(), queryKey: JSON.stringify(query) })
})

test('compiled nested OR and NOT controls preserve complement and no-record conditions', async (t) => {
  const f = fixture(),
    ui = mount(t, () => h(f.Panel))
  ui.button('展开 Focus').props.onClick()
  await settle()
  const root = ui.nodes().find((node) => node.props['aria-label']?.startsWith('条件类型 '))!
  root.props.onChange({ target: { value: 'not' } })
  await settle()
  const kindControls = ui
    .nodes()
    .filter((node) => node.props['aria-label']?.startsWith('条件类型 '))
  kindControls[1].props.onChange({ target: { value: 'any' } })
  await settle()
  await add(ui, 'lastPlayed')
  ui.button('刷新 Focus 结果').props.onClick()
  await settle()
  assert.deepEqual(f.queries.findLast((item) => item.name === 'focus.query')!.query.query.where, {
    not: { any: [{ lastPlayed: { exists: false } }] }
  })
  assert.match(ui.text(), /包括缺值条目/)
})

test('compiled source browser chooses actual provider IDs from bounded cached facets', async (t) => {
  const f = fixture(),
    original = f.api.facets
  f.api.facets = async (query, signal) =>
    query.token
      ? original(query, signal)
      : {
          ...(await original(query, signal)),
          items: [{ value: 'provider.example', label: '流媒体来源', count: 1 }]
        }
  const ui = mount(t, () => h(f.Panel))
  ui.button('展开 Focus').props.onClick()
  await settle()
  await add(ui, 'source')
  ui.button('浏览已有来源').props.onClick()
  await settle()
  assert.equal(f.queries.at(-1)!.name, 'focus.facets')
  assert.equal(f.queries.at(-1)!.query.facet, 'provider')
  assert.equal(f.queries.at(-1)!.query.limit, 20)
  byAria(ui, '选择来源 流媒体来源').props.onClick()
  await settle()
  ui.button('刷新 Focus 结果').props.onClick()
  await settle()
  assert.deepEqual(f.queries.findLast((item) => item.name === 'focus.query')!.query.query.where, {
    all: [{ source: { provider: 'provider.example' } }]
  })
})

test('compiled genre and tag pickers page stable identities and descendants without full dictionaries', async (t) => {
  const f = fixture(),
    ui = mount(t, () => h(f.Panel))
  ui.button('展开 Focus').props.onClick()
  await settle()
  await add(ui, 'genre')
  field(ui, '查找流派', '')
  ui.button('查找').props.onClick()
  await settle()
  assert.equal(f.queries.at(-1)!.query.limit, 20)
  ui.button('下一页选项').props.onClick()
  await settle()
  byAria(ui, '选择 流派 21').props.onClick()
  await settle()
  await add(ui, 'tag')
  const searches = ui.nodes().filter((node) => node.tag === 'button' && text(node) === '查找')
  searches.at(-1)!.props.onClick()
  await settle()
  byAria(ui, '选择 夜间').props.onClick()
  await settle()
  ui.button('刷新 Focus 结果').props.onClick()
  await settle()
  assert.deepEqual(f.queries.findLast((item) => item.name === 'focus.query')!.query.query.where, {
    all: [{ genre: { id: 'genre-20', includeDescendants: true } }, { tag: { id: 'tag-1' } }]
  })
})

test('compiled saved queries page and reopen dynamically; name and conditions have separate updates and delete confirmation', async (t) => {
  const f = fixture(),
    ui = mount(t, () => h(f.Panel))
  ui.button('展开 Focus').props.onClick()
  await settle()
  ui.button('下一页查询').props.onClick()
  await settle()
  assert.match(ui.text(), /11–12 \/ 12/)
  byAria(ui, '打开查询 查询 11').props.onClick()
  await settle()
  assert.equal(
    f.queries.findLast((item) => item.name === 'focus.query')!.query.query.where
      .notPlayedWithinDays,
    90
  )
  byAria(ui, '重命名查询 查询 11').props.onClick()
  await settle()
  field(ui, '查询新名称', '半年未听')
  await settle()
  submit(ui, '保存名称')
  await settle()
  assert.equal(f.writes.at(-1)!.name, 'focus.saved.rename')
  assert.deepEqual(Object.keys(f.writes.at(-1)!.query).sort(), ['id', 'name', 'nameRevision'])
  field(ui, '最近未播放的天数', '180')
  await settle()
  assert.doesNotMatch(ui.text(), /当前结果 ·/)
  // Rename rereads page zero. Find the selected query on its current page without replacing the draft.
  ui.button('下一页查询').props.onClick()
  await settle()
  ui.button('更新此查询条件').props.onClick()
  await settle()
  assert.equal(f.writes.at(-1)!.name, 'focus.saved.update')
  assert.equal(f.writes.at(-1)!.query.query.where.notPlayedWithinDays, 180)
  ui.button('下一页查询').props.onClick()
  await settle()
  byAria(ui, '删除查询 半年未听').props.onClick()
  await settle()
  const writes = f.writes.length
  assert.match(ui.text(), /只删除保存的查询，不删除音乐或整理数据/)
  ui.button('保留查询').props.onClick()
  await settle()
  assert.equal(f.writes.length, writes)
  byAria(ui, '删除查询 半年未听').props.onClick()
  await settle()
  ui.button('确认删除查询').props.onClick()
  await settle()
  assert.equal(f.writes.at(-1)!.name, 'focus.saved.delete')
})

test('compiled conflict reread preserves days and retained intent; no automatic write retry', async (t) => {
  const f = fixture(),
    ui = mount(t, () => h(f.Panel))
  ui.button('展开 Focus').props.onClick()
  await settle()
  byAria(ui, '打开查询 查询 1').props.onClick()
  await settle()
  field(ui, '最近未播放的天数', '180')
  await settle()
  f.saved[0].queryRevision++
  ui.button('更新此查询条件').props.onClick()
  await settle()
  assert.match(ui.text(), /条件和操作已保留/)
  const writes = f.writes.length
  ui.button('重新读取查询').props.onClick()
  await settle()
  assert.equal(f.writes.length, writes)
  const input = ui.nodes().find((node) => node.tag === 'input' && node.props.max === '365000')!
  assert.equal(input.props.value, '180')
  ui.button('保存保留的查询操作').props.onClick()
  await settle()
  assert.equal(f.writes.at(-1)!.query.queryRevision, 2)
  assert.deepEqual(f.saved[0].query.where, { notPlayedWithinDays: 180 })
})

test('compiled results and facets paginate with one token; stale revisions withdraw them without rerun', async (t) => {
  const f = fixture(),
    ui = mount(t, () => h(f.Panel))
  ui.button('展开 Focus').props.onClick()
  await settle()
  ui.button('刷新 Focus 结果').props.onClick()
  await settle()
  assert.match(ui.text(), /当前结果 · 23 个录音/)
  assert.match(ui.text(), /当前结果中的数量/)
  assert.match(ui.text(), /无播放记录/)
  ui.button('下一页结果').props.onClick()
  await settle()
  assert.match(ui.text(), /21–23 \/ 23/)
  const calls = f.queries.length
  f.snapshot.value = { ...f.snapshot.value, sequence: 2 }
  await settle()
  assert.equal(f.queries.length, calls)
  f.snapshot.value = { ...f.snapshot.value, tagsLinkRevision: 1 }
  await settle()
  assert.equal(f.queries.length, calls)
  assert.doesNotMatch(ui.text(), /当前结果 · 23/)
  assert.match(ui.text(), /旧结果与数量已撤下/)
})

test('compiled catalog scope, release entity and unavailable base rating are explicit and not playable', async (t) => {
  const f = fixture(),
    ui = mount(t, () => h(f.Panel))
  ui.button('展开 Focus').props.onClick()
  await settle()
  field(ui, '查询条目', 'release', 'select')
  field(ui, '查询范围', 'catalog', 'select')
  await settle()
  await add(ui, 'rating')
  field(ui, '评分模式', 'base', 'select')
  await settle()
  assert.match(ui.text(), /当前没有获准的资料评分源/)
  ui.button('刷新 Focus 结果').props.onClick()
  await settle()
  assert.match(ui.text(), /当前结果 · 23 个发行/)
  assert.equal(ui.button('播放 Focus 集合').props.disabled, true)
  assert.equal(ui.nodes().filter((node) => node.props['aria-label']?.startsWith('从 ')).length, 0)
})

test('compiled playback sends a separate request ID and unknown outcome reconciles without replay', async (t) => {
  const f = fixture(),
    ui = mount(t, () => h(f.Panel))
  ui.button('展开 Focus').props.onClick()
  await settle()
  ui.button('刷新 Focus 结果').props.onClick()
  await settle()
  f.failPlay(Object.assign(new Error('lost reply'), { code: 'OUTCOME_UNKNOWN' }))
  byAria(ui, '从 曲目 3 播放 Focus 集合').props.onClick()
  await settle()
  assert.equal(f.writes[0].query.sourceId, 'source-2')
  assert.deepEqual(Object.keys(f.writes[0].query).sort(), ['query', 'sourceId', 'token'])
  const requestId = f.playRequests[0].requestId
  assert.match(requestId, /^[a-f0-9-]{36}$/)
  assert.equal(ui.button('播放 Focus 集合').props.disabled, true)
  assert.equal(
    ui.nodes().some((node) => node.tag === 'button' && text(node).includes('我已人工核对')),
    false
  )
  const writes = f.writes.length
  ui.button('重新读取查询').props.onClick()
  await settle()
  assert.equal(f.writes.length, writes)
  f.setPlayStatus({ status: 'pending' })
  ui.button('查询本次播放结果').props.onClick()
  await settle()
  assert.deepEqual(f.queries.at(-1)!.query, { requestId, epoch: 'one' })
  assert.equal(ui.button('播放 Focus 集合').props.disabled, true)
  assert.match(ui.text(), /请求仍在处理中/)
  f.setPlayStatus({ status: 'not_committed' })
  ui.button('查询本次播放结果').props.onClick()
  await settle()
  assert.equal(ui.button('播放 Focus 集合').props.disabled, false)
  assert.match(ui.text(), /原队列未被此请求替换/)
  assert.equal(f.writes.length, writes)
})

test('compiled cancellation reconciles adopted unconfirmed playback and ignores the cancelled command late success', async (t) => {
  const f = fixture(),
    original = f.api.play
  let finish: (() => void) | null = null
  f.api.play = async (...args) => {
    const result = await original(...args)
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return result
  }
  const ui = mount(t, () => h(f.Panel))
  ui.button('展开 Focus').props.onClick()
  await settle()
  ui.button('刷新 Focus 结果').props.onClick()
  await settle()
  ui.button('播放 Focus 集合').props.onClick()
  await settle()
  ui.button('取消 Focus 准备').props.onClick()
  await settle()
  assert.equal(f.playRequests[0].signal.aborted, true)
  f.setPlayStatus({
    status: 'committed',
    result: { total: 23, selectedIndex: 0 },
    playback: 'failed'
  })
  ui.button('查询本次播放结果').props.onClick()
  await settle()
  assert.match(ui.text(), /队列已提交.*播放状态未确认.*不要重复提交/)
  assert.equal(ui.button('播放 Focus 集合').props.disabled, false)
  finish!()
  await settle()
  assert.match(ui.text(), /队列已提交.*播放状态未确认.*不要重复提交/)
  assert.equal(f.writes.length, 1)
})

test('compiled adopted pending playback stays locked until confirmed; epoch unknown requires explicit manual check', async (t) => {
  const f = fixture(),
    ui = mount(t, () => h(f.Panel))
  ui.button('展开 Focus').props.onClick()
  await settle()
  ui.button('刷新 Focus 结果').props.onClick()
  await settle()
  f.failPlay(new Error('reply lost'))
  ui.button('播放 Focus 集合').props.onClick()
  await settle()
  f.setPlayStatus({
    status: 'committed',
    result: { total: 23, selectedIndex: 0 },
    playback: 'pending'
  })
  ui.button('查询本次播放结果').props.onClick()
  await settle()
  assert.equal(ui.button('播放 Focus 集合').props.disabled, true)
  assert.match(ui.text(), /队列已提交.*启动仍在处理中/)
  const requestId = f.playRequests[0].requestId
  f.snapshot.value = { ...f.snapshot.value, epoch: 'two' }
  await settle()
  f.setPlayStatus({ status: 'unknown' })
  ui.button('查询本次播放结果').props.onClick()
  await settle()
  assert.deepEqual(f.queries.at(-1)!.query, { requestId, epoch: 'one' })
  assert.match(ui.text(), /无法确定.*是否提交/)
  ui.button('我已人工核对当前队列').props.onClick()
  await settle()
  ui.button('刷新 Focus 结果').props.onClick()
  await settle()
  assert.equal(ui.button('播放 Focus 集合').props.disabled, false)
  assert.equal(f.writes.length, 1)
})

test('actual all-songs entry exposes Focus independent of rows, auth and empty results; excludes previews', async (t) => {
  const f = fixture(0, 0),
    category = shallowRef('allSongs'),
    previewTracks = shallowRef<unknown[] | undefined>(undefined)
  const source = readFileSync(new URL('../SongList.vue', import.meta.url), 'utf8')
  const template = parseSfc(source).descriptor.template!.content
  const visit = (node: any, parents: any[]): { node: any; parents: any[] } | null => {
    if (node.tag === 'MusicFocusPanel') return { node, parents }
    for (const child of node.children ?? []) {
      const result = visit(child, [...parents, node])
      if (result) return result
    }
    return null
  }
  const location = visit(parseTemplate(template), [])!
  assert.ok(location)
  assert.match(location.node.loc.source, /!previewTracks && category === 'allSongs'/)
  assert.doesNotMatch(location.node.loc.source, /tableTrackCount|provider|database/)
  assert.equal(
    location.parents.some((parent) =>
      parent.props?.some(
        (prop: any) =>
          prop.type === 7 && /tableTrackCount|provider|database/.test(prop.exp?.content ?? '')
      )
    ),
    false
  )
  assert.match(
    source,
    /const MusicFocusPanel = defineAsyncComponent\(\(\) => import\('\.\/music-focus\/MusicFocusPanel\.vue'\)\)/
  )
  const render = new Function('Vue', compile(location.node.loc.source, { mode: 'function' }).code)(
    await import('vue')
  )
  const ui = mount(t, () =>
    h({
      render() {
        return render.call(
          {
            category: category.value,
            previewTracks: previewTracks.value,
            MusicFocusPanel: f.Panel
          },
          {
            category: category.value,
            previewTracks: previewTracks.value,
            MusicFocusPanel: f.Panel
          },
          []
        )
      },
      components: { MusicFocusPanel: f.Panel }
    })
  )
  await settle()
  assert.match(ui.text(), /展开 Focus/)
  ui.button('展开 Focus').props.onClick()
  await settle()
  assert.match(ui.text(), /空音乐库也可以保存条件/)
  previewTracks.value = []
  await settle()
  assert.equal(ui.text(), '')
  previewTracks.value = undefined
  category.value = 'playlists'
  await settle()
  assert.equal(ui.text(), '')
})
