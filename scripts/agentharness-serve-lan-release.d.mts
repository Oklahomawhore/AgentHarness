import type { Server } from 'node:http'
import type { NetworkInterfaceInfo } from 'node:os'

export interface LanReleaseOptions {
  artifact: string
  out: string
  port: number
  bindHost: string
  advertiseHost?: string
  token?: string
}

export function detectLanAddress(interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>): string
export function createLanReleaseServer(directory: string, token: string): Server
export function parseLanArguments(args: string[]): LanReleaseOptions
export function serveLanRelease(options: LanReleaseOptions): Promise<void>
