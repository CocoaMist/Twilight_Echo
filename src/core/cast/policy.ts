/** Same upstream policy as the existing main Cast path; redirects stay blocked
 * by the media proxy and tokens never reveal the upstream URL to the device. */
export function assertCastUpstream(source: string): void {
  const url = new URL(source)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Cast media URL is not authorized')
  if (isPrivateOrLoopbackHost(url.hostname))
    throw new Error('Cast media URL host is not authorized')
}

export function isPrivateOrLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return false
  const [a, b] = parts
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  )
}
