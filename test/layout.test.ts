/**
 * The console's stage geometry, checked without a browser.
 *
 * The graph laid every kind of node out in exactly one row and clamped the
 * cell to a floor. Nine backends therefore wanted 1226px, and on anything
 * narrower the page — whose entire job is to be looked at — grew a horizontal
 * scrollbar and truncated every name to `swap-im…`. Meanwhile the three rows
 * were capped 150px apart and centred, so a tall window drew them in a band
 * across the middle and left a third of the stage empty underneath.
 *
 * Nothing tested it, because testing it appeared to need a DOM. It does not:
 * this half is arithmetic over a width, a height and some counts. What follows
 * is the arithmetic.
 *
 *     npx tsx test/layout.test.ts
 */
import assert from "node:assert/strict";

import { CELL, GAP, grid, H, MIN_GAP, PAD, STACK, tiers } from "../src/ui/layout.js";

/** The width a row of `count` cells actually occupies. */
const span = (count: number, w: number) => count * w + (count - 1) * GAP;

// --- nothing overflows sideways, at any size anyone has ---------------------
// The bug, stated as a property. Every window between a phone and a wall
// display, against every backend count this thing has plausibly got.
for (const width of [640, 800, 900, 1024, 1200, 1280, 1440, 1512, 1600, 1920, 2560, 3440]) {
  for (const n of [1, 2, 3, 5, 7, 8, 9, 11, 14, 20]) {
    const inner = width - PAD * 2;
    const { sizes, w } = grid(inner, n, CELL.backend, 4);
    const widest = Math.max(...sizes);
    // Either it fits, or it ran out of rows to wrap into — the one case where
    // the stage is allowed to scroll sideways, because the alternative is
    // clipping a card off the bottom where nobody sees it.
    assert.ok(span(widest, w) <= inner + 0.5 || sizes.length === 4,
      `${n} backends at ${width}px overflow: ${span(widest, w).toFixed(0)} > ${inner}`);
    assert.equal(sizes.reduce((a, b) => a + b, 0), n, "every backend is placed exactly once");
  }
}

// --- a row wraps before its cells stop being readable -----------------------
// Nine across 1240px "fit" at 122px each, and every subtitle in them read
// "nothing load…". Fitting is not the test; being readable is.
{
  const { sizes, w } = grid(1240, 9, CELL.backend, 4);
  assert.equal(sizes.length, 2, "nine backends wrap rather than squeeze");
  assert.deepEqual(sizes, [5, 4], "and they balance — 5 and 4, not 8 and 1");
  assert.ok(w >= CELL.backend.want, `cells reach a comfortable width (${w.toFixed(0)}px)`);
}

// --- but not when there is genuinely room ----------------------------------
{
  const { sizes } = grid(1700, 9, CELL.backend, 4);
  assert.equal(sizes.length, 1, "a wide window keeps one row, which reads best of all");
}

// --- height is a budget, and wrapping spends it -----------------------------
// Wrapping trades height for width. On a short window there is nothing to
// trade with, and a wrapped row would push the cards off the bottom — so the
// hard floor takes over and the cells get narrow instead.
{
  const short = grid(900, 9, CELL.backend, 1);
  assert.equal(short.sizes.length, 1, "no room to wrap means no wrapping");
  assert.ok(short.w >= CELL.backend.min,
    "the cell keeps its floor and the stage scrolls, rather than clipping a card");
  const tall = grid(900, 9, CELL.backend, 4);
  assert.ok(tall.sizes.length > 1, "room to wrap means wrapping");
  assert.ok(tall.w > short.w, "which is the whole trade: height for readable width");
}

// --- the tiers fill the stage rather than sitting in a band -----------------
for (const height of [640, 795, 900, 1100, 1400]) {
  const t = tiers(height, 2, 1);
  assert.ok(t.self >= PAD, "the top tier is on the stage");
  const bottom = t.resources + H.resource;
  assert.ok(bottom <= height - PAD + 0.5,
    `nothing hangs off the bottom at ${height}px (ends ${bottom.toFixed(0)})`);
  // "Fills" means the strip left under the cards is not worth having. The gap
  // ceiling scales with the stage so this holds on a wall display too, where a
  // fixed ceiling drew a small diagram marooned in the middle.
  assert.ok(height - bottom <= height * 0.15,
    `no dead band under the cards at ${height}px (${(height - bottom).toFixed(0)}px spare)`);
  // And what is left is shared top and bottom, never dumped at one end.
  assert.ok(Math.abs((t.self - PAD) - (height - PAD - bottom)) < 2,
    "leftover height is centred, not pushed to one side");
  assert.ok(t.backends > t.self && t.resources > t.backends, "tiers stay in order");
}

// --- a short stage keeps the tiers apart enough to read the edges -----------
{
  const t = tiers(300, 1, 1);
  assert.ok(t.backends - (t.self + H.self) >= MIN_GAP - 0.5,
    "edges keep a minimum length even when the window is too short for them");
  assert.ok(t.needed > 300, "and the stage says it needs more room, rather than overlapping");
}

// --- wrapped rows stack tighter than tiers do ------------------------------
// A wrapped row is one tier that ran out of width. Spacing it like a tier
// would say it is a different kind of thing.
{
  const t = tiers(900, 3, 1);
  const tierGap = t.backends - (t.self + H.self);
  assert.ok(STACK < tierGap, "rows of a kind sit closer than the kinds do");
  assert.equal(t.resources - t.backends, 3 * H.backend + 2 * STACK + tierGap,
    "and the tier below starts past all of them");
}

console.log("layout.test.ts ok");
