#!/usr/bin/env node
/** Start one extracted AgentHarness portable runtime without a source checkout. */

import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ensureClusterCredential } from './agentharness-cluster.mjs'
import { ensureNodeIdentity } from './agentharness-node-identity.mjs'

const AGENTHARNESS_PROVIDER_BASE_URL = 'https://ark.cn-beijing.volces.com/api/coding/v3'

function hasOption(args, name) {
  return args.some(argument => argument === name || argument.startsWith(`${name}=`))
}

/** Add private single-node defaults while retaining every explicit Web flag. */
export function portableWebArguments(args) {
  return [
    'web',
    ...hasOption(args, '--host') ? [] : ['--host', '127.0.0.1'],
    ...hasOption(args, '--port') ? [] : ['--port', '3080'],
    ...args,
  ]
}

/** Supply only non-secret product defaults; caller values always win. */
export function portableEnvironment(environment) {
  return {
    ...environment,
    AGENTHARNESS_PROVIDER_BASE_URL: environment.AGENTHARNESS_PROVIDER_BASE_URL ?? AGENTHARNESS_PROVIDER_BASE_URL,
  }
}

/** Forward signals and return the child CLI exit code. */
export async function runPortable(args, environment = process.env) {
  const bin = join(import.meta.dirname, 'lib', 'bin.js')
  const cluster = await ensureClusterCredential(environment)
  const nodeId = await ensureNodeIdentity(environment)
  process.stdout.write(`AgentHarness local node: ${nodeId}; cluster: ${cluster.clusterId} (${cluster.fingerprint})\n`)
  const child = spawn(process.execPath, [bin, ...portableWebArguments(args)], {
    cwd: import.meta.dirname,
    // The endpoint is public configuration, not a credential. Source runs
    // inherit the same value from the repository .env; a source-free build
    // must remain bootable before the user supplies their own API key.
    env: {
      ...portableEnvironment(environment),
      AGENTHARNESS_CLUSTER: cluster.clusterId,
      AGENTHARNESS_NODE_ID: nodeId,
      DSH_ROOM_NODE_ID: nodeId,
    },
    stdio: 'inherit',
  })
  const forwardInterrupt = () => { child.kill('SIGINT') }
  const forwardTerminate = () => { child.kill('SIGTERM') }
  process.once('SIGINT', forwardInterrupt)
  process.once('SIGTERM', forwardTerminate)
  try {
    return await new Promise((resolvePromise, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => {
        resolvePromise(code ?? (signal === 'SIGINT' ? 130 : 1))
      })
    })
  } finally {
    process.removeListener('SIGINT', forwardInterrupt)
    process.removeListener('SIGTERM', forwardTerminate)
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  runPortable(process.argv.slice(2)).then((code) => { process.exitCode = code }).catch((error) => {
    process.stderr.write(`agentharness-portable: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
