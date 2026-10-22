import assert from 'node:assert/strict'
import test from 'node:test'
import { libraryDirectoriesForFiles } from './libraryScanDirectories.ts'

test('tag scan scopes retain POSIX/drive/UNC roots and deduplicate Windows case without widening the scope', () => {
  assert.deepEqual(
    libraryDirectoriesForFiles([
      'D:\\Music\\a.wav',
      'd:/music/b.wav',
      '/Music/a.wav',
      '/music/b.wav',
      'C:/root.wav',
      '/root.wav',
      '\\\\server\\share\\one.wav'
    ]),
    ['d:/music', '/Music', '/music', 'C:/', '/', '//server/share']
  )
  assert.throws(() => libraryDirectoriesForFiles(['relative.wav']), /父目录/)
  assert.deepEqual(libraryDirectoriesForFiles([]), [])
})
