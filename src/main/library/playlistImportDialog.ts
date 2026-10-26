import { dialog } from 'electron'

export async function choosePlaylistImportFile(): Promise<string | null> {
  const selection = await dialog.showOpenDialog({
    title: '导入外部歌单',
    properties: ['openFile'],
    filters: [
      {
        name: '歌单文件',
        extensions: [
          'm3u',
          'm3u8',
          'pls',
          'xspf',
          'wpl',
          'asx',
          'wax',
          'kgl',
          'xml',
          'txt',
          'csv',
          'tsv'
        ]
      }
    ]
  })
  return selection.canceled ? null : (selection.filePaths[0] ?? null)
}
