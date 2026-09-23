#!/usr/bin/env node
/** Publish one portable release from this machine to trusted LAN peers over read-only HTTP. */

import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { extname, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ensureClusterCredential } from './agentharness-cluster.mjs'
import { stagePortableRelease } from './agentharness-stage-portable-release.mjs'

const root = resolve(import.meta.dirname, '..')

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number)
  return parts.length === 4 && (parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 169 && parts[1] === 254))
}

/** Select a non-loopback private IPv4 address to advertise to LAN peers. */
export function detectLanAddress(interfaces = networkInterfaces()) {
  const candidates = Object.entries(interfaces).flatMap(([name, addresses]) =>
    (addresses ?? []).filter(address => (address.family === 'IPv4' || address.family === 4)
      && !address.internal && isPrivateIpv4(address.address)).map(address => ({ name, address: address.address })))
  candidates.sort((left, right) => Number(!/^en\d+$/u.test(left.name)) - Number(!/^en\d+$/u.test(right.name)))
  if (candidates[0] === undefined) throw new Error('no private IPv4 LAN address was found; pass --advertise-host explicitly')
  return candidates[0].address
}

function contentType(path) {
  if (path.endsWith('.sh')) return 'text/x-shellscript; charset=utf-8'
  if (path.endsWith('.ps1')) return 'text/plain; charset=utf-8'
  if (path.endsWith('.json')) return 'application/json; charset=utf-8'
  if (path.endsWith('.tgz')) return 'application/gzip'
  return 'application/octet-stream'
}

/** Create a static server restricted to one unguessable URL prefix and one directory. */
export function createLanReleaseServer(directory, token) {
  const absoluteDirectory = resolve(directory)
  const prefix = `/${token}/`
  return createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end()
      return
    }
    let path
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith(prefix)) {
        response.writeHead(404).end()
        return
      }
      const local = decodeURIComponent(url.pathname.slice(prefix.length))
      path = resolve(absoluteDirectory, local)
      if (path !== absoluteDirectory && !path.startsWith(`${absoluteDirectory}${sep}`)) {
        response.writeHead(403).end()
        return
      }
      const info = await lstat(path)
      if (!info.isFile()) {
        response.writeHead(404).end()
        return
      }
      response.writeHead(200, {
        'Content-Type': contentType(path),
        'Content-Length': info.size,
        'Cache-Control': extname(path) === '.tgz' ? 'public, max-age=31536000, immutable' : 'no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      if (request.method === 'HEAD') response.end()
      else {
        const stream = createReadStream(path)
        stream.once('error', () => { response.destroy() })
        stream.pipe(response)
      }
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof URIError) response.writeHead(404).end()
      else response.writeHead(500).end()
    }
  })
}

/** Parse LAN publication flags. */
export function parseLanArguments(args) {
  const artifacts = []
  let out = resolve(root, 'dist', 'agentharness-lan-release')
  let port = 4177
  let bindHost = '0.0.0.0'
  let advertiseHost
  let token
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    const value = args[index + 1]
    if (argument === '--') continue
    else if (argument === '--artifact' && value !== undefined) { artifacts.push(resolve(value)); index += 1 }
    else if (argument === '--out' && value !== undefined) { out = resolve(value); index += 1 }
    else if (argument === '--port' && value !== undefined) { port = Number(value); index += 1 }
    else if (argument === '--host' && value !== undefined) { bindHost = value; index += 1 }
    else if (argument === '--advertise-host' && value !== undefined) { advertiseHost = value; index += 1 }
    else if (argument === '--token' && value !== undefined) { token = value; index += 1 }
    else throw new Error(`unknown or incomplete argument ${JSON.stringify(argument)}`)
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`invalid LAN release port ${JSON.stringify(port)}`)
  if (token !== undefined && !/^[a-zA-Z0-9_-]{12,64}$/u.test(token)) throw new Error('LAN path token must contain 12-64 URL-safe characters')
  if (artifacts.length === 0) artifacts.push(resolve(root, 'dist', 'agentharness-portable', `agentharness-${process.platform}-${process.arch}.tgz`))
  return { artifact: artifacts[0], artifacts, out, port, bindHost, advertiseHost, token }
}

/** Stage and serve a portable release until the process receives a signal. */
export async function serveLanRelease(options) {
  const advertiseHost = options.advertiseHost ?? detectLanAddress()
  if (!isPrivateIpv4(advertiseHost) && advertiseHost !== '127.0.0.1') {
    throw new Error('--advertise-host must be an explicit private IPv4 address')
  }
  const token = options.token ?? randomBytes(12).toString('base64url')
  const baseUrl = `http://${advertiseHost}:${options.port}/${token}`
  const cluster = await ensureClusterCredential(options.environment ?? process.env)
  const release = await stagePortableRelease({ artifacts: options.artifacts ?? [options.artifact], out: options.out, baseUrl, clusterSecret: cluster.secret })
  const server = createLanReleaseServer(release.output, token)
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.bindHost, resolvePromise)
  })
  const close = () => server.close()
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
  const commands = [
    release.installers.shell === undefined ? undefined : `macOS / Linux: curl -fsSL ${baseUrl}/install.sh | sh`,
    release.installers.powershell === undefined ? undefined : `Windows PowerShell: irm ${baseUrl}/install.ps1 | iex`,
  ].filter(Boolean)
  process.stdout.write([
    `AgentHarness ${release.version} LAN release is available at ${baseUrl}`,
    `Cluster: ${cluster.clusterId} (${cluster.fingerprint})`,
    'Send this command to a trusted peer on the same LAN:',
    ...commands,
    'Warning: private-LAN HTTP does not authenticate the server. Stop this process when distribution is complete.',
    '',
  ].join('\n'))
  await new Promise(resolvePromise => server.once('close', resolvePromise))
  process.removeListener('SIGINT', close)
  process.removeListener('SIGTERM', close)
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  serveLanRelease(parseLanArguments(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`agentharness-serve-lan-release: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
