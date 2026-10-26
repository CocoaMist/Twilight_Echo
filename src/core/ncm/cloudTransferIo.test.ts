import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import https from 'node:https'
import type { IncomingMessage, ClientRequest } from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'
import { uploadToNos, type SelectedFileGrant } from './cloudTransferIo.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test(
  'NOS upload sends the existing signed headers and joins file transmission after an early response',
  { timeout: 5000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'twilight-nos-'))
    const path = join(directory, 'song.flac')
    await writeFile(path, 'abc')
    const responseSent = deferred()
    const finishSending = deferred()
    const bytes: Buffer[] = []
    const mock = t.mock.method(
      https,
      'request',
      (url: URL, options: https.RequestOptions, respond: (response: IncomingMessage) => void) => {
        assert.equal(url.href, 'https://nos.example/upload')
        assert.equal(options.method, 'POST')
        assert.deepEqual(options.headers, {
          'x-nos-token': 'private-token',
          'Content-MD5': '900150983cd24fb0d6963f7d28e17f72',
          'Content-Type': 'audio/flac',
          'Content-Length': '3'
        })
        return new Writable({
          write(chunk: Buffer, _encoding, done) {
            bytes.push(chunk)
            done()
          },
          final(done) {
            const response = new PassThrough() as unknown as IncomingMessage
            response.statusCode = 201
            respond(response)
            ;(response as unknown as PassThrough).end()
            responseSent.resolve()
            void finishSending.promise.then(() => done())
          }
        }) as unknown as ClientRequest
      }
    )
    syncBuiltinESMExports()
    t.after(async () => {
      mock.mock.restore()
      syncBuiltinESMExports()
      await rm(directory, { recursive: true, force: true })
    })
    const grant: SelectedFileGrant = {
      handle: 'h',
      ownerId: 'c',
      path,
      name: 'song.flac',
      size: 3,
      format: 'flac',
      expiresAt: 100
    }
    let settled = false
    const sending = uploadToNos(
      () => {},
      't',
      grant,
      {
        needUpload: true,
        songId: 9,
        uploadToken: 'private-token',
        uploadUrl: 'https://nos.example/upload',
        resourceId: 'resource',
        md5: '900150983cd24fb0d6963f7d28e17f72',
        fileSize: 3,
        filename: 'song.flac'
      },
      new AbortController().signal,
      'h'
    ).then(() => {
      settled = true
    })
    await responseSent.promise
    assert.equal(settled, false)
    finishSending.resolve()
    await sending
    assert.equal(Buffer.concat(bytes).toString(), 'abc')
    assert.equal(mock.mock.callCount(), 1)
  }
)

test(
  'NOS cancellation waits for the request to release its writable stream',
  { timeout: 5000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'twilight-nos-cancel-'))
    const path = join(directory, 'song.flac')
    await writeFile(path, 'abc')
    const writing = deferred()
    const destroying = deferred()
    const release = deferred()
    const mock = t.mock.method(
      https,
      'request',
      () =>
        new Writable({
          write(_chunk, _encoding, _done) {
            writing.resolve()
          },
          destroy(error, done) {
            destroying.resolve()
            void release.promise.then(() => done(error))
          }
        }) as unknown as ClientRequest
    )
    syncBuiltinESMExports()
    t.after(async () => {
      mock.mock.restore()
      syncBuiltinESMExports()
      await rm(directory, { recursive: true, force: true })
    })
    const controller = new AbortController()
    let settled = false
    const sending = uploadToNos(
      () => {},
      't',
      {
        handle: 'h',
        ownerId: 'c',
        path,
        name: 'song.flac',
        size: 3,
        format: 'flac',
        expiresAt: 100
      },
      {
        needUpload: true,
        songId: 9,
        uploadToken: 'private-token',
        uploadUrl: 'https://nos.example/upload',
        resourceId: 'resource',
        md5: '900150983cd24fb0d6963f7d28e17f72',
        fileSize: 3,
        filename: 'song.flac'
      },
      controller.signal,
      'h'
    ).catch((error) => {
      settled = true
      return error
    })
    await writing.promise
    controller.abort()
    await destroying.promise
    assert.equal(settled, false)
    release.resolve()
    const error = await sending
    assert.equal(error.code, 'ABORT_ERR')
  }
)
