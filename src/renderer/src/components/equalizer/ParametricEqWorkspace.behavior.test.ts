import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const workspace = fileURLToPath(new URL('../../../../../', import.meta.url))

test('EQ range, grouped selection and analyzer controls preserve gesture and audio semantics', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'twilight-eq-range-ui-'))
  try {
    await writeFile(join(directory, 'entry.ts'), runtime)
    await build({
      configFile: false,
      logLevel: 'error',
      root: workspace,
      plugins: [vue()],
      resolve: {
        alias: {
          '@renderer': join(workspace, 'src/renderer/src'),
          vue: require.resolve('vue/dist/vue.esm-bundler.js')
        }
      },
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: join(directory, 'bundle'),
        emptyOutDir: true,
        minify: false,
        lib: {
          entry: join(directory, 'entry.ts'),
          name: 'EqRangeTest',
          formats: ['iife'],
          fileName: 'runtime'
        }
      }
    })
    const files = await readdir(join(directory, 'bundle'))
    await writeFile(
      join(directory, 'index.html'),
      `<!doctype html><html><head><meta charset="utf-8">${files
        .filter((file) => file.endsWith('.css'))
        .map((file) => `<link rel="stylesheet" href="bundle/${file}">`)
        .join(
          ''
        )}<style>body{font-family:system-ui;--accent-color:#6958cb;--bg-primary:#faf9fc;--text-primary:#28252e;--text-secondary:#736c7e;background:#e9e6ef}button,input{font-family:inherit}</style></head><body><button id="opener">曲库整理</button><div id="app"></div><script src="bundle/${files.find((file) => file.endsWith('.js'))}"></script></body></html>`
    )
    await writeFile(
      join(directory, 'runner.cjs'),
      `const {app,BrowserWindow}=require('electron');const fs=require('node:fs');app.setPath('userData',require('node:path').join(__dirname,'profile'));app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1080,height:900,webPreferences:{contextIsolation:false,backgroundThrottling:false,offscreen:true}});win.webContents.on('console-message',(_e,_l,message)=>console.error(message));try{await win.loadFile(process.argv.at(-1));await win.webContents.executeJavaScript('window.runEqRangeTests()');if(process.env.TWILIGHT_EQ_RANGE_SCREENSHOT){await win.webContents.executeJavaScript('window.renderEqSpectrumPreview()');await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');fs.writeFileSync(process.env.TWILIGHT_EQ_RANGE_SCREENSHOT,(await win.webContents.capturePage()).toPNG())}console.log('EQ_RANGE_UI_OK');app.exit(0)}catch(error){console.error(error.stack);app.exit(1)}})`
    )
    const result = await promisify(execFile)(
      require('electron'),
      ['--no-sandbox', join(directory, 'runner.cjs'), join(directory, 'index.html')],
      { windowsHide: true, timeout: 60_000 }
    )
    assert.match(result.stdout, /EQ_RANGE_UI_OK/)
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    await rm(directory, { recursive: true, force: true })
  }
})

