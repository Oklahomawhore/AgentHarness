/** Deterministic external MCP peer for the ACP Session snapshot. */
import { createInterface } from 'node:readline'

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  if (request.id === undefined) continue
  let result
  switch (request.method) {
    case 'initialize':
      result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'snapshot-add', version: '1' } }
      break
    case 'tools/list':
      result = { tools: [{ name: 'add', description: 'Add two numbers.', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } }] }
      break
    case 'tools/call':
      result = { content: [{ type: 'text', text: String(request.params.arguments.a + request.params.arguments.b) }] }
      break
    default:
      throw new Error(`Unexpected MCP fixture request: ${request.method}`)
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
}
