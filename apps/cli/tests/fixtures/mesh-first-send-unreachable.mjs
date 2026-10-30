// Fail only the first Mesh discovery send, keeping real UDP binding and membership.
import dgram from 'node:dgram'
import { syncBuiltinESMExports } from 'node:module'

const createSocket = dgram.createSocket
let injected = false
dgram.createSocket = function (...options) {
  const socket = Reflect.apply(createSocket, this, options)
  const send = socket.send
  socket.send = function (...args) {
    const callback = args.at(-1)
    if (!injected && args[2] === '239.255.73.67' && typeof callback === 'function') {
      injected = true
      process.stderr.write('Mesh fixture: first multicast send is unreachable\n')
      queueMicrotask(() => { callback(Object.assign(new Error('send EHOSTUNREACH'), { code: 'EHOSTUNREACH' })) })
      return
    }
    if (injected && args[2] === '239.255.73.67') {
      process.stderr.write('Mesh fixture: discovery announcement continued\n')
    }
    return Reflect.apply(send, this, args)
  }
  return socket
}
syncBuiltinESMExports()
