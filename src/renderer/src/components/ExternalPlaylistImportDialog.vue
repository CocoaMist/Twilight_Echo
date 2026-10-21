<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useEscapeToClose, useFocusTrap } from '../app/useDismissLayer.ts'
import { useMusicStore } from '../stores/useMusicStore'
import { externalPlaylistAdapter } from '../utils/externalPlaylistReader.ts'
import { recognizePlaylistLink, previewImportUpdate, IMPORT_PLATFORM_NAMES, type PlaylistImportDocument } from '../../../shared/externalPlaylist.ts'
import { detectImportColumns, mapImportTable, type ImportColumnMap } from '../../../shared/playlistImportTable.ts'

const props=defineProps<{show:boolean;playlistId?:string}>()
const emit=defineEmits<{close:[];imported:[id:string,name:string]}>()
const music=useMusicStore(),dialog=ref<HTMLElement|null>(null),mode=ref<'file'|'link'>('link'),url=ref(''),busy=ref(false),error=ref(''),document=shallowRef<PlaylistImportDocument|null>(null),name=ref(''),read=ref(0),total=ref(0),partialId=ref(''),overwrite=ref(false),selectedList=ref(0),resolvedLink=shallowRef<import('../../../shared/externalPlaylist.ts').PlaylistLink|null>(null)
const accessToken=ref(''),developerToken=ref(''),userToken=ref(''),country=ref('US'),mapping=ref<ImportColumnMap>({})
let controller:AbortController|undefined,previewGeneration=''
const target=computed(()=>music.playlists.value.find(p=>p.id===props.playlistId))
const platform=computed(()=>{try{return recognizePlaylistLink(url.value).platform}catch{return null}})
const diff=computed(()=>target.value?.imported&&document.value?previewImportUpdate(target.value.imported.entries,document.value.songs):null)
const fields=['title','artist','album','duration','isrc','location'] as const
const fieldNames={title:'歌名',artist:'艺术家',album:'专辑',duration:'时长',isrc:'ISRC',location:'路径 / URL'}
function close(){controller?.abort();accessToken.value='';developerToken.value='';userToken.value='';emit('close')}
useEscapeToClose(()=>props.show,close);useFocusTrap(dialog,()=>props.show)
onBeforeUnmount(()=>controller?.abort())
watch(()=>props.show,show=>{if(!show)return;document.value=null;error.value='';busy.value=false;partialId.value='';read.value=0;overwrite.value=false;const source=target.value?.imported?.source;url.value=source?.url||'';mode.value=source?.kind==='file'?'file':'link';previewGeneration=target.value?.imported?.generation||''})
function preview(value:PlaylistImportDocument){document.value=value;name.value=value.name;mapping.value=detectImportColumns(value.columns??[]);selectedList.value=0}
async function chooseFile(){busy.value=true;error.value='';try{const result=await window.api.playlistImport.chooseFile();if(result)preview(result)}catch(e){error.value=String(e)}finally{busy.value=false}}
function mapColumns(){try{if(document.value?.table)document.value={...document.value,songs:mapImportTable(document.value.table,mapping.value)};error.value=''}catch(e){error.value=String(e)}}
function selectList(){const list=document.value?.playlists?.[selectedList.value];if(list&&document.value){document.value={...document.value,songs:list.songs};name.value=list.name}}
async function readLink(){
  controller?.abort();controller=new AbortController();const signal=controller.signal
  busy.value=true;error.value='';document.value=null;read.value=0
  let generation=''
  try{
    resolvedLink.value=null
    const result=await externalPlaylistAdapter.read(url.value,{signal,credentials:{accessToken:accessToken.value||undefined,developerToken:developerToken.value||undefined,userToken:userToken.value||undefined,country:country.value},onPage(page){
      read.value+=page.songs.length;total.value=page.total
      if(!props.playlistId){
        if(!partialId.value){const link=resolvedLink.value;if(!link)throw new Error('歌单链接尚未解析');partialId.value=music.createExternalPlaylist({name:page.name||`${IMPORT_PLATFORM_NAMES[link.platform]} 导入`,songs:[],source:{kind:'platform',label:IMPORT_PLATFORM_NAMES[link.platform],platform:link.platform,playlistId:link.id,url:link.url},complete:false,total:page.total,warnings:[]},true);generation=music.playlists.value.find(p=>p.id===partialId.value)!.imported!.generation;const p=music.playlists.value.find(p=>p.id===partialId.value)!;emit('imported',p.id,p.name)}
        if(!music.appendExternalPlaylistPage(partialId.value,generation,page.songs,page.total,!page.hasMore))throw new Error('导入歌单已被修改或删除，已停止读取')
      }
    },onLink(link){resolvedLink.value=link}},window.api.playlistImport)
    if(props.playlistId)preview(result)
    else close()
  }catch(e){
    const message=signal.aborted?'读取已取消，已读条目保留为“不完整”，可手动更新重试':String(e)
    error.value=message
    if(partialId.value)music.setExternalPlaylistReadError(partialId.value,generation,message)
  }finally{busy.value=false;accessToken.value='';developerToken.value='';userToken.value=''}
}
async function commit(){
  if(!document.value?.complete||busy.value)return
  try{
    if(props.playlistId&&target.value?.imported?.generation!==previewGeneration)throw new Error('歌单在预览期间被修改，请重新读取后更新')
    const value={...document.value,name:name.value.trim()||document.value.name}
    const id=props.playlistId?music.refreshExternalPlaylist(props.playlistId,value,overwrite.value):music.createExternalPlaylist(value,true)
    const p=music.playlists.value.find(p=>p.id===id)!
    emit('imported',id,p.name);close()
  }catch(e){error.value=String(e)}
}
</script>

