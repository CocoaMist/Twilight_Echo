import assert from 'node:assert/strict'
import test from 'node:test'
import { setLanguagePreference, useLocale } from '../../app/useLocale.ts'
import { friendlyStreamingError } from './friendlyStreamingError.ts'

test('a provider message rejected over IPC drops the remote-invoke wrapper', () => {
  const error = new Error(
    "Error invoking remote method 'providers:call': Error: 请先登录网易云音乐"
  )
  assert.equal(friendlyStreamingError(error, '读取云端歌单失败'), '请先登录网易云音乐')
})

test('a wrapped English failure classifies its cause in the selected locale', () => {
  const error = new Error(
    "Error invoking remote method 'providers:call': Error: request failed with status 401"
  )
  const originalPreference = useLocale().preference.value
  try {
    setLanguagePreference('zh-CN')
    assert.equal(
      friendlyStreamingError(error, '添加到歌单失败'),
      '添加到歌单失败：登录状态已失效，请重新登录'
    )
    setLanguagePreference('en-US')
    assert.equal(
      friendlyStreamingError(error, 'Failed to add to playlist'),
      'Failed to add to playlist: Your session expired. Please sign in again.'
    )
  } finally {
    setLanguagePreference(originalPreference)
  }
})

test('an unwrapped message keeps its own leading Error text untouched', () => {
  assert.equal(
    friendlyStreamingError(new Error('Error: 歌单已达上限'), '失败'),
    'Error: 歌单已达上限'
  )
  assert.equal(friendlyStreamingError(new Error('   '), '失败'), '失败')
})

test('a wrapper with no cause left falls back to the wrapped text instead of an empty line', () => {
  const error = new Error("Error invoking remote method 'providers:call': Error:")
  assert.equal(friendlyStreamingError(error, '添加到歌单失败'), '添加到歌单失败')
})
