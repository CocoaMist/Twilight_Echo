import { createApp, defineComponent, h, nextTick, ref, shallowRef } from 'vue'
import ExternalPlaylistImportDialog from './ExternalPlaylistImportDialog.vue'
import ImportedPlaylistDetail from './ImportedPlaylistDetail.vue'
import PlaylistLibraryPage from './navigation/PlaylistLibraryPage.vue'
import '../assets/base.css'
import '../assets/primeicons.css'

const pause=()=>new Promise(resolve=>setTimeout(resolve,30))
const settle=async()=>{await nextTick();await pause();await nextTick()}
const button=text=>[...document.querySelectorAll('button')].find(item=>item.textContent.trim()===text)
const expect=(value,message)=>{if(!value)throw new Error(message)}
window.runExternalPlaylistImportTests=async screenshot=>{
  const imported=[]
  const songs=[{title:'夜曲',artist:'周杰伦',album:'十一月的萧邦',duration:180},{title:'夜曲',artist:'周杰伦',album:'十一月的萧邦',duration:180}]
  const importDocument={name:'夜间歌单',songs,source:{kind:'file',label:'mix.m3u8'},warnings:[],complete:true,total:2}
  window.auditMusic={
    playlists:shallowRef([]),tracks:ref([]),persistedWrites:0,
    createExternalPlaylist(document,transient=false){const id=`playlist-${imported.length+1}`;const playlist={id,name:document.name,trackIds:[],createdAt:'',...(transient?{transient:true}:{}),imported:{version:1,source:document.source,entries:document.songs.map((original,position)=>({entryId:`entry-${position+1}`,position,original,revision:0,resolution:{state:'pending'}})),generation:'generation',membershipRevision:0,complete:true}};this.playlists.value=[...this.playlists.value,playlist];if(!transient)this.persistedWrites++;imported.push({id,document,transient});return id},
    saveExternalPlaylist(id){const playlist=this.playlists.value.find(item=>item.id===id);delete playlist.transient;this.persistedWrites++;return id},discardExternalPlaylist(id){this.playlists.value=this.playlists.value.filter(item=>item.id!==id)},
    appendExternalPlaylistPage(){return true},setExternalPlaylistReadError(){return true},refreshExternalPlaylist(){return 'copy'},removeExternalEntries(){},bindExternalEntry(){},applyExternalResolutions(){return true}
  }
  window.api={
    playlistImport:{chooseFile:async()=>importDocument,readPage:async()=>({songs:[],total:0,nextOffset:0,hasMore:false}),cancelRead:async()=>true},
    library:{getStorageMode:async()=>'json',onChanged:()=>()=>{}},
    plugins:{onChanged:()=>()=>{}},
    fs:{isAudioFileAuthorized:async()=>true}
  }
  const show=ref(true),mounted=createApp(defineComponent({setup:()=>()=>h(ExternalPlaylistImportDialog,{show:show.value,onClose:()=>show.value=false,onImported:()=>{}})}))
  mounted.mount(document.body.appendChild(document.createElement('div')))
  await button('选择文件').click();await settle()
  document.querySelector('.file-choice').click();await settle()
  expect(document.body.textContent.includes('2 条'),'import preview should retain both repeated occurrences')
  expect(document.querySelectorAll('.preview ol li').length===2,'both occurrences should be visible in the preview')
  if(screenshot){window.__externalPlaylistPhase='preview';window.dispatchEvent(new CustomEvent('external-playlist-phase',{detail:'preview'}));await new Promise(resolve=>window.__resumeAfterImportPreview=resolve)}
  await button('查看并匹配歌曲').click();await settle()
  expect(imported.length===1&&imported[0].document.songs.length===2,'staged import must retain every occurrence')
  expect(imported[0].transient&&window.auditMusic.persistedWrites===0,'import must stay out of the saved playlist library until explicit save')
  mounted.unmount();document.body.innerHTML=''

  const song={title:'夜曲',artist:'周杰伦',album:'十一月的萧邦',duration:180},playCalls=[]
  const track={id:'local-1',title:'夜曲',artist:'周杰伦',album:'十一月的萧邦',filePath:'D:/Music/1.flac',fileName:'1.flac',duration:180,size:1,cover:null,lyrics:null,source:'local'}
  window.auditProviderRegistry={list:()=>[],get:()=>undefined}
  const playlist={id:imported[0].id,name:'夜间歌单',trackIds:[],createdAt:'',transient:true,imported:{version:1,source:{kind:'file',label:'mix.m3u8'},complete:true,generation:'view-generation',membershipRevision:0,entries:[
    {entryId:'local-entry',position:0,original:song,resolution:{state:'local',track},revision:0},
    {entryId:'missing-entry',position:1,original:{title:'无法播放',artist:'未知歌手'},resolution:{state:'missing',message:'没有匹配到歌曲'},revision:0},
    {entryId:'remote-entry',position:2,original:{title:'青花瓷',artist:'周杰伦'},resolution:{state:'streaming',track:{...track,id:'ncm:2',source:'ncm',filePath:'ncm:2',fileName:'周杰伦 - 青花瓷',title:'青花瓷'}},revision:0}
  ]}}
  window.auditMusic.playlists.value=[playlist];window.auditMusic.tracks.value=[track]
  window.auditPlayer={playTrack:(item,queue)=>playCalls.push({item,queue})}
  window.auditService={run(){},stop(){},schedule(_source,action){return action()}}
  const detail=createApp(defineComponent({setup:()=>()=>h(ImportedPlaylistDetail,{playlistId:imported[0].id,onBack:()=>{},onNavigate:()=>{}})}))
  detail.mount(document.body.appendChild(document.createElement('div')));await new Promise(resolve=>setTimeout(resolve,320));await settle()
  const visibleRows=document.querySelectorAll('.song-row:not(.table-heading)')
  expect(visibleRows.length===3,`all imported occurrences should be displayed; got ${visibleRows.length}: ${document.querySelector('.external-detail')?.textContent.slice(0,600) || document.body.textContent.slice(0,600)}`)
  const unavailable=document.querySelector('.song-row.unavailable')
  expect(unavailable?.querySelector('.title-button')?.disabled&&unavailable.querySelector('.state')?.getAttribute('title')==='没有匹配到歌曲','unavailable entry must remain disabled and expose its reason')
  expect(!document.querySelector('.actions .primary')?.disabled,'play should stay available when at least one source resolved')
  visibleRows[0].dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:120,clientY:140}));await settle()
  expect(document.querySelector('.match-dialog'),'right-clicking a song row should open source selection')
  document.querySelector('.match-dialog [aria-label="关闭选源"]').click();await settle()
  if(screenshot)document.body.setAttribute('data-capture-preview','imported-detail')
  if(screenshot)document.body.setAttribute('data-capture-staged','true')
  if(!screenshot){button('保存到歌单').click();await settle();expect(!playlist.transient&&window.auditMusic.persistedWrites===1,'saving from detail should commit the staged playlist')}
  button('▶ 播放可用歌曲').click();await settle()
  expect(playCalls.length===1&&playCalls[0].queue.length===2,'unavailable entries must be excluded from playback queue')
  expect(new Set(playCalls[0].queue.map(item=>item.queueEntryId)).size===2,'each playable occurrence needs its own queue identity')
  detail.unmount();document.body.innerHTML=''

  const catalogEvents=[]
  window.auditMusic.getPlaylistTracksById=()=>[]
  window.auditMusic.createPlaylist=()=> 'new-playlist'
  window.auditMusic.setPlaylistPinned=()=>true
  window.auditMusic.deletePlaylist=()=>true
  window.auditMusic.createAggregatePlaylist=()=> 'new-aggregate'
  window.auditMusic.addTracksToPlaylistById=()=>0
  window.auditMusic.playlists.value=[
    {id:'regular',name:'应用歌单',trackIds:[],createdAt:''},
    {id:'aggregate',name:'聚合歌单',trackIds:[],createdAt:'',kind:'aggregate'},
    {id:'staged',name:'暂存歌单',trackIds:[],createdAt:'',transient:true,imported:{source:{label:'文件'},entries:[{entryId:'one'}]}}
  ]
  const catalog=createApp(defineComponent({setup:()=>()=>h(PlaylistLibraryPage,{onSelectView:(...event)=>catalogEvents.push(event),onImportExternal:()=>catalogEvents.push(['import'])})}))
  catalog.mount(document.body.appendChild(document.createElement('div')));await settle()
  expect(document.querySelectorAll('.playlist-card').length===3,'application, aggregate and staged playlists should share one catalogue')
  document.querySelector('[aria-label="打开聚合歌单"]').click();await settle()
  expect(JSON.stringify(catalogEvents.at(-1))===JSON.stringify(['aggregate','aggregate']),'aggregate card should retain aggregate detail navigation')
  document.querySelector('[aria-label="打开暂存歌单"]').click();await settle()
  expect(JSON.stringify(catalogEvents.at(-1))===JSON.stringify(['playlists','external-playlist:staged']),'staged external card should reopen its detail page')
  button('导入外部歌单').click();await settle()
  expect(catalogEvents.some(event=>event[0]==='import'),'the unified catalogue should retain the external import entry point')
  if(screenshot)document.body.setAttribute('data-capture-preview','unified-playlist-catalogue')
  if(!screenshot)catalog.unmount()
  return {previewOccurrences:2,detailRows:3,playableQueue:playCalls[0].queue.length,imported:imported.length,stagedUntilSaved:true,rightClickSourceSelection:true,unifiedPlaylistCards:3}
}
