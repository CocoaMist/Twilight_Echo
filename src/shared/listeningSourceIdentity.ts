/** Qualified keys coexist with the original raw Track ID history projection. */
export function listeningSourceIdentity(provider: string, trackId: string): string {
  provider = provider.trim().toLowerCase()
  const id =
    provider !== 'local' && trackId.startsWith(provider + ':')
      ? trackId.slice(provider.length + 1)
      : trackId
  return JSON.stringify(['focus-source-v1', provider, id])
}
