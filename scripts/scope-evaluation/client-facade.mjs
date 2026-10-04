/** Identical QA-facing bytes for every client variant; reviewed clients execute in another process. */
let nextId = 0
const pending = new Map()
process.on('message', message => {
  if (message?.kind !== 'operation-result') return
  const call = pending.get(message.id)
  if (!call) return
  pending.delete(message.id)
  if (pending.size === 0) process.channel?.unref()
  if (message.ok) call.resolve(message.value)
  else call.reject(Object.assign(new Error(message.error.message), { code: message.error.code }))
})
process.channel?.unref()
function operation(method, payload) {
  return new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    process.channel?.ref()
    process.send({ kind: 'operation', id, method, payload }, error => {
      if (!error) return
      pending.delete(id)
      if (pending.size === 0) process.channel?.unref()
      reject(error)
    })
  })
}
/** Execute the selected client; omitted payload is an absent body. */
export const submit = payload => operation('submit', payload)
/** Clear the parent-owned request spy between assertions. */
export const resetRequests = () => operation('reset')
/** Obtain exact requests observed by the parent since the last reset. */
export const requests = () => operation('requests')
