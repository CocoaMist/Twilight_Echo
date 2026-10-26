import assert from 'node:assert/strict'
import test from 'node:test'
import { h, shallowRef } from 'vue'
import { component, mount, settle } from '../music-ratings/ratingsTestRenderer.ts'
import * as model from './musicExplorationView.ts'
import * as credits from '../music-metadata/musicCreditsView.ts'
import { explorationFixture } from './musicExplorationTest.fixture.ts'

function fixture() {
  const f = explorationFixture(), snapshot = shallowRef({ epoch: 'one', explorationRevision: 1, catalogRevision: 1, libraryRevision: 1, entityMetadataRevision: 1 })
  const core = {
    state: snapshot,
    query: (name: string, query: any, signal: AbortSignal) => {
      if (name === 'exploration.detail') return f.api.detail(query, signal)
      if (name === 'exploration.lookup') return f.api.lookup(query, signal)
      if (name === 'exploration.query') return f.api.query(query, signal)
      if (name === 'exploration.relations') return f.api.relations(query, signal)
      if (name === 'exploration.participation') return f.api.participation(query, signal)
      throw new Error(`Unexpected ${name}`)
    },
    command: (name: string, query: any) => {
      if (name === 'exploration.performance.save') return f.api.save(query)
      if (name === 'exploration.performance.delete') return f.api.delete(query)
      throw new Error(`Unexpected ${name}`)
    }
  }
  const Personal = { props: ['entityId', 'label'], setup: (props: { entityId: string; label: string }) => () => h('aside', `${props.label}整理:${props.entityId}`) }
  const Panel = component('../music-exploration/MusicExplorationPanel.vue', {
    './musicExplorationView.ts': model,
    '../music-metadata/musicCreditsView.ts': credits,
    '../music-tags/MusicTagsPanel.vue': { default: Personal },
    '../music-preferences/PersonalPreferencesPanel.vue': { default: Personal },
    '../../stores/coreConnection.ts': { useCoreConnection: () => core }
  })
  return { ...f, snapshot, Panel }
}
const changeSelect = (ui: ReturnType<typeof mount>, index: number, value: string) => ui.nodes().filter(node => node.tag === 'select')[index].props.onChange({ target: { value } })
const namedInput = (ui: ReturnType<typeof mount>, index: number, value: string) => ui.nodes().filter(node => node.tag === 'input')[index].props.onInput({ target: { value } })

test('compiled person panel paginates role participation and explicitly distinguishes cached scope', async t => {
  const f = fixture(), ui = mount(t, () => h(f.Panel, { reference: { provider: 'mb', kind: 'artist', idType: 'mbid', value: 'person' } }))
  await settle()
  assert.match(ui.text(), /Same Name/); assert.match(ui.text(), /人物整理:person/)
  assert.match(ui.text(), /作曲/); assert.match(ui.text(), /instrument：piano/); assert.match(ui.text(), /MusicBrainz · CC0/)
  assert.match(ui.text(), /1–12 \/ 14/)
  ui.button('下一页关系').props.onClick(); await settle()
  assert.match(ui.text(), /13–14 \/ 14/)
  changeSelect(ui, 1, 'composer'); await settle()
  assert.deepEqual(f.calls.at(-1)!.query.roles, ['composer'])
  changeSelect(ui, 0, 'catalog'); await settle()
  assert.match(ui.text(), /仅浏览已缓存目录/)
  assert.equal(f.writes.length, 0)
})

test('compiled work panel shows direct recording relations without inventing a performance', async t => {
  const f = fixture()
  const ui = mount(t, () => h(f.Panel, { entityId: 'work' }))
  await settle()
  assert.match(ui.text(), /Movement 1/); assert.match(ui.text(), /作品整理:work/)
  assert.equal(ui.nodes().some(node => node.tag === 'button' && node.text === '编辑演绎'), false)
  ui.button('Movement 1').props.onClick(); await settle()
  assert.equal(f.calls.filter(call => call.name === 'detail').at(-1)!.query.entityId, 'recording-1')
  assert.doesNotMatch(ui.text(), /作品整理/)
  ui.button('返回上一层').props.onClick(); await settle(); assert.match(ui.text(), /作品整理:work/)
})

