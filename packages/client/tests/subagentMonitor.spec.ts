import { describe, expect, it, vi } from 'vitest'
import { monitorParentForSession, SubagentMonitorController } from '../src/client/subagentMonitor/controller.ts'

describe('SubagentMonitorController', () => {
  it('opens without changing session navigation and supports nested catalogs', () => {
    const controller = new SubagentMonitorController()
    const listener = vi.fn()
    const dispose = controller.subscribe(listener)

    controller.open('root')
    expect(controller.snapshot()).toEqual({ open: true, path: ['root'], parentSessionId: 'root' })
    controller.descend('child')
    expect(controller.snapshot()).toEqual({ open: true, path: ['root', 'child'], parentSessionId: 'child' })
    controller.back()
    expect(controller.snapshot().parentSessionId).toBe('root')
    controller.close()
    expect(controller.snapshot()).toEqual({ open: false, path: [] })
    expect(listener).toHaveBeenCalledTimes(4)
    dispose()
  })

  it('uses the main parent while invoked from an addressed subagent', () => {
    expect(monitorParentForSession({ child: { origin: 'subagent', parentId: 'root' } }, 'child')).toBe('root')
    expect(monitorParentForSession({ root: { origin: 'user' } }, 'root')).toBe('root')
  })
})
