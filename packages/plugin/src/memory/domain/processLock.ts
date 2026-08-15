import * as path from 'path'
import { AsyncLock } from './AsyncLock.ts'

/**
 * Locks shared by every memory service in this Node.js process.
 *
 * Cordis may briefly keep an old fiber alive while a replacement fiber is
 * starting, and the migration adapter owns an independent MemoryService as
 * well.  Instance-local locks therefore do not protect the files they share.
 * Keying the lock by an absolute, platform-normalized path makes those
 * otherwise independent instances participate in the same critical section.
 */
export interface ProcessPathCoordinator {
  readonly lock: AsyncLock
  revision: number
}

const PROCESS_COORDINATORS = new Map<string, ProcessPathCoordinator>()

function normalizeLockPath(fsPath: string): string {
  const absolute = path.resolve(fsPath).replace(/\\/g, '/')
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

export function getProcessPathCoordinator(kind: string, fsPath: string): ProcessPathCoordinator {
  const key = `${kind}:${normalizeLockPath(fsPath)}`
  let coordinator = PROCESS_COORDINATORS.get(key)
  if (!coordinator) {
    coordinator = { lock: new AsyncLock(), revision: 0 }
    PROCESS_COORDINATORS.set(key, coordinator)
  }
  return coordinator
}

export function getProcessPathLock(kind: string, fsPath: string): AsyncLock {
  return getProcessPathCoordinator(kind, fsPath).lock
}
