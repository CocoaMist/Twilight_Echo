/** Shared with platform storage/logging; contains no credential-store access. */
export function redactSensitiveText(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value)
  return text
    .replace(/(MUSIC_U=)[^;\s]+/gi, '$1[REDACTED]')
    .replace(/(__csrf=)[^;\s]+/gi, '$1[REDACTED]')
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:X-Api-Key|X-Signature)\s*:\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(
      /([?&](?:password|captcha|token|cookie|csrf|secret|api[-_]?key|apikey|signature)=)[^&\s]+/gi,
      '$1[REDACTED]'
    )
    .replace(
      /((?:password|token|cookie|secret|credential|api[-_.:]?key|apikey|bearer|signing[-_.:]?key|client[-_.:]?secret)\s*[:=]\s*)[^\s,;]+/gi,
      '$1[REDACTED]'
    )
}
