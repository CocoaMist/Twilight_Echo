import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { reconcileMusicLibraryFile } from '../src/main/library/libraryDatabaseReconciliation.ts'

const usage = 'Usage: node --experimental-strip-types scripts/music-library-reconciliation.ts --database <library.sqlite> [--core-state <core-state.sqlite> | --versions <snapshot.json> [--versions-revision <n>]] [--examples <0..100>] [--output <report.json>]'
const options = new Map<string, string>()
const args = process.argv.slice(2)
if (args.length === 1 && args[0] === '--help') { process.stdout.write(`${usage}\n`); process.exit(0) }
for (let index = 0; index < args.length; index += 2) {
  const key = args[index], value = args[index + 1]
  if (!['--database', '--core-state', '--versions', '--versions-revision', '--examples', '--output'].includes(key) || options.has(key) || !value || value.startsWith('--')) throw new Error(usage)
  options.set(key, value)
}
if (!options.get('--database')) throw new Error(usage)
const database = resolve(options.get('--database')!)
const versions = options.get('--versions') ? resolve(options.get('--versions')!) : undefined
const coreState = options.get('--core-state') ? resolve(options.get('--core-state')!) : undefined
const output = options.get('--output') ? resolve(options.get('--output')!) : undefined
if (output && [database, versions, coreState].filter(Boolean).some(path => path!.toLowerCase() === output.toLowerCase())) throw new Error('Report output must not overwrite an input file')
if (versions && statSync(versions).size > 8 * 1024 * 1024) throw new Error('Versions authority exceeds 8 MiB')
const report = reconcileMusicLibraryFile(database, {
  versionsJson: versions ? readFileSync(versions, 'utf8') : undefined,
  versionsRevision: options.has('--versions-revision') ? Number(options.get('--versions-revision')) : undefined,
  coreStatePath: coreState,
  exampleLimit: options.has('--examples') ? Number(options.get('--examples')) : undefined
})
const encoded = `${JSON.stringify(report, null, 2)}\n`
if (output) writeFileSync(output, encoded, { encoding: 'utf8', flag: 'wx' })
else process.stdout.write(encoded)
process.exitCode = report.summary.errorChecks ? 2 : 0
