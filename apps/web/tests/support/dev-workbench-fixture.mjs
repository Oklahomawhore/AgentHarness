import { createServer } from 'node:http'

const port = Number(process.argv[2])
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new TypeError('dev-workbench fixture requires a TCP port argument')
}

const readyAt = Date.now() + 3_000
const server = createServer((request, response) => {
  if (request.url === '/ready') {
    response.writeHead(Date.now() >= readyAt ? 200 : 503).end()
    return
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end('<!doctype html><html><body><main>Example fixture page</main></body></html>')
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`fixture listening on ${String(port)}\n`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { server.close() })
}
