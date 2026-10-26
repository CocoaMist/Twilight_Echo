import type { RemoteControlStatus } from './remoteControl.ts'

export interface CoreRemoteCommands {
  'remote.setEnabled': { enabled: boolean }
  'remote.rotatePin': Record<string, never>
}
export interface CoreRemoteQueries {
  'remote.status': { input: Record<string, never>; output: RemoteControlStatus }
}
export function validCoreRemotePayload(name: string, value: Record<string, unknown>): boolean {
  if (name === 'remote.setEnabled')
    return Object.keys(value).length === 1 && typeof value.enabled === 'boolean'
  return (name === 'remote.status' || name === 'remote.rotatePin') && !Object.keys(value).length
}
