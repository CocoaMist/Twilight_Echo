const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const implementation = fs.readFileSync(
  path.join(root, 'audio-engine/automix/TransitionEffects.cpp'),
  'utf8'
)
const used = new Set(
  [...implementation.matchAll(/\.v\("([^"]+)"/g)].map((x) => x[1]).concat(['out_gain', 'ts_rate'])
)
const catalogue = JSON.parse(
  fs.readFileSync(path.join(root, 'audio-engine/automix/assets/TransitionStyles.json'), 'utf8')
)
const result = catalogue.map((style) => {
  const controls = [
    ...new Set(
      Object.values(style.instructions).flatMap((rows) =>
        rows.flatMap((row) => (row.automations || []).map((a) => a.parameterId))
      )
    )
  ]
  return {
    styleId: style.id,
    name: style.name,
    unhandledControls: controls.filter((key) => !used.has(key))
  }
})
console.log(
  JSON.stringify(
    { kind: 'static-control-inventory', appleEffectSoundParity: 'not-established', styles: result },
    null,
    2
  )
)
