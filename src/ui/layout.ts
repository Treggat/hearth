/**
 * Where things go on the stage, as arithmetic.
 *
 * Split out of graph.tsx because it is the one part of the console that can be
 * checked without a browser: given a width, a height and some counts, it says
 * where every node lands. Everything else there needs a DOM to mean anything;
 * this needs a calculator, so it gets tested like arithmetic (test/layout.test.ts).
 *
 * The rules it exists to keep:
 *   nothing overflows sideways   a scrollbar on a page whose job is to be
 *                                looked at is a failure, not a fallback
 *   nothing is left empty        rows spread into the height they are given
 *   names stay readable          a row wraps before its cells get too narrow
 *                                to hold the words in them
 */

export const GAP = 18;
export const PAD = 10;
/** Between two rows of the SAME kind. Tighter than the gap between tiers,
 *  because a wrapped row is one band that ran out of width, not a new tier. */
export const STACK = 14;
export const H = { self: 82, peer: 82, backend: 86, resource: 66 } as const;
/** Below this the columns stop being readable and the stage scrolls instead. */
export const MIN_STAGE = 640;
/** How narrow and how wide a cell of each kind is allowed to get. The floor is
 *  what a name needs; the ceiling stops four backends becoming four billboards. */
/** `want` is where the cell reads comfortably and `min` is the hard floor. A
 *  row wraps at `want`, not at `min`: nine backends technically FIT across
 *  1240px at 122px each, and every subtitle in them says "nothing load…". */
export const CELL = {
  peer: { min: 150, want: 170, max: 210 },
  backend: { min: 118, want: 168, max: 184 },
  resource: { min: 120, want: 160, max: 200 },
} as const;
/** The tightest the tiers go before the edges are too short to read, and the
 *  loosest before the stage is mostly empty space with lines across it. */
export const MIN_GAP = 64;
export const MAX_GAP = 240;

/**
 * Fit `n` cells into `inner`, wrapping to as few rows as will hold them.
 *
 * The old layout gave every kind exactly one row and clamped the cell to a
 * floor, so nine backends wanted 1226px and anything narrower scrolled
 * sideways — on a page whose whole job is to be looked at, not read through a
 * scrollbar. Wrapping trades height for width, and height is what this stage
 * has spare: the same nine backends over two rows get 184px each instead of
 * 118, which is the difference between `swap-image` and `swap-im…`.
 *
 * Rows are balanced rather than filled greedily. 9 over two rows is 5 and 4,
 * not 8 and 1 — a short last row reads as "and one more", which is a claim
 * about the thing rather than about the window it is in.
 */
export function grid(
  inner: number, n: number, cell: { min: number; want: number; max: number }, maxRows = 4,
): { sizes: number[]; w: number } {
  if (n === 0) return { sizes: [], w: cell.min };
  const fits = (k: number): number => {
    const per = Math.ceil(n / k);
    return (inner - (per - 1) * GAP) / per;
  };
  // Wrap until the cells are comfortable or the height runs out, whichever
  // comes first. `maxRows` is a hard stop and not a preference: past it a
  // wrapped row would push the tier below off the bottom of the stage, and the
  // stage clips rather than scrolls vertically — so overflowing the height
  // loses a card silently, while overflowing the width leaves a scrollbar you
  // can at least see and use. Sideways is the failure to prefer.
  let k = 1;
  while (k < n && k < maxRows && fits(k) < cell.want) k++;
  const sizes: number[] = [];
  let left = n;
  for (let i = 0; i < k; i++) {
    const take = Math.ceil(left / (k - i));
    sizes.push(take);
    left -= take;
  }
  const per = Math.max(...sizes);
  return { sizes, w: Math.max(cell.min, Math.min(cell.max, (inner - (per - 1) * GAP) / per)) };
}

/**
 * Where each tier starts, once we know how many rows each one needs.
 *
 * The spare height goes into the two gaps that mean something — request
 * reaching a backend, backend standing on a card — and not into the gaps
 * between wrapped rows, which are one tier that happened to fold. The old
 * version capped the gap at 150 and centred what was left, so a tall window
 * drew three rows in the middle and left a third of the stage empty below the
 * cards.
 */
export function tiers(height: number, kB: number, kR: number): {
  self: number; backends: number; resources: number; needed: number;
} {
  const bH = kB * H.backend + Math.max(0, kB - 1) * STACK;
  const rH = kR * H.resource + Math.max(0, kR - 1) * STACK;
  const content = H.self + bH + rH;
  // The ceiling scales with the stage: a fixed one drew a small diagram in the
  // middle of a big monitor with a dead band above and below it, which is the
  // complaint this whole file exists to answer. It is still a ceiling, because
  // past some distance an edge stops reading as a connection and starts
  // reading as a line that happens to be there.
  const cap = Math.max(MAX_GAP, height * 0.3);
  const gap = Math.max(MIN_GAP, Math.min(cap, (height - PAD * 2 - content) / 2));
  const total = content + gap * 2;
  const top = Math.max(PAD, PAD + (height - PAD * 2 - total) / 2);
  return {
    self: top,
    backends: top + H.self + gap,
    resources: top + H.self + gap + bH + gap,
    needed: total + PAD * 2,
  };
}

