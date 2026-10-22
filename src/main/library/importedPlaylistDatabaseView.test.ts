import assert from 'node:assert/strict'
import test from 'node:test'
import { LibraryDatabase } from './libraryDatabase.ts'
import type { LibraryPlaylistViewSync } from '../../shared/libraryDatabase.ts'

test('imported metadata is indexed and paged but never enters a SQL playback queue',t=>{
  const db=new LibraryDatabase(':memory:')
  db.replaceDocument({version:2,revision:0,tracks:[],folders:[],exclusions:[]})
  t.after(()=>db.close())
  const entries=[1,2].map(i=>({id:`entry-${i}`,snapshot:{id:`entry-${i}`,filePath:'',title:i===1?'夜曲':'青花瓷',artist:'周杰伦',album:'十一月的萧邦',duration:180,source:'playlist-import',externalEntry:{entryId:`entry-${i}`,state:'missing'}}}))
  const sync=(request:LibraryPlaylistViewSync)=>db.syncPlaylistView(request)
  sync({kind:'begin',id:'imported',versions:[]});sync({kind:'append',id:'imported',sequence:1,entries});sync({kind:'commit',id:'imported',sequence:2})
  const page=db.queryTracks({playlistView:'imported',sort:'playlist',limit:10})
  assert.equal(page.total,2);assert.deepEqual(page.tracks.map(row=>row.id),['entry-1','entry-2'])
  assert.equal(db.queryTracks({playlistView:'imported',search:'夜曲',sort:'playlist',limit:10}).total,1)
  const queue=db.createLibraryQueue({playlistView:'imported',sort:'playlist'})
  assert.equal(queue.total,0)
})
