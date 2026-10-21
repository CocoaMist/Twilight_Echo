/** Keep absolute POSIX/drive/UNC roots intact; the main owner authorizes and
 * canonicalizes the result. Never broaden a tag write into a whole-library scan. */
export function libraryDirectoriesForFiles(paths: readonly string[]): string[] {
  const directories = new Map<string, string>()
  for (const path of paths) {
    const normalized = path.replaceAll('\\', '/')
    const end = normalized.lastIndexOf('/')
    if (end < 0) throw new Error('标签文件缺少有效的父目录')
    const directory = normalized.slice(
      0,
      end === 0 || /^[a-z]:\/$/i.test(normalized.slice(0, end + 1)) ? end + 1 : end
    )
    const key = /^(?:[a-z]:|\/\/)/i.test(directory) ? directory.toLowerCase() : directory
    directories.set(key, directory)
  }
  return [...directories.values()]
}
