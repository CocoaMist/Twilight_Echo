import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSmbMountAdapter as smb,
  createNfsMountAdapter as nfs,
  type MountAdapterDeps
} from '../../../core/network/adapters/smbMountAdapter.ts'
import { runMountCommand } from '../systemRunners.ts'
export * from '../../../core/network/adapters/smbMountAdapter.ts'
function defaults(deps: Partial<MountAdapterDeps>): MountAdapterDeps {
  const runtime =
    process.env.XDG_RUNTIME_DIR ?? (process.getuid ? `/run/user/${process.getuid()}` : null)
  return {
    platform: process.platform,
    runCommand: runMountCommand,
    mountBaseDir: tmpdir(),
    gvfsRoot: runtime ? join(runtime, 'gvfs') : null,
    ...deps
  }
}
export function createSmbMountAdapter(
  deps: Partial<MountAdapterDeps> = {}
): ReturnType<typeof smb> {
  return smb(defaults(deps))
}
export function createNfsMountAdapter(
  deps: Partial<MountAdapterDeps> = {}
): ReturnType<typeof nfs> {
  return nfs(defaults(deps))
}
