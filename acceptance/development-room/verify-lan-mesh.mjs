/** Black-box acceptance for peer-free development-room LAN replication. */

const objective = 'AgentHarness LAN auto-discovery acceptance'
const nodes = Object.freeze([
  Object.freeze({ id: 'node-a', origin: 'http://127.0.0.1:3081' }),
  Object.freeze({ id: 'node-b', origin: 'http://127.0.0.1:3082' }),
  Object.freeze({ id: 'node-c', origin: 'http://127.0.0.1:3083' }),
])

async function rpc(node, method, args) {
  const rpcId = `lan-acceptance-${method}-${crypto.randomUUID()}`
  const response = await fetch(`${node.origin}/api/developmentRooms/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(5_000),
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method: `developmentRooms/${method}`,
      payload: { args },
    }),
  })
  if (!response.ok) throw new Error(`${node.id} ${method} failed over HTTP ${String(response.status)}`)
  const body = await response.json()
  if (body?.type !== 'server-response' || body.rpcId !== rpcId || body.result?.ok !== true) {
    throw new Error(`${node.id} ${method} failed: ${JSON.stringify(body?.result?.error ?? body)}`)
  }
  return body.result.value
}

async function directory(node) {
  return rpc(node, 'list', {})
}

async function sourceRoom() {
  const current = await directory(nodes[0])
  const retained = current.rooms.find(room =>
    room.objective === objective && room.creationNodeId === nodes[0].id)
  return retained ?? rpc(nodes[0], 'create', { request: { objective } })
}

async function waitForReplication(roomId) {
  const deadline = Date.now() + 15_000
  let directories = []
  while (Date.now() < deadline) {
    directories = await Promise.all(nodes.map(directory))
    if (directories.every((snapshot, index) =>
      snapshot.nodeId === nodes[index].id && snapshot.rooms.some(room => room.id === roomId))) return
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`room ${roomId} did not converge: ${JSON.stringify(directories)}`)
}

const room = await sourceRoom()
await waitForReplication(room.id)
process.stdout.write(`development-room LAN acceptance passed: ${room.id} replicated across node-a, node-b, and node-c without configured peers\n`)
