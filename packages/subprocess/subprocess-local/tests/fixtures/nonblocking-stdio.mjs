/** Preload nonblocking stdio into the real source runner before its target exec. */
import { constants, writeSync } from 'node:fs'
import koffi from 'koffi'

const fcntl = koffi.load(null).func('int fcntl(int fd, int cmd, int arg)')
const nonblocking = []
for (const fd of [0, 1, 2]) {
  const flags = fcntl(fd, 3, 0)
  if (flags === -1 || fcntl(fd, 4, flags | constants.O_NONBLOCK) === -1) {
    throw new Error(`cannot prepare nonblocking stdio ${fd}`)
  }
  nonblocking.push((fcntl(fd, 3, 0) & constants.O_NONBLOCK) !== 0)
}
writeSync(3, JSON.stringify(nonblocking))
