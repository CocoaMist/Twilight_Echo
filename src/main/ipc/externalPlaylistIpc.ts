import type { IpcMain } from 'electron'
import { readPlaylistImportFile } from '../../core/playlists/readFile.ts'
import { choosePlaylistImportFile } from '../library/playlistImportDialog.ts'
import { assertTrustedIpcSender } from '../security/electronSecurity.ts'
import { IPC } from '../../shared/ipcChannels.ts'
import { readOfficialPlaylistPage, resolveNeteaseShortPlaylistLink, type PlaylistReadRequest } from '../library/playlistPlatformReader.ts'

export function registerExternalPlaylistIpc(ipc: IpcMain) {
  const activeReads=new Map<string,AbortController>()
  ipc.handle(IPC.playlistImport.chooseFile, async event => {
    assertTrustedIpcSender(event,'external playlist import')
    const filename = await choosePlaylistImportFile()
    return filename ? readPlaylistImportFile(filename, new AbortController().signal) : null
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
