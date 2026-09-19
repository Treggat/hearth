/**
 * One-shot sparks for requests that finished since the last frame.
 *
 * Running jobs already draw themselves, and at a homelab's duty cycle most
 * requests begin and end between two frames — the queue is empty every time you
 * look, and the graph would sit dead while the box was busy. `calls` is the
 * record of exactly those, so a finished call gets one particle.
 *
 * Plain, with its clock handed in, so it can be tested without a DOM: the hook
 * in graph.tsx only feeds it frames and tells it when the page has gone.
 */
import type { Call } from "./types.js";

export interface Spark { key: string; backend: string; color: string }

/** setTimeout and clearTimeout, or a test's stand-ins for them. */
export interface SparkTimer {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const realTimer: SparkTimer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** How long a spark is drawn. Matches the particle's one pass along the run. */
const TTL_MS = 1100;

const keyOf = (c: Call) => `${c.t}:${c.model}:${c.backend}`;

export class SparkLedger {
  private seen: Set<string> | null = null;
  private live: Spark[] = [];
  /**
   * Every timer still owed, not just the latest.
   *
   * A spark's timer is the spark's, not the frame's. It used to belong to the
   * effect that lit it, whose cleanup runs whenever a new frame arrives — fine
   * while the page polled every 3s, since the timer always fired first. Once
   * frames were pushed, a second one inside that second cancelled it, and the
   * spark it was for stayed lit until the page was reloaded.
   */
  private readonly pending = new Set<unknown>();

  constructor(
    private readonly emit: (sparks: Spark[]) => void,
    private readonly timer: SparkTimer = realTimer,
  ) {}

  /** Every frame, whether or not anything in it is new. */
  feed(calls: Call[] | undefined): void {
    if (!calls) return;
    // The first payload carries up to ten minutes of calls and fires NONE:
    // seeding the seen-set is the whole reason this keeps one.
    if (this.seen === null) { this.seen = new Set(calls.map(keyOf)); return; }
    const fresh = calls.filter((c) => !this.seen!.has(keyOf(c)));
    // The set grows with a bounded 10-minute window, so it cannot run away — but
    // a long-lived tab still trims it against the window it is given.
    if (this.seen.size >= 2000) this.seen = new Set(calls.map(keyOf));
    if (!fresh.length) return;
    for (const c of fresh) this.seen.add(keyOf(c));
    // A burst of fifty would be a smear, not information. The newest few carry
    // the same message: that backend is working.
    const add = fresh.slice(-6).map((c) => ({
      key: `${keyOf(c)}:${Math.random().toString(36).slice(2, 7)}`,
      backend: c.backend,
      color: c.ok ? "success.main" : "error.main",
    }));
    this.live = [...this.live, ...add];
    this.emit(this.live);
    const handle = this.timer.set(() => {
      this.pending.delete(handle);
      this.live = this.live.filter((x) => !add.some((a) => a.key === x.key));
      this.emit(this.live);
    }, TTL_MS);
    this.pending.add(handle);
  }

  /** The page has gone — the one moment a pending timer should be cancelled. */
  dispose(): void {
    for (const h of this.pending) this.timer.clear(h);
    this.pending.clear();
    this.live = [];
  }
}