const runtime = `import {createApp,h,nextTick,ref} from 'vue'
import Workspace from '@renderer/components/equalizer/ParametricEqWorkspace.vue'
import {responseToPath} from '@renderer/utils/eqViewport.ts'
import {useEqSpectrum} from '@renderer/composables/useEqSpectrum.ts'
const expect=(value,message)=>{if(!value)throw new Error(message)}
const tick=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,20));await nextTick()}
window.runEqRangeTests=async()=>{
  const spectrum=ref(new Float32Array(16).fill(0.3)),frozen=ref(false),visible=ref(true)
  document.documentElement.dataset.teMotion='off'
  const range=ref(12),bands=ref([{frequency:1000,gain:6,q:1,filterType:'peak'}]),primary=ref(0),selected=ref([0]),clipboardBusy=ref(false),view=ref('dsp'),workspaceWidth=ref(900),workspaceHeight=ref(600),workspaceZoom=ref(1);let edits=0,commits=0,added=null,menu=null,resolveMenu=null
  const copies=[],commands=[];let pastes=0
  window.api={window:{popupContextMenu:request=>{menu=request;return new Promise(resolve=>{resolveMenu=resolve})},closeContextMenu:async()=>{resolveMenu?.(null)}}}
  const path=()=>responseToPath([{frequency:1000,db:bands.value[0]?.gain??0}],range.value,false)
  const Root={setup:()=>()=>h(Workspace,{
    style:'width:'+workspaceWidth.value+'px;height:'+workspaceHeight.value+'px;zoom:'+workspaceZoom.value,bands:bands.value,selectedIndex:primary.value,selectedIndices:selected.value,displayRangeDb:range.value,
    filterTypes:[{value:'peak',label:'峰值',usesGain:true},{value:'highPass',label:'高通',usesGain:false}],responseView:view.value,responsePath:path(),clipboardBusy:clipboardBusy.value,
    spectrumLevels:spectrum.value,spectrumVisible:visible.value,spectrumFrozen:frozen.value,'onUpdate:spectrumFrozen':value=>{frozen.value=value},measuredSourcePath:'',targetResponsePath:'',combinedFilterPath:'',correctedAcousticPath:'',
    bandResponsePaths:[{index:0,path:path()}],showMeasuredSource:false,showTargetResponse:false,showIndividualFilters:true,showCombinedFilter:true,showCorrectedResponse:false,
    eqEnabled:true,meterPeakDb:-20,meterRmsDb:-30,status:'DSP 就绪',statusState:'idle',error:'',
    'onUpdate:displayRangeDb':value=>{range.value=value},onSelect:(index,indices)=>{primary.value=index;selected.value=indices},onPreviewBands:changes=>{edits++;const next=bands.value.slice();for(const {index,patch} of changes)next[index]={...next[index],...patch};bands.value=next},onCommit:()=>{commits++},onAdd:(frequency,gain)=>{added={frequency,gain}},onCopy:all=>copies.push(all),onPaste:()=>{pastes++},onToggle:index=>commands.push(['toggle',index]),onDelete:index=>commands.push(['delete',index]),onFilter:(index,type)=>commands.push(['filter',index,type])
  })};const app=createApp(Root);app.mount('#app');await tick()
  const select=document.querySelector('select[aria-label="增益显示范围"]')
  const choose=async value=>{select.value=String(value);select.dispatchEvent(new Event('change',{bubbles:true}));await tick()}
  const handle=()=>document.querySelector('.parametric-band-handle')
  expect(handle().style.top==='25%','6 dB node at quarter-height in 12 dB range')
  await choose(3)
  expect(handle().style.top==='0%'&&handle().classList.contains('outside-range'),'offscreen band stays reachable')
  expect(bands.value[0].gain===6&&edits===0&&commits===0,'range change never applies audio')
  expect(document.querySelector('.composite-response-line').getAttribute('d').endsWith(',-50.00'),'curve retains unclipped gain')
  const drag=async(dy)=>{
    const el=handle(),rect=el.getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2
    el.setPointerCapture=()=>{};el.hasPointerCapture=()=>false
    el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:1,clientX:x,clientY:y}))
    el.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:1,clientX:x+1,clientY:y+dy}))
    el.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:1,clientX:x+1,clientY:y+dy}))
    await tick()
  }
  await drag(0)
  expect(bands.value[0].gain===6,'horizontal drag of offscreen band does not jump to visible boundary')
  await choose(30)
  expect(handle().style.top==='40%','same band scales to 30 dB view')
  const surface=document.querySelector('.parametric-graph-surface'),rect=surface.getBoundingClientRect()
  surface.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/4}));await tick()
  expect(primary.value===-1&&selected.value.length===0&&added===null,'background click clears selection without creating a band')
  surface.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/4}));await tick()
  expect(Math.abs(added.gain-15)<0.1,'new band reads current range')
  await drag(-rect.height)
  expect(bands.value[0].gain===24,'drag caps at DSP limit, independent of 30 dB view')
  await choose(6)
  expect([...document.querySelectorAll('.gain-labels span')].map(el=>el.textContent.trim()).join(',')==='+6,+4,+2,0,-2,-4,-6','grid follows range')
  const button=text=>[...document.querySelectorAll('button')].find(el=>el.textContent.trim()===text)
  const live=()=>document.querySelector('.live-spectrum-line').getAttribute('d')
  const peak=()=>document.querySelector('.spectrum-peak-line').getAttribute('d')
  button('峰值保持').click();await tick()
  spectrum.value=new Float32Array(16).fill(0.9);await tick();await tick()
  const held=peak();expect(held&&live()===held,'peak catches incoming maximum')
  button('冻结').click();await tick();const frozenPath=live()
  spectrum.value=new Float32Array(16).fill(0.2);await tick();await tick()
  expect(live()===frozenPath&&peak()===held,'freeze retains displayed and peak curves')
  button('冻结').click();await tick();await tick()
  expect(live()!==frozenPath&&peak()===held,'resume updates live curve while retaining peak')
  button('清除峰值').click();await tick();expect(peak()===live(),'clear restarts from displayed spectrum')
  document.querySelector('.analyzer-controls details').open=true
  const windowSelect=document.querySelector('select[aria-label="频谱显示窗口"]');windowSelect.value='60';windowSelect.dispatchEvent(new Event('change',{bubbles:true}));await tick()
  expect(document.querySelector('.spectrum-scale').textContent.includes('-50 dB'),'spectrum scale follows its own range')
  const speedSelect=document.querySelector('select[aria-label="频谱回落速度"]');speedSelect.value='slow';speedSelect.dispatchEvent(new Event('change',{bubbles:true}));await tick()
  expect(speedSelect.value==='slow','release control remains selected')
  const savedRaf=window.requestAnimationFrame,savedCancel=window.cancelAnimationFrame
  const frames=new Map();let frameId=0
  window.requestAnimationFrame=callback=>{frames.set(++frameId,callback);return frameId}
  window.cancelAnimationFrame=id=>frames.delete(id)
  document.documentElement.dataset.teMotion='full'
  spectrum.value=new Float32Array(16).fill(0.9);await tick()
  expect(frames.size===1,'live display schedules one animation')
  button('冻结').click();await tick()
  expect(frames.size===0,'freeze cancels the scheduled animation')
  const still=live();spectrum.value=new Float32Array(16).fill(0.4);await tick()
  expect(live()===still&&frames.size===0,'frozen input cannot restart animation')
  button('冻结').click();await tick()
  expect(frames.size===1,'unfreeze schedules resumed display')
  visible.value=false;await tick()
  expect(live()===''&&peak()===''&&frames.size===0,'hiding clears paths and stops animation')
  visible.value=true;await tick()
  expect(peak()===live(),'showing restarts peak history from the current spectrum')
  expect(edits===2&&commits===2,'analyzer controls never preview or commit EQ edits')
  app.unmount();expect(frames.size===0,'unmount cancels pending animation')
  window.requestAnimationFrame=savedRaf;window.cancelAnimationFrame=savedCancel
  document.documentElement.dataset.teMotion='off'
  const original=[{frequency:100,gain:6,q:1,filterType:'peak',channelMask:1},{frequency:1000,gain:3,q:2,filterType:'lowShelf',enabled:false},{frequency:5000,gain:5,q:1,filterType:'lowPass'}]
  bands.value=original.map(band=>({...band}));primary.value=0;selected.value=[0];range.value=12;edits=0;commits=0;added=null
  const groupApp=createApp(Root);groupApp.mount('#app');await tick()
  const handles=()=>[...document.querySelectorAll('.parametric-band-handle')]
  const pick=async(index,modifiers={})=>{
    const el=handles()[index],rect=el.getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2
    el.setPointerCapture=()=>{};el.hasPointerCapture=()=>false
    el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:8,clientX:x,clientY:y,...modifiers}))
    el.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,button:0,pointerId:8,clientX:x,clientY:y,...modifiers}))
    el.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1,...modifiers}));await tick()
  }
  const selection=()=>[...selected.value].sort((a,b)=>a-b).join(',')
  await pick(1,{ctrlKey:true});expect(selection()==='0,1','Ctrl click adds a band without duplicate click toggling')
  await pick(2,{metaKey:true});expect(selection()==='0,1,2','Command click adds a band')
  await pick(1,{ctrlKey:true});expect(selection()==='0,2','Ctrl click removes one selected band')
  await pick(0,{shiftKey:true});expect(selection()==='0,1,2','Shift range uses frequency order')
  expect(handles().every(el=>el.getAttribute('aria-pressed')==='true'),'all selected nodes are announced and highlighted')
  expect(document.querySelector('.band-state').textContent.includes('已选 3'),'inspector identifies a group')
  expect(edits===0&&commits===0,'selection alone does not edit or commit audio')
  const groupSurface=document.querySelector('.parametric-graph-surface'),groupRect=groupSurface.getBoundingClientRect()
  const startGesture=index=>{
    const el=handles()[index],rect=el.getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2
    el.setPointerCapture=()=>{};el.hasPointerCapture=()=>false
    el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:9,clientX:x,clientY:y}))
    return {el,x,y}
  }
  const moveGesture=(gesture,dx,dy)=>gesture.el.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:9,clientX:gesture.x+dx,clientY:gesture.y+dy}))
  const endGesture=gesture=>gesture.el.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:9,clientX:gesture.x,clientY:gesture.y}))
  const gesture=startGesture(0);moveGesture(gesture,groupRect.width*0.05,-groupRect.height*0.25);endGesture(gesture);await tick()
  expect(commits===1&&edits===1,'group drag previews and commits once')
  expect(Math.abs(bands.value[0].frequency/original[0].frequency-bands.value[2].frequency/original[2].frequency)<1e-5,'frequency ratios survive grouped dragging')
  expect(Math.abs(bands.value[0].gain-12)<0.01&&Math.abs(bands.value[1].gain-6)<0.01,'gains scale proportionally')
  expect(bands.value[2].gain===5&&bands.value[1].enabled===false&&bands.value[0].channelMask===1,'group drag preserves gainless, bypass and channel semantics')
  const crossing=startGesture(0);moveGesture(crossing,0,groupRect.height*0.5);await tick()
  expect(Math.abs(bands.value[0].gain)<0.01&&Math.abs(bands.value[1].gain)<0.01,'group passes through zero together')
  moveGesture(crossing,0,groupRect.height);endGesture(crossing);await tick()
  expect(Math.abs(bands.value[0].gain+12)<0.01&&Math.abs(bands.value[1].gain+6)<0.01,'group restores ratios after crossing zero')
  bands.value=original.map(band=>({...band}));primary.value=0;selected.value=[0];await tick();edits=0;commits=0
  groupSurface.setPointerCapture=()=>{};groupSurface.hasPointerCapture=()=>false
  const box=async(left,top,right,bottom,modifiers={},cancel=false)=>{
    groupSurface.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:10,clientX:groupRect.left+left*groupRect.width,clientY:groupRect.top+top*groupRect.height,...modifiers}))
    groupSurface.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:10,clientX:groupRect.left+right*groupRect.width,clientY:groupRect.top+bottom*groupRect.height,...modifiers}));await tick()
    expect(document.querySelector('.band-selection-box'),'dragged selection rectangle is visible')
    groupSurface.dispatchEvent(new PointerEvent(cancel?'pointercancel':'pointerup',{bubbles:true,pointerId:10}));await tick()
    if(!cancel)groupSurface.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));await tick()
  }
  await box(0.15,0.1,0.65,0.45);expect(selection()==='0,1','box includes bypassed bands at their plotted positions')
  expect(added===null&&edits===0&&commits===0,'box selection never creates a band or edits sound')
  await box(0.7,0.45,0.9,0.55,{},true);expect(selection()==='0,1','cancelled selection restores the original set')
  await box(0.7,0.45,0.9,0.55,{ctrlKey:true});expect(selection()==='0,1,2','Ctrl box extends the selection')
  await pick(2,{ctrlKey:true});await pick(1)
  const gainInput=document.querySelector('input[aria-label="增益数值"]');gainInput.value='20';gainInput.dispatchEvent(new Event('change',{bubbles:true}));await tick()
  expect(bands.value[0].gain===24&&bands.value[1].gain===12&&gainInput.value==='12.0','numeric group gain stops together and readout follows the accepted value')
  const qInput=document.querySelector('input[aria-label="Q 值数值"]');qInput.value='20';qInput.dispatchEvent(new Event('change',{bubbles:true}));await tick()
  expect(bands.value[0].q===10&&bands.value[1].q===20,'inspector Q adjusts the entire selection')
  expect(document.querySelector('.band-power').getAttribute('aria-pressed')==='true','mixed bypass group shows enabled while any band is active')
  handles()[1].dispatchEvent(new WheelEvent('wheel',{bubbles:true,deltaY:120}));await tick()
  expect(bands.value[1].q<20&&Math.abs(bands.value[1].q/bands.value[0].q-2)<1e-5,'wheel Q changes the entire selection proportionally')
  await pick(1);expect(commits===3,'finishing grouped wheel movement commits once')
  const previousFrequency=bands.value[0].frequency
  handles()[1].dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'ArrowRight'}));await tick()
  expect(bands.value[0].frequency>previousFrequency&&Math.abs(bands.value[1].frequency/bands.value[0].frequency-10)<1e-5,'keyboard frequency changes preserve group ratios')
  groupSurface.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));await tick()
  expect(selection()===''&&primary.value===-1&&!document.querySelector('.band-inspector'),'background deselects and hides the group inspector')
  expect(commits===4,'numeric, wheel and keyboard group changes each commit once')
  bands.value=original.map(band=>({...band}));primary.value=0;selected.value=[0,1];edits=0;commits=0;await tick()
  const openMenu=async index=>{
    menu=null
    const element=index===null?groupSurface:handles()[index]
    element.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}));await tick()
    expect(menu,'right click requests a native menu')
  }
  const menuItem=label=>menu.items.flatMap(item=>[item,...(item.submenu??[])]).find(item=>item.label===label)
  const chooseMenu=async label=>{const item=menuItem(label);expect(item?.enabled,'requested action is enabled');resolveMenu(item.id);await tick()}
  await openMenu(1)
  expect(selection()==='0,1'&&primary.value===1,'right click on selected node preserves the group and changes the primary')
  expect(menuItem('复制所选频段')&&menuItem('旁路所选频段'),'group menu exposes clipboard and uniform bypass')
  await chooseMenu('复制所选频段');expect(copies.join(',')==='false'&&edits===0&&commits===0,'copy selection does not preview or commit audio')
  await openMenu(0);await chooseMenu('高通');expect(commands.at(-1).join(',')==='filter,0,highPass','filter submenu forwards the primary and type through the existing group apply')
  await openMenu(0);await chooseMenu('重置所选增益')
  expect(bands.value[0].gain===0&&bands.value[1].gain===0&&edits===1&&commits===1,'menu reset applies every gain-capable selected band once')
  await openMenu(0);await chooseMenu('旁路所选频段');expect(commands.at(-1).join(',')==='toggle,0','group bypass uses existing page action')
  await openMenu(0);await chooseMenu('删除所选频段');expect(commands.at(-1).join(',')==='delete,0','group delete uses existing page action')
  await openMenu(2);expect(selection()==='2'&&!menuItem('重置所选增益').enabled,'right click on unselected gainless node selects it and disables gain reset')
  await chooseMenu('全选频段');expect(selection()==='0,1,2'&&commits===1,'menu select all has no audio side effect')
  await openMenu(null);expect(!menuItem('删除所选频段')&&!menuItem('复制所选频段'),'background menu only offers whole-editor actions')
  await chooseMenu('复制全部频段');expect(copies.at(-1)===true,'background copy includes every band')
  menu=null;handles()[1].dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'F10',shiftKey:true}));await tick()
  expect(menu&&menuItem('复制所选频段'),'Shift F10 opens a node menu from keyboard focus');resolveMenu(null);await tick()
  bands.value=[];selected.value=[];primary.value=-1;await tick()
  await openMenu(null);expect(!menuItem('复制全部频段').enabled&&menuItem('粘贴频段').enabled,'empty editor can paste but cannot copy')
  await chooseMenu('粘贴频段');expect(pastes===1,'paste command reaches page coordinator')
  bands.value=Array.from({length:32},()=>({...original[0]}));selected.value=[0];primary.value=0;await tick()
  await openMenu(null);expect(!menuItem('粘贴频段').enabled,'full editor disables menu paste');resolveMenu(menuItem('粘贴频段').id);await tick()
  expect(pastes===1,'disabled paste cannot trigger even if a selected ID is returned')
  clipboardBusy.value=true;await tick();menu=null
  groupSurface.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));await tick();expect(menu===null,'busy clipboard prevents overlapping menus')
  clipboardBusy.value=false;view.value='headphone';await tick();menu=null
  groupSurface.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));await tick();expect(menu===null,'headphone response cannot edit or copy manual bands through context menu')
  view.value='dsp';clipboardBusy.value=false;await tick()
  const panel=()=>document.querySelector('.floating-band-inspector')
  const panelRect=()=>panel().getBoundingClientRect()
  const near=(a,b)=>Math.abs(a-b)<1.5
  const beginPanelMove=(pointerId=30)=>{
    const handle=panel(),region=handle.querySelector('.band-inspector'),rect=region.getBoundingClientRect(),x=rect.left+7,y=rect.top+8
    let captured=false
    handle.setPointerCapture=()=>{captured=true};handle.hasPointerCapture=()=>captured;handle.releasePointerCapture=()=>{captured=false}
    const dispatch=(type,dx=0,dy=0,id=pointerId)=>region.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,button:0,pointerId:id,clientX:x+dx,clientY:y+dy}))
    dispatch('pointerdown')
    return {handle,dispatch,captured:()=>captured}
  }
  const originalPanel=panelRect(),beforeMoveEdits=edits,beforeMoveCommits=commits
  expect(!document.querySelector('.inspector-drag-handle'),'panel has no visible drag bar')
  const idleClick=beginPanelMove();idleClick.dispatch('pointerup');await tick()
  const savedGain=bands.value[0].gain
  bands.value=bands.value.map((band,index)=>index===0?{...band,gain:-12}:band);await tick()
  expect(!near(panelRect().top,originalPanel.top),'clicking without moving keeps automatic panel placement')
  bands.value=bands.value.map((band,index)=>index===0?{...band,gain:savedGain}:band);await tick()
  const panelGesture=beginPanelMove();await tick()
  expect(near(panelRect().left,originalPanel.left)&&near(panelRect().top,originalPanel.top),'grabbing the panel preserves its position and grab offset')
  expect(panel().classList.contains('moving')&&panelGesture.captured(),'panel starts pointer capture and immediate drag feedback')
  panelGesture.dispatch('pointermove',40,-50,31);await tick()
  expect(near(panelRect().left,originalPanel.left),'unrelated pointer cannot move the panel')
  panelGesture.dispatch('pointermove',40,-50);await tick()
  expect(near(panelRect().left,originalPanel.left+40)&&near(panelRect().top,originalPanel.top-50),'panel tracks pointer movement in both axes')
  panelGesture.dispatch('pointerup',40,-50);await tick()
  expect(!panel().classList.contains('moving')&&!panelGesture.captured(),'release clears the drag and pointer capture')
  const placedPanel=panelRect()
  primary.value=2;selected.value=[2];await tick()
  expect(near(panelRect().left,placedPanel.left)&&near(panelRect().top,placedPanel.top),'switching bands retains manual placement')
  const cancelledMove=beginPanelMove();cancelledMove.dispatch('pointermove',-20,-20);await tick();cancelledMove.dispatch('pointercancel');await tick()
  expect(near(panelRect().left,placedPanel.left)&&near(panelRect().top,placedPanel.top)&&!cancelledMove.captured(),'cancel restores the original placement and releases capture')
  const escapedMove=beginPanelMove();escapedMove.dispatch('pointermove',-20,-20);await tick()
  escapedMove.handle.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Escape'}));await tick()
  expect(panel()&&near(panelRect().left,placedPanel.left)&&near(panelRect().top,placedPanel.top)&&!escapedMove.captured(),'Escape cancels panel movement without closing it')
  panel().dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'ArrowDown'}));await tick()
  panel().dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'ArrowLeft',shiftKey:true}));await tick()
  expect(near(panelRect().left,placedPanel.left-1)&&near(panelRect().top,placedPanel.top+10),'keyboard movement supports normal and fine steps')
  const afterKeyboard=panelRect()
  panel().dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'ArrowUp',ctrlKey:true}));await tick()
  expect(near(panelRect().top,afterKeyboard.top),'modified shortcuts do not reposition the panel')
  const lostMove=beginPanelMove();lostMove.dispatch('pointermove',-10,-10);await tick();lostMove.dispatch('lostpointercapture');await tick()
  expect(!panel().classList.contains('moving'),'losing pointer capture finishes panel movement')
  document.querySelector('button[aria-label="收起频段面板"]').click();await tick();expect(!panel(),'close still hides the panel')
  await pick(0);expect(panel()&&near(panelRect().left,afterKeyboard.left-10)&&near(panelRect().top,afterKeyboard.top-10),'reopening preserves the chosen position')
  const inputRect=panelRect()
  const controlTestClick=beginPanelMove(44);controlTestClick.dispatch('pointerup');await tick()
  for(const selector of ['input[aria-label="频率数值"]','select[aria-label="滤波器类型"]','.band-power','.band-number']){
    const element=panel().querySelector(selector),event=new PointerEvent('pointerdown',{bubbles:true,cancelable:true,button:0,pointerId:45})
    element.dispatchEvent(event);await tick()
    if(selector==='.band-number'){
      expect(panel().classList.contains('moving'),'band identity can also move the panel')
      panel().dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:45}));await tick()
    }else expect(!event.defaultPrevented&&!panel().classList.contains('moving'),'controls preserve their own pointer defaults and never start panel movement')
  }
  const numeric=panel().querySelector('input[aria-label="频率数值"]')
  numeric.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));await tick()
  numeric.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'ArrowRight'}));await tick()
  expect(near(panelRect().left,inputRect.left)&&near(panelRect().top,inputRect.top),'input double clicks and arrow keys do not reset or move the panel')
  panel().querySelector('.band-inspector').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));await tick()
  expect(near(panelRect().left,originalPanel.left)&&near(panelRect().top,originalPanel.top),'double click restores automatic node avoidance')
  panel().dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Escape'}));await tick()
  expect(!panel(),'Escape on an idle focused panel keeps its close behavior');await pick(0)
  workspaceZoom.value=1.25;await tick();await tick()
  const scaledPanel=panelRect(),scaledMove=beginPanelMove();scaledMove.dispatch('pointermove',30,-40);await tick();scaledMove.dispatch('pointerup',30,-40);await tick()
  expect(near(panelRect().left,scaledPanel.left+30)&&near(panelRect().top,scaledPanel.top-40),'panel tracks the pointer at scaled UI zoom')
  workspaceZoom.value=1;await tick();await tick()
  const boundaryMove=beginPanelMove();boundaryMove.dispatch('pointermove',10000,10000);await tick();boundaryMove.dispatch('pointerup',10000,10000);await tick()
  const insidePlot=()=>{const p=panelRect(),s=groupSurface.getBoundingClientRect();return p.left>=s.left-1&&p.top>=s.top-1&&p.right<=s.right+1&&p.bottom<=s.bottom+1}
  expect(insidePlot(),'oversized drags keep all panel controls inside the plot')
  workspaceWidth.value=850;workspaceHeight.value=500;await tick();await tick();expect(insidePlot(),'resize reclamps the entire floating panel')
  workspaceWidth.value=720;await tick();await tick()
  expect(!panel().classList.contains('movable')&&getComputedStyle(panel()).position==='relative'&&getComputedStyle(panel()).transform==='none','compact screens dock the panel and disable movement')
  const compactDrag=beginPanelMove();compactDrag.dispatch('pointermove',40,20);await tick()
  expect(!panel().classList.contains('moving')&&!compactDrag.captured(),'docked panel cannot start dragging')
  workspaceWidth.value=900;workspaceHeight.value=600;await tick();await tick();expect(panel().classList.contains('movable')&&insidePlot(),'expanding restores the movable panel within bounds')
  expect(edits===beforeMoveEdits&&commits===beforeMoveCommits,'moving, cancelling, resizing and resetting the panel never edit or commit EQ')
  const beforeKnob=panelRect(),qBefore=bands.value[0].q,qFace=document.querySelector('.eq-parameter-knob.q .knob-face'),qRect=qFace.getBoundingClientRect()
  qFace.setPointerCapture=()=>{};qFace.hasPointerCapture=()=>false
  qFace.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:33,clientX:qRect.left+20,clientY:qRect.top+20}))
  expect(!panel().classList.contains('moving'),'knob pointer gesture cannot start panel movement')
  qFace.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:33,clientX:qRect.left+20,clientY:qRect.top-10}));await tick()
  qFace.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:33}));await tick()
  expect(bands.value[0].q!==qBefore&&near(panelRect().left,beforeKnob.left)&&near(panelRect().top,beforeKnob.top),'knob drag changes its parameter without moving the panel')
  expect(commits===beforeMoveCommits+1,'knob interaction retains one audio commit')
  groupApp.unmount()
  {
  const nativeRequest=window.requestAnimationFrame,nativeCancel=window.cancelAnimationFrame
  const hiddenDescriptor=Object.getOwnPropertyDescriptor(document,'hidden')
  const frames=new Map();let nextFrame=1,hidden=false,now=0,lineWrites=0,peakWrites=0
  window.requestAnimationFrame=callback=>{const id=nextFrame++;frames.set(id,callback);return id}
  window.cancelAnimationFrame=id=>frames.delete(id)
  Object.defineProperty(document,'hidden',{configurable:true,get:()=>hidden})
  const step=()=>{now+=16.7;const batch=[...frames.values()];frames.clear();for(const callback of batch)callback(now)}
  const levels=ref(new Float32Array(16).fill(0.3));let analyzer
  const analyzerApp=createApp({setup(){analyzer=useEqSpectrum({levels:()=>levels.value,visible:()=>true,frozen:()=>false});return()=>h('svg',[h('path',{ref:analyzer.lineRef}),h('path',{ref:analyzer.fillRef}),h('path',{ref:analyzer.peakRef})])}})
  try {
    document.documentElement.dataset.teMotion='off';analyzerApp.mount('#app');await nextTick()
    const countWrites=(element,count)=>{const original=element.setAttribute.bind(element);element.setAttribute=(name,value)=>{if(name==='d')count();original(name,value)}}
    countWrites(analyzer.lineRef.value,()=>lineWrites++);countWrites(analyzer.peakRef.value,()=>peakWrites++)
    document.documentElement.dataset.teMotion='full';await nextTick();step()
    for(let i=0;i<8;i++){levels.value=new Float32Array(16).fill(0.4+i*0.03);await nextTick()}
    expect(frames.size===1&&lineWrites===0,'eight input updates coalesce into one frame without eager path writes')
    step();expect(lineWrites===1,'one rendered frame writes the line once')
    analyzer.peakHold.value=true;await nextTick();peakWrites=0
    levels.value=new Float32Array(16).fill(0.1);await nextTick();for(let i=0;i<10;i++)step()
    expect(peakWrites===0,'held peak path is not rewritten during release interpolation')
    hidden=true;document.dispatchEvent(new Event('visibilitychange'))
    expect(frames.size===0,'hidden analyzer cancels pending frames immediately')
    for(let i=0;i<8;i++){levels.value=new Float32Array(16).fill(0.8);await nextTick()}
    expect(frames.size===0,'hidden input updates schedule no frames')
    hidden=false;document.dispatchEvent(new Event('visibilitychange'));await nextTick();step()
    expect(analyzer.lineRef.value.getAttribute('d').includes(',29.20'),'resume snaps to current data without stale animation')
    levels.value=new Float32Array(16).fill(0.2);await nextTick()
    expect(frames.size===1,'visible full motion resumes interpolation')
    document.documentElement.dataset.teMotion='off';await nextTick()
    expect(frames.size===0&&analyzer.lineRef.value.getAttribute('d').includes(',80.80'),'live motion off cancels interpolation and paints current data')
    document.documentElement.dataset.teMotion='full';await nextTick()
    analyzerApp.unmount();expect(frames.size===0,'unmount releases pending animation')
  } finally {
    analyzerApp.unmount();window.requestAnimationFrame=nativeRequest;window.cancelAnimationFrame=nativeCancel
    if(hiddenDescriptor)Object.defineProperty(document,'hidden',hiddenDescriptor);else delete document.hidden
    document.documentElement.dataset.teMotion='off'
  }
  }
  window.renderEqSpectrumPreview=async()=>{
    document.documentElement.dataset.teMotion='off'
    document.documentElement.dataset.theme='dark'
    bands.value=[{frequency:1000,gain:-4,q:1,filterType:'peak'}]
    primary.value=0;selected.value=[0]
    spectrum.value=Float32Array.from({length:720},(_,i)=>Math.max(0,Math.min(1,0.22+0.54*Math.exp(-Math.pow((i-180)/90,2))+0.46*Math.exp(-Math.pow((i-500)/120,2))+0.025*Math.sin(i/5))))
    createApp(Root).mount('#app');await tick()
    button('峰值保持').click();document.querySelector('.analyzer-controls details').open=true;await tick()
  }

}
`
