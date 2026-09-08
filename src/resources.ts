/**
 * Handing physical hardware between the backends that share it.
 *
 * A backend is an admission domain, but it is not always an independent one.
 * Two llama-swap instances pinned to the same GPU are two backends and one
 * piece of silicon; a model large enough to span every card is one backend that
 * consumes all of them. Nothing in the per-backend queues can see that, so both
 * dispatch happily and the card is over-committed — which on some drivers is
 * not a slow request but a wedged GPU.
 *
 * So a backend may declare what it consumes, and this decides who gets it:
 *
 *     backends:
 *       - name: swap          # one card
 *         resources: [gpu0]
 *       - name: swap-image    # the other
 *         resources: [gpu1]
 *       - name: deep          # a model that needs both
 *         resources: [gpu0, gpu1]
 *
 * THIS IS NOT SCHEDULING ACROSS BACKENDS. Routing is untouched: a model still
 * resolves to exactly one backend by the same rules it always did, and nothing
 * here ever decides a job would be better off somewhere else. What changes is
 * admission — a backend waits for hardware another backend is using. Placement
 * and exclusion are different questions, and only the first one was ever
 * disclaimed.
 *
 * Declaring nothing means competing for nothing, which is every existing config.
 *
 * ---
 *
 * This is a handover policy and not a lock, because both of the policies a
 * plain lock gives you are wrong here:
 *
 *   Whoever asks next wins. A backend releases the card between its own jobs,
 *   so a busy one re-takes it before its neighbour is ever considered — and a
 *   backend under sustained load holds a card forever while the one beside it
 *   never runs at all.
 *
 *   Strictly the longest waiter. Perfectly fair and maximally expensive: the
 *   card changes hands on every job, and each handover costs the next holder a
 *   cold load. That is the load tax the queue exists to avoid, moved up a
 *   level.
 *
 * So a holder keeps the card while it still has work — weights stay put and a
 * queue drains at full speed — and yields once it has held for `maxHoldMs`
 * with somebody else waiting. The bound only ever binds under saturation,
 * which is exactly the case where the first policy starves someone.
 *
 * A claim is the enqueue time of the oldest job a backend cannot start, so
 * "who has waited longest" is measured in the same units the scheduler already
 * ages jobs in, and a claim cannot go stale: no queued work, no claim.
 */

/** Anything with identity; in practice the owning Scheduler. */
export type ResourceOwner = object;

/**
 * How long a backend may keep hardware once a neighbour is waiting for it.
 *
 * Only ever consulted while somebody else is actually blocked, so this is a
 * starvation bound and not a scheduling interval: a card with no contention is
 * never taken away, however long one backend keeps it.
 *
 * 30s sits above a typical cold load, so a backend that wins the card gets to
 * amortize the load it just paid for over some real work, and below the point
 * where a waiting interactive request has obviously been abandoned.
 *
 * ponytail: one number for the whole node, where the honest unit is per-card —
 * a seat whose models take 60s to load wants a longer turn than one that loads
 * in two. Declare it under `resources.<name>` and pick the tightest of the
 * holder's set if a deployment ever needs them to differ.
 */
export const MAX_HOLD_MS = 30_000;

export interface ArbiterOptions {
  maxHoldMs?: number;
  /** Injected so a test can move time without waiting for it. */
  now?: () => number;
}

export class ResourceArbiter {
  /** resource name -> current owner. Absent means free. */
  private readonly holders = new Map<string, ResourceOwner>();
  /** owner -> what it is blocked on, and since when. Absent means not waiting. */
  private readonly claims = new Map<ResourceOwner, { resources: readonly string[]; since: number }>();
  /** owner -> when its current turn began. Absent means it holds nothing. */
  private readonly heldSince = new Map<ResourceOwner, number>();
  private readonly listeners = new Set<() => void>();
  private readonly maxHoldMs: number;
  private readonly now: () => number;

