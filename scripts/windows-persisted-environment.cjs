function resolveWindowsPersistedEnvironment({
  env,
  names,
  spawnSync,
  getValue = (environment, name) => environment[name]
}) {
  const resolved = { ...env }
  if (process.platform !== 'win32') return resolved
  for (const name of names) {
    if (getValue(resolved, name)) continue
    const result = spawnSync('reg.exe', ['query', 'HKCU\\Environment', '/v', name], {
      encoding: 'utf8',
      windowsHide: true
    })
    if (result?.status !== 0 || result.error) continue
    const match = new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+?)\\s*$`, 'im').exec(
      result.stdout ?? ''
    )
    if (match?.[1]) resolved[name] = match[1].trim()
  }
  return resolved
}

module.exports = { resolveWindowsPersistedEnvironment }
