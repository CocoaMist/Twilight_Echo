'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync, execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')

const ROOT = path.join(__dirname, '..')
const SCOPES = {
  titlebar: ['src/main/app/windowChrome.test.ts', 'src/renderer/src/app/titleBar.behavior.test.ts'],
  navigation: [
    'src/renderer/src/app/useAppNavigation.test.ts',
    'src/renderer/src/app/useBackStack.test.ts',
    'src/renderer/src/app/useNavigationGuard.test.ts'
  ],
  shell: ['src/renderer/src/app/nativeShellQuality.behavior.test.ts']
}

function parseArgs(args) {
  const options = { scope: 'titlebar', report: path.join('output', 'ui-lab', 'report.json') }
  const tokens = args.filter((arg) => arg !== '--')
  for (let index = 0; index < tokens.length; index += 2) {
    const key = tokens[index]
    const value = tokens[index + 1]
    if (!['--scope', '--report'].includes(key) || !value || value.startsWith('--'))
      throw new Error(
        'Usage: pnpm ui:check -- --scope titlebar|navigation|shell --report <file.json>'
      )
    options[key.slice(2)] = value
  }
  if (!Object.hasOwn(SCOPES, options.scope)) throw new Error(`Unknown UI scope: ${options.scope}`)
  return options
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const reportPath = path.resolve(ROOT, options.report)
  const directory = path.dirname(reportPath)
  fs.mkdirSync(directory, { recursive: true })
  const stem = path.basename(reportPath, path.extname(reportPath))
  const evidencePath = path.join(directory, `${stem}-titlebar.json`)
  const logPath = path.join(directory, `${stem}.log`)
  const started = Date.now()
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--test',
      '--test-reporter=tap',
      '--import',
      './scripts/register-renderer-aliases.mjs',
      ...SCOPES[options.scope]
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 180_000,
      maxBuffer: 12 * 1024 * 1024,
      env: { ...process.env, UI_LAB_TITLEBAR_EVIDENCE: evidencePath }
    }
  )
  const output = (result.stdout ?? '') + (result.stderr ?? '')
  fs.writeFileSync(logPath, output)
  let commit = null
  let sourceDirty = null
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
    sourceDirty = Boolean(
      execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim()
    )
  } catch {
    /* Source archives can run without Git metadata. */
  }
  const count = (name) => Number(output.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1] ?? 0)
  const report = {
    schemaVersion: 1,
    tool: 'Echora UI Lab',
    scope: options.scope,
    passed: result.status === 0 && !result.error && count('tests') > 0,
    exitCode: result.status,
    error: result.error?.message ?? null,
    commit,
    sourceDirty,
    platform: process.platform,
    node: process.version,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    sourceFiles: SCOPES[options.scope],
    tests: { total: count('tests'), passed: count('pass'), failed: count('fail') },
    nativeDeviceValidation: false,
    log: logPath,
    evidence: options.scope === 'titlebar' && result.status === 0 ? evidencePath : null
  }
  if (options.scope === 'titlebar') {
    report.sourceHashes = Object.fromEntries(
      [
        ...SCOPES.titlebar,
        'scripts/ui-lab/titlebar-fixture.mjs',
        'src/renderer/src/components/TitleBar.vue',
        'src/renderer/src/components/hig/FluentIcon.vue',
        'src/renderer/src/components/hig/fluentIconPaths.ts',
        'src/renderer/src/components/hig/fluentCompactIconPaths.ts',
        'src/renderer/src/components/SongList.vue',
        'src/renderer/src/components/song-list/SongList.css',
        'src/renderer/src/components/ThemeIcon.vue',
        'src/renderer/src/components/streaming-page/StreamingTrackToolbar.vue',
        'src/renderer/src/app/useWindowChrome.ts',
        'src/renderer/src/assets/base.css',
        'src/renderer/src/assets/fluent.css',
        'src/renderer/src/assets/theme-layouts/paper-light.css',
        'src/renderer/src/assets/theme-layouts/obsidian-glass.css',
        'src/main/app/windowChrome.ts',
        'src/main/ipc/windowIpc.ts',
        'src/preload/domains/systemApi.ts'
      ].map((file) => [
        file,
        createHash('sha256')
          .update(fs.readFileSync(path.join(ROOT, file)))
          .digest('hex')
      ])
    )
  }
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
  console.log(
    `${report.passed ? 'PASS' : 'FAIL'} ${options.scope}: ${report.tests.passed}/${report.tests.total}`
  )
  console.log(`Report: ${reportPath}`)
  if (!report.passed) console.error(output.slice(-8000))
  process.exitCode = report.passed ? 0 : 1
}

module.exports = { parseArgs, SCOPES }
if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