  constructor(opts: ArbiterOptions = {}) {
    this.maxHoldMs = opts.maxHoldMs ?? MAX_HOLD_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Is this hardware physically free for `owner`?
   *
   * Resources it already holds do not block it — re-entrance is the normal case
   * for a backend admitting a second job while its first is still running.
   *
   * Says nothing about whose turn it is. Capacity reporting wants this one:
   * "somebody else is on the card" is a fact about the hardware, while being
   * out-ranked is a transient that resolves itself within one job.
   */
  available(resources: readonly string[], owner?: ResourceOwner): boolean {
    for (const r of resources) {
      const held = this.holders.get(r);
      if (held !== undefined && held !== owner) return false;
    }
    return true;
  }

  /**
   * Note that `owner` has work it cannot start, waiting since `since`, or clear
   * the claim with null.
   *
   * `since` is the enqueue time of the oldest such job rather than the moment
   * the claim was filed, so a backend that has been sitting on a request does
   * not lose its place by being pumped late.
   */
  claim(owner: ResourceOwner, resources: readonly string[], since: number | null): void {
    if (since === null) this.claims.delete(owner);
    else this.claims.set(owner, { resources, since });
  }

  /** The longest-waiting claimant that overlaps `resources`, excluding `owner`. */
  private waiter(
    resources: readonly string[],
    owner: ResourceOwner,
  ): { owner: ResourceOwner; since: number } | null {
    let best: { owner: ResourceOwner; since: number } | null = null;
    for (const [other, c] of this.claims) {
      if (other === owner) continue;
      if (!c.resources.some((r) => resources.includes(r))) continue;
      if (best === null || c.since < best.since) best = { owner: other, since: c.since };
    }
    return best;
  }

  /**
   * May `owner` take these right now?
   *
   * Free, and nobody with an older claim on any of them. The second half is
   * what stops a backend re-taking a card the instant it releases it while a
   * neighbour that asked first is still waiting to be woken.
   */
  mayTake(resources: readonly string[], owner: ResourceOwner): boolean {
    if (!this.available(resources, owner)) return false;
    const ahead = this.waiter(resources, owner);
    if (ahead === null) return true;
    const mine = this.claims.get(owner);
    // No claim of our own means we have only just arrived, so anybody already
    // waiting was here first.
    return mine !== undefined && mine.since <= ahead.since;
  }

  /**
   * Has `owner` had its turn, with somebody else waiting for it?
   *
   * False whenever nothing is contended, which is the normal state: a card
   * nobody else wants is never taken away.
   */
  owed(resources: readonly string[], owner: ResourceOwner): boolean {
    const since = this.heldSince.get(owner);
    if (since === undefined) return false;
    if (this.now() - since < this.maxHoldMs) return false;
    return this.waiter(resources, owner) !== null;
  }

  /**
   * Take all of them, or none.
   *
   * All-or-nothing matters: a partial take is how two backends each holding
   * half of what they need wait on each other forever. Acquiring in sorted
   * order on top of that means two callers wanting overlapping sets always
   * contend on the same first resource, so one of them loses the whole set
   * rather than both stalling holding part of it.
   *
   * Starts the turn, and drops the claim this was the answer to.
   */
  acquire(resources: readonly string[], owner: ResourceOwner): boolean {
    if (!this.available(resources, owner)) return false;
    for (const r of [...resources].sort()) this.holders.set(r, owner);
    if (!this.heldSince.has(owner)) this.heldSince.set(owner, this.now());
    this.claims.delete(owner);
    return true;
  }

  /** Everything `owner` holds, released, then wake anyone waiting. */
  release(owner: ResourceOwner): void {
    let freed = false;
    for (const [r, held] of [...this.holders]) {
      if (held === owner) {
        this.holders.delete(r);
        freed = true;
      }
    }
    // The turn ends with the hold, so the next one starts a fresh quantum
    // rather than inheriting an expired one.
    this.heldSince.delete(owner);
    if (freed) for (const cb of [...this.listeners]) cb();
  }

  /**
   * Who holds what, right now.
   *
   * For status surfaces only — nothing schedules off this, and it is a copy so
   * a reader cannot mutate the map it was handed. It exists because the whole
   * point of `resources` is invisible otherwise: a backend sitting at 0/16 with
   * an empty queue looks idle on every existing readout, when in fact it cannot
   * start anything until the backend beside it lets go of the card.
   */
  snapshot(): [string, ResourceOwner][] {
    return [...this.holders];
  }

  /** Called whenever anything is released, so waiting schedulers re-pump. */
  onRelease(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