<template>
  <Teleport to="body"><div v-if="show" class="external-import-overlay" @click.self="close">
    <section ref="dialog" class="external-import-dialog" role="dialog" aria-modal="true" aria-labelledby="external-import-title">
      <header><div><span class="eyebrow">PLAYLIST IMPORT</span><h2 id="external-import-title">{{ playlistId ? '更新外部歌单' : '导入外部歌单' }}</h2></div><button aria-label="关闭导入" class="icon-button" @click="close">×</button></header>
      <p class="intro">读取后先进入暂存详情；只有选择“保存到歌单”才会加入歌单库。</p>
      <div class="tabs" role="group" aria-label="导入方式"><button :aria-pressed="mode==='link'" :disabled="busy" @click="mode='link'">粘贴链接</button><button :aria-pressed="mode==='file'" :disabled="busy" @click="mode='file'">选择文件</button></div>
      <div v-if="mode==='link'" class="input-section">
        <label for="external-playlist-link">歌单分享链接</label><input id="external-playlist-link" v-model="url" :disabled="busy||!!partialId" placeholder="网易云、QQ、Spotify、Apple Music…" @keydown.enter="!busy&&!partialId&&readLink()" />
        <p class="hint">国内音源复用已启用插件。Spotify、Apple Music、TIDAL 支持有权限时直读；受限时可切换文件导入。</p>
        <details v-if="['spotify','apple','tidal'].includes(platform||'')"><summary>官方 API 认证</summary><div class="credentials">
          <template v-if="platform==='apple'"><label>开发者令牌<input v-model="developerToken" type="password" autocomplete="off" /></label><label>Music User Token（私人资料库）<input v-model="userToken" type="password" autocomplete="off" /></label></template>
          <label v-else>OAuth 访问令牌<input v-model="accessToken" type="password" autocomplete="off" /></label>
          <label v-if="platform!=='spotify'">地区代码<input v-model="country" maxlength="2" /></label><p class="hint">令牌仅用于本次读取，不随歌单保存。</p>
        </div></details>
        <button v-if="!partialId" class="primary" :disabled="busy||!url.trim()" @click="readLink">{{ busy ? '正在读取…' : playlistId ? '读取更新预览' : '读取歌单' }}</button>
      </div>
      <div v-else class="input-section"><button class="file-choice" :disabled="busy" @click="chooseFile"><span class="file-symbol">↥</span><strong>{{ document?.source.label || '选择歌单文件' }}</strong><span>M3U / M3U8 · PLS · XSPF · WPL · ASX · KGL · Apple XML · CSV / TXT</span></button><p class="hint">每个文件最多 8 MiB、每份歌单最多 20,000 条。FPL / FPLite 使用“歌单文件桥接”插件，或从 foobar2000 导出 M3U8。</p></div>
      <div v-if="busy&&mode==='link'" class="read-progress" role="status"><progress :value="read" :max="Math.max(total,1)"/><span>已读取 {{ read }} / {{ total || '…' }} 条 · 完成前保留“不完整”标记</span><button @click="controller?.abort()">取消读取</button></div>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="partialId&&!busy" class="hint">已读取 {{ read }} 条，暂存状态不会写入歌单库。可查看已读条目或稍后重试完整读取。</p>
      <div v-if="partialId&&!busy" class="partial-actions"><button @click="close">查看暂存歌单</button></div>
      <div v-if="document" class="preview">
        <label>歌单名称<input v-model="name" maxlength="80" /></label>
        <label v-if="(document.playlists?.length||0)>1">选择 Apple 资料库歌单<select v-model="selectedList" @change="selectList"><option v-for="(p,i) in document.playlists" :key="i" :value="i">{{ p.name }}（{{ p.songs.length }}）</option></select></label>
        <details v-if="document.table"><summary>识别列：可调整歌名、艺术家和时长</summary><div class="column-map"><label v-for="field in fields" :key="field">{{ fieldNames[field] }}<select v-model="mapping[field]" @change="mapColumns"><option :value="undefined">未提供</option><option v-for="(column,index) in document.columns" :key="index" :value="index">{{ column }}</option></select></label></div></details>
        <p v-for="warning in document.warnings" :key="warning" class="hint">{{ warning }}</p>
        <p class="preview-heading">{{ document.songs.length }} 条 · 原始顺序与重复歌曲均保留</p>
        <ol><li v-for="(song,i) in document.songs.slice(0,8)" :key="i"><span>{{ song.title || song.locations?.[0]?.split(/[\\/]/).at(-1) || '信息缺失' }}</span><small>{{ song.artist || '艺术家未提供' }}</small></li></ol>
        <p v-if="document.songs.length>8" class="hint">另有 {{ document.songs.length-8 }} 条，导入后分页显示。</p>
        <p v-if="diff" class="diff">新增 {{ diff.added }} · 删除 {{ diff.removed }} · {{ diff.reordered ? '顺序有变化' : '顺序不变' }}</p>
        <label v-if="target?.imported?.locallyEdited" class="overwrite"><input v-model="overwrite" type="checkbox"/>覆盖原歌单中的本地成员编辑（默认另存副本）</label>
        <footer><button @click="close">取消</button><button class="primary" :disabled="busy||!!error" @click="commit">{{ playlistId ? target?.imported?.locallyEdited&&!overwrite ? '另存为副本' : '确认更新' : '查看并匹配歌曲' }}</button></footer>
      </div>
    </section>
  </div></Teleport>
