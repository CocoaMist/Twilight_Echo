import assert from 'node:assert/strict'
import {shallowRef} from 'vue'
import test from 'node:test'
import type {Playlist} from './musicStoreTypes.ts'
import {createExternalPlaylistCommands,importedPlayableTracks} from './externalPlaylistController.ts'
import {replayExternalPlaylist} from './externalPlaylistReplay.ts'
import type {PlaylistImportDocument} from '../../../../shared/externalPlaylist.ts'

const song={title:'Song',artist:'Artist',album:'Album',duration:180}
const doc=(songs= [song,song],complete=true):PlaylistImportDocument=>({name:'Mix',songs,source:{kind:'file',label:'mix.csv'},warnings:[],complete,total:songs.length})
function fixture(){const playlists=shallowRef<Playlist[]>([]),writes:Array<Playlist[]> =[],commands=createExternalPlaylistCommands({playlists,clonePlaylistSnapshot:()=>structuredClone(playlists.value),queuePlaylistPersistence:()=>writes.push(structuredClone(playlists.value))});return {playlists,writes,commands}}
test('stores duplicate metadata entries, matched playable occurrences and independent unavailable entries',()=>{
  const {playlists,commands}=fixture(),track={id:'ncm:1',title:'Song',artist:'Artist',album:'Album',filePath:'ncm:1',fileName:'Song',duration:180,size:0,cover:null,lyrics:null,source:'ncm' as const}
  const id=commands.createExternalPlaylist(doc()),generation=playlists.value[0].imported!.generation
  const entries=playlists.value[0].imported!.entries
  assert.equal(entries.length,2);assert.notEqual(entries[0].entryId,entries[1].entryId)
  commands.applyExternalResolutions(id,generation,entries.map(e=>({entryId:e.entryId,revision:0,resolution:{state:'streaming' as const,track}})))
  assert.equal(importedPlayableTracks(playlists.value[0].imported!.entries).length,2)
  commands.applyExternalResolutions(id,generation,[{entryId:entries[1].entryId,revision:0,resolution:{state:'missing'}}])
  assert.deepEqual(importedPlayableTracks(playlists.value[0].imported!.entries).map(t=>t.queueEntryId),[entries[0].entryId])
})
test('transient imports and their matching edits stay in memory until explicitly saved',()=>{
  const {playlists,writes,commands}=fixture(),id=commands.createExternalPlaylist(doc([song],false),true)
  const playlist=playlists.value[0],entry=playlist.imported!.entries[0]
  assert.equal(playlist.transient,true)
  assert.equal(writes.length,0)
  commands.applyExternalResolution(id,playlist.imported!.generation,entry.entryId,0,{state:'missing',message:'not found'})
  commands.appendExternalPlaylistPage(id,playlist.imported!.generation,[song],2,true)
  assert.equal(playlist.imported!.entries.length,2)
  assert.equal(writes.length,0)
  commands.saveExternalPlaylist(id)
  assert.equal(playlists.value[0].transient,undefined)
  assert.equal(writes.length,1)
  assert.equal(writes[0][0].imported!.entries.length,2)
})
test('incomplete transient imports cannot be saved and can be discarded without persistence',()=>{
  const {playlists,writes,commands}=fixture(),id=commands.createExternalPlaylist(doc([song],false),true)
  assert.throws(()=>commands.saveExternalPlaylist(id),/尚未完整读取/)
  assert.equal(commands.discardExternalPlaylist(id),true)
  assert.deepEqual(playlists.value,[])
  assert.equal(writes.length,0)
})
test('an unresolved metadata occurrence cannot enter a player queue',()=>{
  const {playlists,commands}=fixture(),id=commands.createExternalPlaylist(doc([song])),entry=playlists.value[0].imported!.entries[0]
  commands.applyExternalResolution(id,playlists.value[0].imported!.generation,entry.entryId,0,{state:'missing',message:'not found'})
  assert.deepEqual(importedPlayableTracks(playlists.value[0].imported!.entries),[])
})
test('manual edit revisions fence in-flight match results and refresh retains the manual binding',()=>{
  const {playlists,commands}=fixture(),id=commands.createExternalPlaylist(doc()),entry=playlists.value[0].imported!.entries[0]
  const track={id:'local',title:'Song',artist:'Artist',album:'Album',filePath:'D:/a.flac',fileName:'a.flac',duration:180,size:1,cover:null,lyrics:null}
  commands.bindExternalEntry(id,entry.entryId,track)
  const generation=playlists.value[0].imported!.generation
  commands.applyExternalResolutions(id,generation,[{entryId:entry.entryId,revision:0,resolution:{state:'missing'}}])
  assert.equal(playlists.value[0].imported!.entries[0].resolution.state,'pending')
  commands.applyExternalResolutions(id,generation,[{entryId:entry.entryId,revision:1,resolution:{state:'local',track}}])
  commands.refreshExternalPlaylist(id,doc([song,song,song]),true)
  assert.equal(playlists.value[0].imported!.entries[0].manualBinding?.id,'local');assert.equal(playlists.value[0].imported!.entries.length,3)
})
test('refresh rejects incomplete data, defaults local edits to a copy and fences previous generations',()=>{
  const {playlists,commands}=fixture(),id=commands.createExternalPlaylist(doc()),entry=playlists.value[0].imported!.entries[0],old=playlists.value[0].imported!
  assert.throws(()=>commands.refreshExternalPlaylist(id,doc([song],false),true),/完整读取/)
  commands.removeExternalEntries(id,[entry.entryId]);const next=commands.refreshExternalPlaylist(id,doc([song]),false)
  assert.notEqual(next,id);assert.equal(playlists.value.length,2)
  assert.equal(commands.applyExternalResolution(id,old.generation,entry.entryId,0,{state:'local'}),false)
})
test('CAS transaction replay preserves refresh generation and newer manual binding',()=>{
  const {playlists,commands}=fixture(),id=commands.createExternalPlaylist(doc()),base=structuredClone(playlists.value[0].imported!),local=structuredClone(base),current=structuredClone(base)
  local.entries[0].resolution={state:'streaming',message:'old search'}
  current.entries[0].revision=1;current.entries[0].manualBinding={id:'local',title:'Song',artist:'Artist',album:'Album',filePath:'x',fileName:'x',duration:180,size:1,cover:null,lyrics:null};current.entries[0].resolution={state:'local',track:current.entries[0].manualBinding as never}
  assert.equal(replayExternalPlaylist(base,local,current).entries[0].revision,1)
  const refreshed={...current,generation:'new'}
  assert.equal(replayExternalPlaylist(base,local,refreshed).generation,'new')
  assert.equal(playlists.value[0].id,id)
})
