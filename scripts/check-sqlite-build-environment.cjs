'use strict'

// Run from a normal, non-administrator terminal before SQLite UI acceptance.
// The build uses esbuild's temporary-file transport above 1 MiB. Keep the
// original TEMP and permissions so failures remain reproducible.
const os = require('node:os')
const esbuild = require('esbuild')

async function main() {
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      node: process.version,
      exe: process.execPath,
      temp: os.tmpdir(),
      esbuild: esbuild.version
    })
  )
  try {
    const input = 'export const sqliteAcceptanceProbe=1;\n' + ' '.repeat(1_100_000)
    const output = await esbuild.transform(input, { loader: 'js' })
    if (!output.code.includes('sqliteAcceptanceProbe'))
      throw new Error('Unexpected transform output')
    console.log('LARGE_TRANSFORM_OK')
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  } finally {
    esbuild.stop()
  }
}

void main()
