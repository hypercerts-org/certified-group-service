import { describe, it, expect } from 'vitest'
import { OwnershipLock } from '../src/transfer/ownership-lock.js'

const GROUP = 'did:plc:group'
const OTHER = 'did:plc:other'

/** A promise plus the handle to settle it, so a test can hold an operation open. */
function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('OwnershipLock', () => {
  it('runs operations on one group one at a time', async () => {
    const lock = new OwnershipLock()
    const first = deferred()
    const order: string[] = []

    const a = lock.run(GROUP, async () => {
      order.push('a:start')
      await first.promise
      order.push('a:end')
    })
    const b = lock.run(GROUP, async () => {
      order.push('b:start')
    })

    // `b` cannot have started while `a` holds the lock.
    await Promise.resolve()
    expect(order).toEqual(['a:start'])

    first.resolve()
    await Promise.all([a, b])
    expect(order).toEqual(['a:start', 'a:end', 'b:start'])
  })

  it('does not serialize across groups', async () => {
    const lock = new OwnershipLock()
    const held = deferred()
    const started: string[] = []

    const blocking = lock.run(GROUP, async () => {
      started.push(GROUP)
      await held.promise
    })
    await lock.run(OTHER, async () => {
      started.push(OTHER)
    })

    expect(started).toEqual([GROUP, OTHER])
    held.resolve()
    await blocking
  })

  it('releases the lock when an operation throws', async () => {
    const lock = new OwnershipLock()

    await expect(
      lock.run(GROUP, async () => {
        throw new Error('handler failed')
      }),
    ).rejects.toThrow('handler failed')

    // The queue must not be wedged by the rejection above.
    await expect(lock.run(GROUP, async () => 'ok')).resolves.toBe('ok')
  })

  it('propagates the operation result to its caller', async () => {
    const lock = new OwnershipLock()
    await expect(lock.run(GROUP, async () => 42)).resolves.toBe(42)
  })
})
