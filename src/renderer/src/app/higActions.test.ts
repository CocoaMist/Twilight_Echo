import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

function loadAction(
  component: string,
  name: string,
  context: Record<string, unknown>
): (...args: unknown[]) => unknown {
  const source = readFileSync(new URL(`../components/${component}.vue`, import.meta.url), 'utf8')
  const script = source.slice(source.indexOf('>') + 1, source.indexOf('</script>'))
  const ast = ts.createSourceFile(
    'action.ts',
    script,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const action = ast.statements.find(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name
  )
  assert.ok(action, `Production action ${name} exists`)
  const js = ts.transpileModule(action.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  return vm.runInNewContext(`${js}\n${name}`, context)
}

function songFixture() {
  const events: unknown[][] = []
  const tracks = Array.from({ length: 150 }, (_, index) => ({
    id: `track-${index}`,
    source: 'local'
  }))
  const row = { getBoundingClientRect: () => ({ left: 20, top: 40, height: 68 }) }
  const context = {
    displayTracks: { value: tracks },
    hasSelection: { value: false },
    focusedTrackId: { value: tracks[0].id },
    visibleRange: { value: { start: 0, end: 12 } },
    viewportHeight: { value: 500 },
    rowHeight: 68,
    tbodyRef: { value: { offsetTop: 120 } },
    scrollTop: { value: 0 },
    containerRef: {
      value: {
        scrollTop: 0,
        querySelector: (selector: string) => ({ focus: () => events.push(['focus', selector]) })
      }
    },
    playTrack: (track: object, queue: object[]) => events.push(['play', track, queue]),
    playNetworkTrack: (track: object) => events.push(['network', track]),
    toggle: (id: string, index: number) => events.push(['toggle', id, index]),
    multiSelect: {
      selectOnly: (id: string, index: number) => events.push(['anchor', id, index]),
      selectRange: (index: number) => events.push(['range', index])
    },
    onTrackContextMenu: (event: object, track: object) => events.push(['menu', event, track]),
    MouseEvent: class {
      type: string
      options: object
      constructor(type: string, options: object) {
        this.type = type
        this.options = options
      }
    },
    nextTick: () => Promise.resolve()
  }
  return { action: loadAction('SongList', 'onTrackRowKeydown', context), context, events, row }
}

function key(row: object, name: string, extra = {}): object {
  return {
    target: row,
    currentTarget: row,
    key: name,
    code: name === ' ' ? 'Space' : name,
    preventDefault() {},
    stopPropagation() {},
    ...extra
  }
}

test('track row Enter routes local and network playback; Space selects without playing', async () => {
  const { action, context, events, row } = songFixture()
  const track = context.displayTracks.value[0]
  await action(key(row, 'Enter'), track, 0)
  assert.equal(events[0][0], 'play')
  assert.equal(events[0][2], context.displayTracks.value)
  await action(key(row, 'Enter'), { ...track, source: 'network' }, 0)
  assert.equal(events[1][0], 'network')
  await action(key(row, ' '), track, 0)
  assert.deepEqual(events[2], ['toggle', track.id, 0])
  await action(key(row, 'Enter', { target: {} }), track, 0)
  assert.equal(events.length, 3, 'child controls never double-trigger row playback')
})

test('End renders and focuses a distant virtual row; Shift arrows extend selection and Shift F10 opens its menu', async () => {
  const { action, context, events, row } = songFixture()
  const track = context.displayTracks.value[0]
  await action(key(row, 'End'), track, 0)
  assert.equal(context.focusedTrackId.value, 'track-149')
  assert.ok(context.containerRef.value.scrollTop > 9000)
  assert.equal(context.scrollTop.value, context.containerRef.value.scrollTop)
  assert.deepEqual(events.at(-1), ['focus', '[data-track-index="149"]'])
  await action(key(row, 'ArrowDown', { shiftKey: true }), track, 0)
  assert.deepEqual(events.slice(-3, -1), [
    ['anchor', track.id, 0],
    ['range', 1]
  ])
  await action(key(row, 'F10', { shiftKey: true }), track, 0)
  assert.equal(events.at(-1)?.[0], 'menu')
  assert.equal(events.at(-1)?.[2], track)
})

test('browsing EQ tabs closes local menus and never applies processing or changes the active audio mode', async () => {
  const context = {
    activeTab: { value: 'graphic' },
    finishParametricEdits: () => {},
    commitChain: Promise.resolve(),
    presetMenuOpen: { value: true },
    filterMenuOpen: { value: true },
    audioProcessing: { value: { eqMode: 'graphic' } },
    updateAudioProcessing: () => assert.fail('tab browsing changed audio')
  }
  await loadAction('EqualizerPage', 'switchTab', context)('parametric')
  assert.equal(context.activeTab.value, 'parametric')
  assert.equal(context.audioProcessing.value.eqMode, 'graphic')
  assert.equal(context.presetMenuOpen.value, false)
  assert.equal(context.filterMenuOpen.value, false)
})

test('local and online Play Last append the selected batch through the existing queue API', () => {
  const tracks = [{ id: 'a' }, { id: 'b' }]
  const batches: unknown[] = []
  loadAction('SongList', 'handleContextAddToTail', {
    contextActionTracks: { value: tracks },
    appendQueueTracks: (batch: unknown) => batches.push(batch),
    closeContextMenu() {}
  })()
  assert.equal(batches[0], tracks)
  const selected = { value: tracks }
  loadAction('StreamingPage', 'handleContextPlayLast', {
    streamingContextActionTracks: selected,
    closeStreamingContextMenu: () => {
      selected.value = []
    },
    playbackStore: { appendQueueTracks: (batch: unknown) => batches.push(batch) },
    pushNotice() {}
  })()
  assert.equal(batches.length, 2)
  assert.deepEqual(Array.from(batches[1] as unknown[]), tracks, 'selection survives menu dismissal')
})
