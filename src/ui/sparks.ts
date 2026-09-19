/**
 * One-shot sparks for calls that finished between frames. Most requests begin
 * and end between two frames, so this is what keeps a busy graph from looking idle.
 * The clock is injected so it tests without a DOM.
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
  /** A spark's timer belongs to the spark, not the frame: a new frame never cancels one. */
  private readonly pending = new Set<unknown>();

  constructor(
    private readonly emit: (sparks: Spark[]) => void,
    private readonly timer: SparkTimer = realTimer,
  ) {}

  /** Every frame, whether or not anything in it is new. */
  feed(calls: Call[] | undefined): void {
    if (!calls) return;
    // The first payload is history, not traffic: seed the seen-set and fire nothing.
    if (this.seen === null) { this.seen = new Set(calls.map(keyOf)); return; }
    const fresh = calls.filter((c) => !this.seen!.has(keyOf(c)));
    // Bounded by the 10-minute window; trim a long-lived tab against it.
    if (this.seen.size >= 2000) this.seen = new Set(calls.map(keyOf));
    if (!fresh.length) return;
    for (const c of fresh) this.seen.add(keyOf(c));
    // A burst is a few sparks, not a smear.
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

  /** Unmount: the only time a pending timer is cancelled. */
  dispose(): void {
    for (const h of this.pending) this.timer.clear(h);
    this.pending.clear();
    this.live = [];
  }
}