</template>

<style scoped>
.external-import-overlay{position:fixed;inset:0;z-index:1800;display:grid;place-items:center;padding:28px;background:rgb(0 0 0 / .48);backdrop-filter:blur(8px)}
.external-import-dialog{width:min(620px,100%);max-height:calc(100vh - 56px);overflow:auto;background:var(--te-card-bg,#fff);color:var(--te-neutral-900,#171b23);border:1px solid var(--te-card-border,#ddd);border-radius:20px;padding:28px;box-shadow:0 24px 80px #0004;box-sizing:border-box}
header,footer{display:flex;align-items:center;justify-content:space-between;gap:16px}.eyebrow{font-size:11px;font-weight:700;letter-spacing:.18em;color:var(--te-primary-500,#6164de)}h2{font-size:25px;letter-spacing:-.03em;margin:8px 0}.intro,.hint{color:var(--te-neutral-500,#646977);line-height:1.65}.intro{margin:6px 0 22px;font-size:14px}.hint{font-size:12px;margin:10px 0}button,input,select{font:inherit}button{cursor:pointer;border:1px solid var(--te-card-border,#ddd);border-radius:9px;background:var(--te-subtle-bg,#f3f4f7);color:inherit;padding:9px 14px}button:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--te-primary-500,#6164de);outline-offset:2px}.icon-button{background:transparent;border:0;font-size:26px;padding:0 6px}.primary{background:var(--te-primary-500,#6164de);border-color:transparent;color:white}.tabs{display:flex;gap:6px;padding:4px;background:var(--te-subtle-bg,#f3f4f7);border-radius:11px;margin-bottom:22px}.tabs button{flex:1;background:transparent;border-color:transparent}.tabs button[aria-pressed=true]{background:var(--te-card-bg,#fff);box-shadow:0 1px 4px #0001;color:var(--te-primary-500,#6164de)}label{display:flex;flex-direction:column;gap:8px;font-size:13px;font-weight:600}input,select{width:100%;box-sizing:border-box;background:var(--te-subtle-bg,#f3f4f7);color:inherit;border:1px solid var(--te-card-border,#ddd);border-radius:8px;padding:10px 12px}details{margin:14px 0}summary{font-size:13px;cursor:pointer;color:var(--te-neutral-500,#646977)}.credentials,.column-map{display:grid;gap:12px;margin:14px 0}.column-map{grid-template-columns:1fr 1fr}.file-choice{display:flex;flex-direction:column;gap:12px;align-items:center;text-align:center;width:100%;padding:28px 16px;background:var(--te-subtle-bg,#f3f4f7);border:1px dashed var(--te-card-border,#ddd)}.file-choice span:last-child{font-size:12px;line-height:1.6;color:var(--te-neutral-500,#646977)}.file-symbol{font-size:30px;color:var(--te-primary-500,#6164de)}.read-progress{display:grid;gap:10px;font-size:12px;padding:14px;background:var(--te-subtle-bg,#f3f4f7);border-radius:10px}progress{width:100%;accent-color:var(--te-primary-500,#6164de)}.error{font-size:13px;line-height:1.6;color:var(--te-danger-500,#b33a45);background:color-mix(in srgb,currentColor 8%,transparent);padding:12px;border-radius:8px;overflow-wrap:anywhere}.preview{border-top:1px solid var(--te-card-border,#ddd);margin-top:22px;padding-top:20px}.preview>label{margin-bottom:14px}.preview-heading{font-size:13px;font-weight:600}.preview ol{padding-left:24px;font-size:13px}.preview li{padding:6px 0}.preview li span{display:inline-block;max-width:70%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}.preview small{color:var(--te-neutral-500,#646977);margin-left:12px}.diff{font-size:13px;padding:12px;background:var(--te-subtle-bg,#f3f4f7);border-radius:8px}.overwrite{flex-direction:row;align-items:center;font-size:12px;font-weight:400}.overwrite input{width:auto}footer{justify-content:flex-end;margin-top:20px}
</style>
