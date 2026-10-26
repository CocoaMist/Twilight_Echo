const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { readFileSync } = require('node:fs')
const { join, dirname } = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const source = readFileSync(join(__dirname, 'run-electron-vite.cjs'), 'utf8')

function launch(command, forwarded = [], { env = {}, metadataEnv } = {}) {
  const child = new EventEmitter()
  let invocation, exit
  const dependency = join(
    'C:\\Program Files',
    'Twilight Echo',
    'node_modules',
    'electron-vite',
    'package.json'
  )
  const mockRequire = (name) => {
    if (name === 'node:fs') {
      return {
        ...require(name),
        readFileSync: (path, ...args) => {
          if (path === join(__dirname, '..', '.env.metadata.local')) {
            if (metadataEnv !== undefined) return metadataEnv
            throw Object.assign(new Error('No local metadata configuration'), { code: 'ENOENT' })
          }
          return readFileSync(path, ...args)
        }
      }
    }
    return name === 'node:child_process'
      ? {
          spawn: (...args) => {
            invocation = args
            return child
          }
        }
      : require(name)
  }
  mockRequire.resolve = () => dependency
  const process = {
    argv: ['node', 'launcher', command, ...forwarded],
    platform: 'win32',
    env,
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    exit: (code) => {
      exit = code
    }
  }
  vm.runInNewContext(source, {
    require: mockRequire,
    process,
    console: { error: () => {}, warn: () => {} },
    __dirname
  })
  return { child, process, invocation, dependency, exit: () => exit }
}

test('Windows launch bypasses the shell and preserves literal argument boundaries', () => {
  const forwarded = [
    '--profile=C:\\Music Files\\prefs',
    '--label=a&b|c>d',
    '--literal="quoted"',
    '--value=$(echo test)'
  ]
  for (const command of ['dev', 'preview']) {
    const result = launch(command, forwarded)
    assert.equal(result.invocation[0], result.process.execPath)
    assert.deepEqual(Array.from(result.invocation[1]), [
      join(dirname(result.dependency), 'bin', 'electron-vite.js'),
      command,
      '--',
      ...forwarded
    ])
    assert.equal(result.invocation[2].shell, false)
    assert.equal(result.invocation[2].windowsHide, true)
    result.child.emit('close', 7)
    assert.equal(result.exit(), 7)
  }
})

test('spawn failure stays unsuccessful when the child closes without an exit code', () => {
  const result = launch('dev')
  result.child.emit('error', new Error('not found'))
  result.child.emit('close', null)
  assert.equal(result.exit(), 1)
})

const metadataEnv = `
TWILIGHT_METADATA_ENABLED=1
TWILIGHT_METADATA_PUBLIC_SERVICE_APPROVED=1
TWILIGHT_METADATA_WIKIPEDIA_TEXT=1
TWILIGHT_METADATA_CONTACT=https://github.com/Px-asen/Twilight_Echo
TWILIGHT_METADATA_COMMONS_IMAGES=1
TWILIGHT_METADATA_CAA_USAGE=not-approved
VITE_EXPOSED_VALUE=must-not-be-loaded
ELECTRON_RUN_AS_NODE=1
TWILIGHT_DEV_USER_DATA_DIR=must-not-change-profile
`

test('dev loads only the local metadata policy and wires the one-time Core setup request', () => {
  const result = launch('dev', [], { metadataEnv })
  const env = result.invocation[2].env
  assert.equal(env.TWILIGHT_METADATA_ENABLED, '1')
  assert.equal(env.TWILIGHT_METADATA_PUBLIC_SERVICE_APPROVED, '1')
  assert.equal(env.TWILIGHT_METADATA_WIKIPEDIA_TEXT, '1')
  assert.equal(env.TWILIGHT_METADATA_COMMONS_IMAGES, '1')
  assert.equal(env.TWILIGHT_METADATA_CONTACT, 'https://github.com/Px-asen/Twilight_Echo')
  assert.equal(
    env.TWILIGHT_DEV_METADATA_SETUP_FILE,
    join(__dirname, '..', '.local', 'music-metadata-setup.json')
  )
  for (const key of [
    'TWILIGHT_METADATA_CAA_USAGE',
    'VITE_EXPOSED_VALUE',
    'ELECTRON_RUN_AS_NODE',
    'TWILIGHT_DEV_USER_DATA_DIR'
  ]) assert.equal(env[key], undefined)
  assert.deepEqual(result.process.env, {})
})

test('explicit shell metadata policy wins and preview never loads the local dev policy', () => {
  const disabled = launch('dev', [], {
    metadataEnv,
    env: { TWILIGHT_METADATA_ENABLED: '0', TWILIGHT_METADATA_CONTACT: 'https://example.org/contact' }
  }).invocation[2].env
  assert.equal(disabled.TWILIGHT_METADATA_ENABLED, '0')
  assert.equal(disabled.TWILIGHT_METADATA_CONTACT, 'https://example.org/contact')
  const preview = launch('preview', [], { metadataEnv }).invocation[2].env
  assert.equal(preview.TWILIGHT_METADATA_ENABLED, undefined)
  assert.equal(preview.TWILIGHT_DEV_METADATA_SETUP_FILE, undefined)
})

test('missing or malformed local metadata config keeps the normal launch contract', () => {
  for (const metadataEnv of [undefined, 'TWILIGHT_METADATA_ENABLED=yes']) {
    const env = launch('dev', [], { metadataEnv }).invocation[2].env
    assert.equal(env.TWILIGHT_METADATA_ENABLED, undefined)
    assert.equal(env.TWILIGHT_DEV_METADATA_SETUP_FILE, undefined)
  }
})

test('NCM local fallback and independently reviewed platform rights are dev-only and not boolean-coerced', () => {
  const rights = JSON.stringify({ ncm: { display: true, cache: true, crossSource: true, export: false } })
  const metadataEnv = `TWILIGHT_METADATA_NCM_LOCAL_FALLBACK=1\nTWILIGHT_METADATA_PLATFORM_USAGE='${rights}'\nTWILIGHT_METADATA_PLATFORM_ARTWORK_USAGE='${rights}'`
  const env = launch('dev', [], { metadataEnv }).invocation[2].env
  assert.equal(env.TWILIGHT_METADATA_NCM_LOCAL_FALLBACK, '1')
  assert.equal(env.TWILIGHT_METADATA_PLATFORM_USAGE, rights)
  assert.equal(env.TWILIGHT_METADATA_PLATFORM_ARTWORK_USAGE, rights)
  assert.equal(launch('preview', [], { metadataEnv }).invocation[2].env.TWILIGHT_METADATA_NCM_LOCAL_FALLBACK, undefined)
})
