/** Test-only transport: its parent owns the received request log and candidate-service response. */
let nextId = 0
const pending = new Map()
process.on('message', message => {
  if (message?.kind !== 'transport-result') return
  const call = pending.get(message.id)
  if (!call) return
  pending.delete(message.id)
  if (message.ok) call.resolve(message.value)
  else call.reject(Object.assign(new Error(message.error.message), { code: message.error.code }))
})

/** Send a controlled request to the parent-owned service fixture. */
export function request(value) {
  return new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    process.send({ kind: 'transport', id, value }, error => {
      if (!error) return
      pending.delete(id)
      reject(error)
    })
  })
}
