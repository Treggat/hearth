/**
 * Self-check for the one-shot sparks on the graph.
 *
 * A finished request gets one particle, and the edge it travels is drawn lit
 * while it does. The spark is supposed to go out about a second later.
 *
 * The bug this pins: the timer that put a spark out belonged to the effect that
 * lit it, and an effect's cleanup runs whenever its input changes. While the
 * page polled every 3s that could not matter — the timer always fired first.
 * Once frames were PUSHED, a second frame inside that second cancelled the
 * timer, and the spark it was for stayed lit until the page was reloaded. Any
 * back-to-back pair of requests did it, which is what an agent sends.
 *
 *     npx tsx test/sparks.test.ts
 */
import assert from "node:assert/strict";

import { SparkLedger, type Spark } from "../src/ui/sparks.js";
import type { Call } from "../src/ui/types.js";

/** A clock the test owns, so "a second later" takes no time and cannot flake. */
function clock() {
  let now = 0;
  let seq = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  return {
    timer: {
      set: (fn: () => void, ms: number) => { due.set(++seq, { at: now + ms, fn }); return seq; },
      clear: (h: unknown) => { due.delete(h as number); },
    },
    advance(ms: number) {
      now += ms;
      for (const [h, t] of [...due]) if (t.at <= now) { due.delete(h); t.fn(); }
    },
  };
}

const call = (t: number, backend = "ollama", ok = true): Call =>
  ({ t, model: "m", backend, ms: 10, waitedMs: 0, ok });

function ledger() {
  const c = clock();
  let lit: Spark[] = [];
  const l = new SparkLedger((s) => { lit = s; }, c.timer);
  return { l, c, lit: () => lit.map((s) => s.backend) };
}

// --- the first payload fires nothing ---------------------------------------
// It carries up to ten minutes of history. Replaying that as traffic would light
// the whole graph on every page load.
{
  const { l, lit } = ledger();
  l.feed([call(1), call(2)]);
  assert.deepEqual(lit(), []);
}

// --- a finished call gets one spark, and it goes out ------------------------
{
  const { l, c, lit } = ledger();
  l.feed([]);
  l.feed([call(1)]);
  assert.deepEqual(lit(), ["ollama"]);
  c.advance(1100);
  assert.deepEqual(lit(), [], "a second later it is gone");
}

// --- THE BUG: a frame inside that second must not strand the spark ----------
// Nothing new in the second frame at all — it only has to ARRIVE.
{
  const { l, c, lit } = ledger();
  l.feed([]);
  l.feed([call(1)]);
  c.advance(400);
  l.feed([call(1)]);
  c.advance(5000);
  assert.deepEqual(lit(), [], "the edge must not stay lit until the page is reloaded");
}

// --- back-to-back requests each go out on their own time --------------------
{
  const { l, c, lit } = ledger();
  l.feed([]);
  l.feed([call(1)]);
  c.advance(400);
  l.feed([call(1), call(2, "vllm")]);
  assert.deepEqual(lit(), ["ollama", "vllm"]);
  c.advance(700);
  assert.deepEqual(lit(), ["vllm"], "the first is out at its own second, not the second one's");
  c.advance(400);
  assert.deepEqual(lit(), []);
}

// --- a burst is a few sparks, not a smear -----------------------------------
{
  const { l, lit } = ledger();
  l.feed([]);
  l.feed(Array.from({ length: 50 }, (_, i) => call(i + 1)));
  assert.equal(lit().length, 6);
}

// --- a failed call is drawn as one ------------------------------------------
{
  const c = clock();
  let seen: Spark[] = [];
  const l = new SparkLedger((s) => { seen = s; }, c.timer);
  l.feed([]);
  l.feed([call(1, "ollama", false)]);
  assert.equal(seen[0]?.color, "error.main");
}

// --- and leaving the page stops the clock -----------------------------------
// The only moment a pending timer SHOULD be cancelled: there is no page left to
// tell.
{
  const c = clock();
  let emits = 0;
  const l = new SparkLedger(() => { emits++; }, c.timer);
  l.feed([]);
  l.feed([call(1)]);
  const before = emits;
  l.dispose();
  c.advance(5000);
  assert.equal(emits, before, "nothing is emitted into a page that has gone");
}

console.log("sparks ok");
