export function isPluginProviderEnabled(health?: {
  pluginStatus?: string
  available?: boolean
}): boolean {
  // Request failures must not turn an enabled provider into a disabled one.
  return health?.pluginStatus ? health.pluginStatus === 'enabled' : health?.available !== false
}