test('compiled editor selects exact IDs across pages, reorders movements and saves one performance', async t => {
  const f = fixture(), ui = mount(t, () => h(f.Panel, { entityId: 'work' }))
  await settle(); ui.button('建立人工演绎').props.onClick(); await settle()
  namedInput(ui, 0, 'Live performance'); await settle()
  assert.equal(ui.button('保存人工演绎').props.disabled, true)
  ui.nodes().find(node => node.tag === 'form')!.props.onSubmit({ preventDefault() {} }); await settle()
  ui.nodes().find(node => node.props['aria-label'] === '加入录音 recording-1')!.props.onClick(); await settle()
  ui.button('下一页录音').props.onClick(); await settle()
  ui.nodes().find(node => node.props['aria-label'] === '加入录音 recording-13')!.props.onClick(); await settle()
  ui.nodes().find(node => node.props['aria-label'] === '上移录音 2')!.props.onClick(); await settle()
  ui.button('保存人工演绎').props.onClick(); await settle()
  assert.deepEqual(f.writes[0].query, { workId: 'work', title: 'Live performance', recordingIds: ['recording-13', 'recording-1'], revision: 1 })
  assert.match(ui.text(), /人工演绎已保存/)
  ui.button('编辑演绎').props.onClick(); await settle()
  assert.match(ui.text(), /编辑人工演绎/)
  assert.equal(ui.nodes().filter(node => node.tag === 'input')[0].props.value, 'Live performance')
})

test('compiled unknown write retains the editor and reread does not replay the command', async t => {
  const f = fixture(), ui = mount(t, () => h(f.Panel, { entityId: 'work' }))
  await settle(); ui.button('建立人工演绎').props.onClick(); await settle(); namedInput(ui, 0, 'Keep this')
  ui.nodes().find(node => node.tag === 'form')!.props.onSubmit({ preventDefault() {} }); await settle()
  ui.nodes().find(node => node.props['aria-label'] === '加入录音 recording-2')!.props.onClick(); await settle()
  f.fail(); ui.button('保存人工演绎').props.onClick(); await settle()
  assert.match(ui.text(), /提交结果未确认/); assert.equal(ui.button('保存人工演绎').props.disabled, true)
  ui.button('重新读取关系').props.onClick(); await settle()
  assert.equal(f.writes.length, 1); assert.equal(ui.button('保存人工演绎').props.disabled, true)
  assert.equal(ui.nodes().filter(node => node.tag === 'input')[0].props.value, 'Keep this')
  ui.button('已核对关系，允许手动提交').props.onClick(); await settle()
  assert.equal(f.writes.length, 1); assert.equal(ui.button('保存人工演绎').props.disabled, false)
})

test('compiled manual deletion requires a separate confirmation and keeps source recordings', async t => {
  const f = fixture()
  await f.api.save({ workId: 'work', title: 'Manual', recordingIds: ['recording-1'], revision: 1 })
  const ui = mount(t, () => h(f.Panel, { entityId: 'work' })); await settle()
  ui.button('删除演绎').props.onClick(); await settle()
  assert.equal(f.writes.length, 1); assert.match(ui.text(), /原录音与作品仍保留/)
  ui.button('保留演绎').props.onClick(); await settle(); assert.equal(f.writes.length, 1)
  ui.button('删除演绎').props.onClick(); await settle(); ui.button('确认删除演绎').props.onClick(); await settle()
  assert.equal(f.writes.length, 2); assert.equal(f.writes[1].name, 'delete'); assert.ok(f.entities.get('recording-1'))
})

test('compiled same-name person context change uses exact IDs and no shared organization targets', async t => {
  const f = fixture(), id = shallowRef('person'), ui = mount(t, () => h(f.Panel, { entityId: id.value }))
  await settle(); id.value = 'other-person'; await settle()
  assert.match(ui.text(), /人物整理:other-person/); assert.doesNotMatch(ui.text(), /人物整理:person/)
  assert.match(ui.text(), /当前范围内没有已知关系/)
  assert.equal(f.calls.filter(call => call.name === 'detail').at(-1)!.query.entityId, 'other-person')
})

test('compiled forward credits retain their source direction and raw relation meaning', async t => {
  const f = fixture()
  const credit = f.edges.find(item => item.relation.credit)!.relation.credit!
  credit.direction = 'forward'; credit.rawRole = 'dedicated to'; credit.begin = '1970'; credit.end = '1971'
  const ui = mount(t, () => h(f.Panel, { entityId: 'recording-1' })); await settle()
  assert.match(ui.text(), /dedicated to/); assert.match(ui.text(), /正向关系/); assert.match(ui.text(), /1970–1971/)
  assert.doesNotMatch(ui.text(), /作曲/)
})
