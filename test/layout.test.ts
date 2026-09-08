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

import {
  CELL, countCrossings, GAP, grid, H, layout, MIN_GAP, orderBackends, PAD, STACK, tiers,
} from "../src/ui/layout.js";
import type { Backend, Resource } from "../src/ui/types.js";

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

// --- wires that do not cross each other ------------------------------------
//
// The tiers are a layered graph, so how tangled the picture is comes down to
// one thing: the order of the backends. That used to be the order they appear
// in the config file, which knows nothing about which card each one uses — so a
// config grouped by purpose drew a dozen crossings, and every wire had to be
// traced rather than followed.
//
// Two halves, and both are needed. Ordering puts backends that share a card
// beside each other; filling the wrapped rows DOWN each column keeps them
// beside each other once there is more than one row, instead of wrapping the
// run back to the left edge with its card left behind on the right.
{
  const mk = (spec: [string, string[]][]) => {
    const backends: Backend[] = spec.map(([name, resources]) => ({ name, resources }));
    const names = [...new Set(spec.flatMap(([, rs]) => rs))].sort();
    const resources: Resource[] = names.map((name) => ({
      name,
      kind: name === "cpu" ? ("cpu" as const) : ("gpu" as const),
      holder: null,
      backends: spec.filter(([, rs]) => rs.includes(name)).map(([n]) => n),
    }));
    return { backends, resources };
  };

  // web's own shape: two cards and a shared cpu with six sidecars on it.
  const real = mk([
    ["swap", ["b70"]], ["swap-image", ["b60"]], ["video", ["b60"]],
    ["guard", ["cpu"]], ["judge", ["cpu"]], ["expander", ["cpu"]],
    ["embed", ["cpu"]], ["classifier", ["cpu"]], ["tts", ["cpu"]],
  ]);

  // Declared interleaved, which is what grouping a config by purpose looks
  // like, plus one backend spanning two cards.
  const interleaved = mk([
    ["guard", ["cpu"]], ["swap", ["b70"]], ["judge", ["cpu"]], ["swap-image", ["b60"]],
    ["embed", ["cpu"]], ["video", ["b60"]], ["tts", ["cpu"]], ["deep", ["b60", "b70"]],
    ["classifier", ["cpu"]],
  ]);

  // Eight sidecars on one shared cpu: a group far too big for one row, which is
  // the case that forced the wires straight.
  const manyCpu = mk([
    ["gpu", ["b70"]],
    ...Array.from({ length: 8 }, (_, i) => [`side${i}`, ["cpu"]] as [string, string[]]),
  ]);
  // Two cards, no shared hardware, nothing in common between the halves.
  const split = mk([
    ["a", ["g0"]], ["b", ["g0"]], ["c", ["g0"]],
    ["d", ["g1"]], ["e", ["g1"]], ["f", ["g1"]],
  ]);

  // Every window a laptop or a monitor might give the stage, not the three that
  // happened to look right: the tier wraps to one, two and three rows across
  // this range, and the wrap is what used to decide whether wires tangled.
  let checked = 0;
  for (const [label, { backends, resources }] of
       [["real", real], ["interleaved", interleaved],
        ["manyCpu", manyCpu], ["split", split]] as const) {
    const ordered = orderBackends(backends, resources);
    for (let w = 660; w <= 2000; w += 40) {
      for (const h of [600, 800, 1000, 1200]) {
        assert.equal(countCrossings(layout(w, h, [], ordered, resources)), 0,
          `${label} at ${w}x${h} should draw no crossed wires`);
        checked++;
      }
    }
  }
  assert.ok(checked > 500, `the sweep must actually run (${checked} layouts)`);

  // The ordering is what does it, not the fill alone: the interleaved config
  // still crosses if the backends are left in the order they were declared.
  const asDeclared = layout(1500, 900, [], interleaved.backends, interleaved.resources);
  assert.ok(countCrossings(asDeclared) > 0,
    "the fixture must actually be tangled without ordering, or it proves nothing");

  // A backend spanning two cards belongs BETWEEN them, which is what the
  // average of its cards means and the reason it is an average at all.
  const order = orderBackends(interleaved.backends, interleaved.resources).map((b) => b.name);
  assert.ok(order.indexOf("deep") > order.indexOf("swap-image")
            && order.indexOf("deep") < order.indexOf("swap"),
    `a backend on b60+b70 sits between them (got ${order.join(" ")})`);

  // Backends with no hardware draw no wire, so they sort out of the way rather
  // than splitting a run of backends that do.
  const withBare = mk([["a", ["b60"]], ["b", ["b70"]]]);
  withBare.backends.splice(1, 0, { name: "bare" });
  const bareOrder = orderBackends(withBare.backends, withBare.resources).map((b) => b.name);
  assert.equal(bareOrder[bareOrder.length - 1], "bare",
    "a backend that competes for nothing goes last, not through the middle");

  // Stable: the same payload gives the same picture every poll, or a node moves
  // out from under the pointer between refreshes.
  const twice = orderBackends(real.backends, real.resources).map((b) => b.name);
  assert.deepEqual(orderBackends(real.backends, real.resources).map((b) => b.name), twice);
}
