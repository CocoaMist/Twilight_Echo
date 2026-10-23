import { mkdir, unlink } from 'node:fs/promises'
import { join, dirname, basename, resolve } from 'node:path'
import { isSecureValueEnvelope, protectString, unprotectString } from '../security/secureStorage.ts'
import { parseJsonWithNestingLimit } from '../../shared/jsonSafety.ts'
import { sftpBatch } from '../../core/network/adapters/sftpSystemAdapter.ts'
import { runMountCommand, runSftpBatch } from './systemRunners.ts'
import type { CoreSupervisorOptions } from '../coreProcess/supervisor.ts'
import type { CoreNetworkMountRequest } from '../../shared/coreNetwork.ts'

const scope = 'network-source-credentials'

/** Only OS execution/encryption lives here. Profiles, credentials policy and index remain in Core. */
export function createNetworkCorePlatform(
  root: string,
  runners: { mount?: typeof runMountCommand; sftp?: typeof runSftpBatch } = {}
): NonNullable<CoreSupervisorOptions['platform']> {
  const mount = runners.mount ?? runMountCommand
  const sftp = runners.sftp ?? runSftpBatch
  const tempRoot = join(root, 'network-sources', 'temp')
  const runtime =
    process.env.XDG_RUNTIME_DIR ?? (process.getuid ? `/run/user/${process.getuid()}` : null)
  const mounts = new Map<string, { leases: Set<object>; close: CoreNetworkMountRequest }>()
  let tail: Promise<unknown> = Promise.resolve()
  function serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = tail.then(action)
    tail = result.catch(() => {})
    return result
  }
  function mountTarget(path: string): boolean {
    return (
      dirname(resolve(path)) === resolve(tempRoot) &&
      /^twilight-nfs-[a-zA-Z0-9]+$/.test(basename(path))
    )
  }
  function describe(input: CoreNetworkMountRequest): {
    key: string
    opening: boolean
    close: CoreNetworkMountRequest
  } {
    const { command, args: a } = input
    if (
      process.platform === 'win32' &&
      command === 'net' &&
      a[0] === 'use' &&
      /^\\\\[^\\/\s]+\\[^\0\r\n]+$/.test(a[1])
    ) {
      const opening = a.length === 4 && a[3].startsWith('/user:')
      if (opening || (a.length === 4 && a[2] === '/delete' && a[3] === '/y'))
        return {
          key: a[1].toLowerCase(),
          opening,
          close: { command, args: ['use', a[1], '/delete', '/y'] }
        }
    }
    if (process.platform === 'linux' && command === 'gio' && a[0] === 'mount') {
      const opening = a.length === 2
      const uri = opening ? a[1] : a[2]
      if (/^smb:\/\/[^\0\r\n]+$/.test(uri) && (opening || (a.length === 3 && a[1] === '-u')))
        return { key: uri, opening, close: { command, args: ['mount', '-u', uri] } }
    }
    if (
      process.platform === 'linux' &&
      command === 'mount' &&
      a.length === 4 &&
      a[0] === '-t' &&
      a[1] === 'nfs' &&
      /^[^-][^\0\r\n]*:\//.test(a[2]) &&
      mountTarget(a[3])
    )
      return { key: a[3], opening: true, close: { command: 'umount', args: [a[3]] } }
    if (process.platform === 'linux' && command === 'umount' && a.length === 1 && mountTarget(a[0]))
      return { key: a[0], opening: false, close: input }
    throw new Error('Unsupported network mount operation')
  }
  async function close(
    key: string,
    lease?: object
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const mounted = mounts.get(key)
    const token = lease ?? mounted?.leases.values().next().value
    if (!mounted || !token || !mounted.leases.delete(token) || mounted.leases.size > 0)
      return { code: 0, stdout: '', stderr: '' }
    const result = await mount(mounted.close.command, mounted.close.args)
    if (result.code === 0) mounts.delete(key)
    else mounted.leases.add(token)
    return result
  }
  return {
    'network.environment': async () => {
      await mkdir(tempRoot, { recursive: true })
      return {
        platform: process.platform,
        tempRoot,
        gvfsRoot: runtime ? join(runtime, 'gvfs') : null
      }
    },
    'network.protectCredential': async ({ plain }) => JSON.stringify(protectString(plain, scope)),
    'network.unprotectCredential': async ({ encrypted }) => {
      const envelope = parseJsonWithNestingLimit(encrypted)
      if (!isSecureValueEnvelope(envelope)) throw new Error('凭据数据损坏')
      const value = unprotectString(envelope, scope)
      if (value === null) throw new Error('凭据无法解密')
      return value
    },
    'network.sftp': async ({ operation, connection }, signal) => {
      if (connection.username.startsWith('-') || connection.host.startsWith('-'))
        throw new Error('Invalid SFTP destination')
      if (
        operation.kind === 'download' &&
        (dirname(resolve(operation.local)) !== resolve(tempRoot) ||
          !/^sftp-[a-zA-Z0-9-]+\.tmp$/.test(basename(operation.local)))
      )
        throw new Error('SFTP download is outside the Core temporary directory')
      try {
        return await sftp(sftpBatch(operation), connection, signal)
      } finally {
        if (signal.aborted && operation.kind === 'download')
          await unlink(operation.local).catch(() => {})
      }
    },
    'network.mountCommand': (input, signal) =>
      serialize(async () => {
        signal.throwIfAborted()
        const operation = describe(input)
        if (!operation.opening) return close(operation.key)
        const mounted = mounts.get(operation.key)
        let result = { code: 0, stdout: '', stderr: '' }
        const lease = {}
        if (mounted) mounted.leases.add(lease)
        else {
          result = await mount(input.command, input.args, signal)
          if (result.code !== 0) return result
          mounts.set(operation.key, { leases: new Set([lease]), close: operation.close })
        }
        // Successful mounts are OS leases: a dead Core cannot leave them attached.
        const release = () => {
          void serialize(() => close(operation.key, lease)).catch(() => {})
        }
        if (signal.aborted) release()
        else signal.addEventListener('abort', release, { once: true })
        return result
      })
  }
}
