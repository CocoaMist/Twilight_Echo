interface Version {
  core: number[]
  prerelease: string[]
}

function parseVersion(value: string): Version | null {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value.trim()
    )
  if (!match) return null
  const core = match.slice(1, 4).map(Number)
  const prerelease = match[4]?.split('.') ?? []
  if (core.some((part) => !Number.isSafeInteger(part))) return null
  if (prerelease.some((part) => /^0\d+$/.test(part))) return null
  return { core, prerelease }
}

function compareVersions(left: Version, right: Version): number {
  for (let index = 0; index < 3; index++) {
    if (left.core[index] !== right.core[index]) return left.core[index] > right.core[index] ? 1 : -1
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length ? -1 : 1
  }
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index++) {
    const a = left.prerelease[index]
    const b = right.prerelease[index]
    if (a === b) continue
    if (a === undefined) return -1
    if (b === undefined) return 1
    const numericA = /^\d+$/.test(a)
    const numericB = /^\d+$/.test(b)
    if (numericA !== numericB) return numericA ? -1 : 1
    if (numericA && a.length !== b.length) return a.length > b.length ? 1 : -1
    return a > b ? 1 : -1
  }
  return 0
}

export function compareSemver(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) throw new Error('Invalid semantic version')
  return compareVersions(a, b)
}

export function isCompatibleVersionRange(range: string, version: string): boolean {
  const actual = parseVersion(version)
  if (!actual) return false
  const trimmed = range.trim()
  if (trimmed === '*' || trimmed === '') return actual.prerelease.length === 0
  const operator = /^(>=|\^|~)/.exec(trimmed)?.[0] ?? ''
  const required = parseVersion(trimmed.slice(operator.length))
  if (!required) return false
  if (
    actual.prerelease.length &&
    (!required.prerelease.length ||
      actual.core.some((part, index) => part !== required.core[index]))
  )
    return false
  const comparison = compareVersions(actual, required)
  if (!operator) return comparison === 0
  if (comparison < 0) return false
  if (operator === '>=') return true
  const [major, minor, patch] = required.core
  const upper =
    operator === '~'
      ? [major, minor + 1, 0]
      : major > 0
        ? [major + 1, 0, 0]
        : minor > 0
          ? [0, minor + 1, 0]
          : [0, 0, patch + 1]
  return compareVersions(actual, { core: upper, prerelease: [] }) < 0
}
