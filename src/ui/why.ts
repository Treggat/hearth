/**
 * Derivations over the payload that are worth checking without a browser.
 *
 * Its own file, and not part of lib.ts, for one reason: lib.ts touches fetch,
 * window and localStorage, so it only typechecks with the DOM lib. Everything
 * here is pure and nothing else, which means a node test can import it and
 * assert the answers directly — and the answers are the part worth asserting,
 * since getting the wait order wrong reports somebody else's GPU as this
 * backend being busy, and getting the percentile wrong reports a healthy box
 * as a slow one.
 */
import type { Backend, Call, Job, Resource } from "./types.js";

/**
 * The hardware this backend needs that somebody ELSE is standing on.
 *
 * Empty for a backend that declared no resources, and empty for one whose
 * resources are free or held by itself — re-entrance is the normal case, a
 * backend running its second job is not blocked by its first.
 */
export function blockers(b: Backend, resources: Resource[]): Resource[] {
  const mine = b.resources ?? [];
  return resources.filter((r) => mine.includes(r.name) && r.holder !== null && r.holder !== b.name);
}

/**
 * Why this job is not running.
 *
 * The distinction the old page could not draw at all, and the one worth having:
 * a queue of four behind a busy backend is the system working, and a queue of
 * four behind a card somebody else is holding is the system waiting on a swap
 * that has not happened yet. They look identical as a number.
 *
 * Ordered the way admission actually decides — hardware first, because
 * canAdmit() checks it before either of the backend's own ceilings, so a
 * blocked backend reports "full" for a reason that is not the real one.
 */
export interface Wait {
  text: string;
  /** blocked = another backend has the card. busy = this one is full.
   *  cold = a load stands between the job and the GPU. lane = ordinary queueing. */
  tone: "blocked" | "busy" | "cold" | "lane";
}

export function waitReason(j: Job, b: Backend | undefined, resources: Resource[]): Wait {
  if (b) {
    const held = blockers(b, resources);
    if (held.length) {
      const r = held[0]!;
      return { tone: "blocked", text: `${r.name} — ${r.holder} has it` };
    }
    if (b.slots !== undefined && b.free === 0) {
      return { tone: "busy", text: `${b.name} full · ${b.slots} in flight` };
    }
    // Only a backend that evicts can make a job wait for a load. Everything
    // else keeps its set resident, so a cold model there is a cold START, not a
    // queue — saying "must unload" about it would be an invention.
    if (b.evicts && b.loaded?.length && !b.loaded.includes(j.model)) {
      return { tone: "cold", text: `${b.loaded.join(", ")} must unload first` };
    }
    if (b.evicts && b.knowsWarm && !b.loaded?.length) {
      return { tone: "cold", text: "cold — nothing is loaded yet" };
    }
  }
  return { tone: "lane", text: j.position ? `${j.position} ahead in ${j.lane}` : `${j.lane} lane` };
}

/**
 * The window's calls as the four numbers worth a line of the page.
 *
 * `calls` already carries every finished request, and per-request hover is the
 * wrong place to keep the only answer to "is this box slow, and is anything
 * failing" — a failure rate nobody can see until they open two disclosures is
 * a failure rate nobody sees.
 *
 * Nearest-rank percentiles over the run time alone. Queue wait is the
 * scheduler's doing and is reported beside it rather than folded in, because
 * they call for different responses: a slow p95 is a model or a card, and a
 * long wait is a queue.
 */
export interface CallStats {
  n: number;
  failed: number;
  /** Run time, milliseconds. Null when there is nothing to take a median of. */
  medianMs: number | null;
  p95Ms: number | null;
  /** The worst queue wait in the window, which is what "the queue was bad" means. */
  maxWaitMs: number;
}

export function callStats(calls: Call[] | undefined): CallStats {
  const n = calls?.length ?? 0;
  if (!calls || n === 0) return { n: 0, failed: 0, medianMs: null, p95Ms: null, maxWaitMs: 0 };
  const ran = calls.map((c) => c.ms).sort((a, b) => a - b);
  // Nearest-rank, so a single call is its own p95 rather than an interpolation
  // between it and nothing.
  const at = (q: number): number => ran[Math.min(ran.length - 1, Math.ceil(q * ran.length) - 1)]!;
  return {
    n,
    failed: calls.filter((c) => !c.ok).length,
    medianMs: at(0.5),
    p95Ms: at(0.95),
    maxWaitMs: Math.max(0, ...calls.map((c) => c.waitedMs)),
  };
}
