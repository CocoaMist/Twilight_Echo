/** Portable playlist matching deliberately keeps POSIX/UNC case and does not
 * resolve dot segments. These are the existing renderer import semantics. */
export function normalizePortableLibraryPath(filePath: string): string {
  const normalized = filePath.replace(/\//g, '\\').replace(/\\+/g, '\\')
  return /^[a-zA-Z]:\\/.test(normalized) ? normalized.toLocaleLowerCase('en-US') : normalized
}

export function reversePlaylistPath(path: string): string {
  return [...path].reverse().join('')
}
