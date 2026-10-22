import { dialog, type IpcMain } from 'electron'
import { open } from 'node:fs/promises'
import { assertTrustedIpcSender } from '../security/electronSecurity.ts'
import { IPC } from '../../shared/ipcChannels.ts'
import { EXTERNAL_PLAYLIST_MAX_BYTES } from '../../shared/externalPlaylist.ts'
import { parseExternalPlaylistFile } from '../library/externalPlaylistParser.ts'
import { readOfficialPlaylistPage, resolveNeteaseShortPlaylistLink, type PlaylistReadRequest } from '../library/playlistPlatformReader.ts'

export function registerExternalPlaylistIpc(ipc: IpcMain) {
  const activeReads=new Map<string,AbortController>()
  ipc.handle(IPC.playlistImport.chooseFile, async event => {
    assertTrustedIpcSender(event,'external playlist import')
    const selection=await dialog.showOpenDialog({title:'导入外部歌单',properties:['openFile'],filters:[{name:'歌单文件',extensions:['m3u','m3u8','pls','xspf','wpl','asx','wax','kgl','xml','txt','csv','tsv']}]})
    if (selection.canceled||!selection.filePaths[0]) return null
    const filename=selection.filePaths[0], file=await open(filename,'r')
    try {
      const stat=await file.stat()
      if (!stat.isFile()||stat.size>EXTERNAL_PLAYLIST_MAX_BYTES) throw new Error('歌单文件超过 8 MiB 上限或不是普通文件')
      // A growing/replaced file cannot escape the bound between stat and read.
      const bytes=Buffer.alloc(Math.min(stat.size+1,EXTERNAL_PLAYLIST_MAX_BYTES+1)), result=await file.read(bytes,0,bytes.length,0)
      if (result.bytesRead!==stat.size) throw new Error('文件在读取期间发生变化，请重新选择')
      return parseExternalPlaylistFile(bytes.subarray(0,result.bytesRead),filename)
    } finally { await file.close() }
  })
  ipc.handle(IPC.playlistImport.resolveNeteaseShortLink,async(event, request:{input?:unknown;requestId?:unknown})=>{
    assertTrustedIpcSender(event,'external playlist import')
    if(!request||typeof request.input!=='string'||request.input.length>4096||typeof request.requestId!=='string'||!/^[\w-]{1,128}$/.test(request.requestId)||activeReads.has(request.requestId))throw new Error('无效或重复的短链接解析请求')
    const controller=new AbortController(),id=request.requestId
    activeReads.set(id,controller)
    try{return await resolveNeteaseShortPlaylistLink(request.input,fetch,controller.signal)}
    finally{if(activeReads.get(id)===controller)activeReads.delete(id)}
  })
  ipc.handle(IPC.playlistImport.readPage,async(event, request:PlaylistReadRequest)=>{
    assertTrustedIpcSender(event,'external playlist import')
    if (!request||typeof request.link!=='string'||request.link.length>4096||typeof request.offset!=='number') throw new Error('无效的歌单读取请求')
    if (request.cursor && (typeof request.cursor!=='string'||request.cursor.length>4096)) throw new Error('无效的歌单游标')
    if (request.requestId!==undefined&&(!/^[\w-]{1,128}$/.test(request.requestId)||activeReads.has(request.requestId)))throw new Error('无效或重复的读取请求 ID')
    const controller=new AbortController(),id=request.requestId
    if(id)activeReads.set(id,controller)
    try{return await readOfficialPlaylistPage(request,fetch,controller.signal)}
    finally{if(id&&activeReads.get(id)===controller)activeReads.delete(id)}
  })
  ipc.handle(IPC.playlistImport.cancelRead,async(event,requestId:unknown)=>{
    assertTrustedIpcSender(event,'external playlist import')
    if(typeof requestId!=='string'||!/^[\w-]{1,128}$/.test(requestId))return false
    const controller=activeReads.get(requestId)
    if(!controller)return false
    controller.abort();return true
  })
}
