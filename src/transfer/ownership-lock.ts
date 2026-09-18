/**
 * Per-group serialization boundary for ownership operations.
 *
 * Ownership flows are read-modify-write sequences spanning several `await`s:
 * `propose` checks the caller is the owner, then checks membership, then writes
 * the proposal; `accept` reads the proposal, then the current owner, then
 * transfers; `admin.setOwner` reads the current owner, then transfers, then
 * invalidates any proposal. Each individual statement is atomic (better-sqlite3
 * is synchronous, so a `raw.transaction(...)` cannot be interleaved), but whole
 * handlers do interleave at their `await` boundaries — so one operation can act
 * on state another has already invalidated. Concretely, without this: an owner
 * demoted by `admin.setOwner` mid-`propose` still writes a proposal, and an
 * `accept` that read a proposal before `setOwner` ran reverses the operator's
 * reassignment.
 *
 * `run` chains callbacks per group DID, so those sequences execute one at a
 * time and each sees the previous one's committed result. The chain is a plain
 * promise queue — this serializes handlers inside one process only, which is
 * what the single-writer per-group SQLite model already assumes.
 *
 * Hold it around validation plus mutation, and nothing else: identity and handle
 * resolution (network I/O) belong outside, or an unreachable PDS stalls every
 * ownership operation on that group.
 */
export class OwnershipLock {
  /** Tail of the pending chain per group; absent when the group is idle. */
  private tails = new Map<string, Promise<void>>()

  /** Run `fn` once every operation queued before it on `groupDid` has settled. */
  async run<T>(groupDid: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(groupDid) ?? Promise.resolve()
    // `previous` is always a settled-swallowing tail, so it never rejects and
    // `fn` always runs: one handler throwing must not wedge the group's queue.
    const result = previous.then(fn)
    const tail = result.then(
      () => {},
      () => {},
    )
    this.tails.set(groupDid, tail)
    try {
      return await result
    } finally {
      // Drop the entry once this is the last queued operation, so the map does
      // not grow one permanent entry per group the process ever touches.
      if (this.tails.get(groupDid) === tail) this.tails.delete(groupDid)
    }
  }
}
