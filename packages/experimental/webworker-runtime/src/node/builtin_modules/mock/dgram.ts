/** UDP sockets and multicast discovery are unavailable in the browser Worker. */
import { notImplementedFail } from '../../notImplementedFail.ts'

/** Create a UDP socket (unavailable in the Worker). */
export const createSocket = notImplementedFail<typeof import('node:dgram').createSocket>('node:dgram', 'createSocket')

/** CommonJS interop marker for the Worker module loader. */
export const __esModule = true

/** The imported UDP socket API refuses before acquiring any resource. */
export default { createSocket }
