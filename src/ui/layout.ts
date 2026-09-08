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
 *   wires cross as little as     the picture is only worth having if a line
 *   they can                     can be followed from a backend to its card
 */
import type { Backend, Node, Resource } from "./types.js";

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

/* --------------------------------------------------------- ordering */

/**
 * Order the backends so their wires to the cards below cross as little as
 * possible.
 *
 * The tiers are a layered graph and the cards are placed under whichever
 * backends use them, so the ONE thing that decides how tangled the picture is
 * is the order of the backends — and that was the order they appear in the
 * config file, which knows nothing about the hardware.
 *
 * The rule is the barycentre heuristic, and it is the whole of it: a backend
 * sits where its cards sit, on average. Two backends on one card end up beside
 * each other, a backend spanning two cards ends up between them, and cards then
 * land under their own users rather than being dragged across the stage by a
 * neighbour that happened to be declared first.
 *
 * Cards are indexed in the order they arrive, which is the server's own sort.
 * Any stable order works — what matters is that the backends and the cards are
 * ranked on the SAME one, or sorting one against the other just moves the
 * tangle somewhere else.
 *
 * Backends that declare no hardware draw no downward wire at all, so they can
 * go anywhere; they keep their configured order at the end, where they are out
 * of the way of the wires that do exist.
 */
export function orderBackends(backends: Backend[], resources: Resource[]): Backend[] {
  const rank = new Map(resources.map((r, i) => [r.name, i]));
  const key = (b: Backend): number => {
    const mine = (b.resources ?? []).map((n) => rank.get(n)).filter((i): i is number => i !== undefined);
    // No hardware, no wire: sorts past everything that has one.
    if (!mine.length) return Number.POSITIVE_INFINITY;
    return mine.reduce((a, x) => a + x, 0) / mine.length;
  };
  // Stable, so backends sharing a card keep the order the operator wrote them
  // in and the picture does not reshuffle between polls.
  return [...backends].sort((a, b) => key(a) - key(b));
}

/* ------------------------------------------------------- placement */


export interface Placed {
  id: string;
  kind: "self" | "peer" | "backend" | "resource";
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Edge {
  id: string;
  from: string;
  to: string;
  /** Sibling links leave sideways; parent links leave downwards. */
  dir: "across" | "down";
  d: string;
  /** Where a count sits, and the only point on the path we need in JS. */
  mid: { x: number; y: number };
}

export interface Scene {
  nodes: Map<string, Placed>;
  edges: Edge[];
  width: number;
  height: number;
}

/**
 * The mark's size for a node of this width. Shared, not duplicated.
 *
 * The layout needs it because edges must stop where the node LOOKS like it
 * starts, and NodeBox needs it to draw the thing. Two copies of this drifting
 * apart is edges that end near a node instead of at it.
 */
export const glyphFor = (w: number): number =>
  Math.round(Math.max(26, Math.min(36, w * 0.26)));

/**
 * How far inside its own box a node's visible content begins.
 *
 * The box is the click target and it is taller than what it draws: the mark and
 * the text are centred in it, and since the border and fill are gone at rest
 * there is nothing at the boundary to see. An edge drawn to the boundary
 * therefore stops in empty space a good fifteen pixels short of the node, which
 * is exactly what it looks like — six lines converging on nothing above the CPU.
 */
const inset = (p: Placed): number => Math.max(0, (p.h - glyphFor(p.w)) / 2);

/** B(0.5) of a cubic, which is where a label on it belongs. */
const midOf = (p0: number, p1: number, p2: number, p3: number): number =>
  (p0 + 3 * p1 + 3 * p2 + p3) / 8;

/**
 * A cubic with its control points pushed out along the direction of travel.
 *
 * `lift` bows the curve off the straight line between two nodes, which is what
 * lets one pair carry two edges: out and back are different facts about a peer
 * — whether you are leaning on them or they on you — and drawn on one line they
 * are indistinguishable.
 */
function curve(a: Placed, b: Placed, dir: "across" | "down", lift = 0): {
  d: string; mid: { x: number; y: number };
} {
  if (dir === "across") {
    // Right-to-left when the target is left of the source, so the return leg
    // starts at the peer and a particle on it travels the way the work does.
    const back = b.x < a.x;
    const x1 = back ? a.x : a.x + a.w, y1 = a.y + a.h / 2 + lift * 0.5;
    const x2 = back ? b.x + b.w : b.x, y2 = b.y + b.h / 2 + lift * 0.5;
    const k = Math.max(28, Math.abs(x2 - x1) * 0.42) * (back ? -1 : 1);
    const c1y = y1 + lift, c2y = y2 + lift;
    return {
      d: `M ${x1} ${y1} C ${x1 + k} ${c1y} ${x2 - k} ${c2y} ${x2} ${y2}`,
      mid: { x: midOf(x1, x1 + k, x2 - k, x2), y: midOf(y1, c1y, c2y, y2) },
    };
  }
  // Inset the TARGET only, and this asymmetry is the point. A backend's content
  // fills its box top to bottom — name, state, sparkline — so a line leaving the
  // bottom edge leaves the node. A card's content is a mark and two short lines
  // centred in a taller box, so a line arriving at the top edge stops in empty
  // space above it. Insetting both ends made edges sprout from the middle of the
  // backends instead.
  const x1 = a.x + a.w / 2, y1 = a.y + a.h;
  const x2 = b.x + b.w / 2, y2 = b.y + inset(b);
  const k = Math.max(20, (y2 - y1) * 0.55);
  return {
    d: `M ${x1} ${y1} C ${x1} ${y1 + k} ${x2} ${y2 - k} ${x2} ${y2}`,
    mid: { x: midOf(x1, x1, x2, x2), y: midOf(y1, y1 + k, y2 - k, y2) },
  };
}

/**
 * Place everything for a given stage width.
 *
 * Deterministic: same payload and same width give the same picture every poll.
 * That is not an aesthetic preference — a node that moves between polls cannot
 * be clicked, and a particle mid-flight would jump.
 */
export function layout(width: number, height: number, peers: Node[],
                backends: Backend[], resources: Resource[]): Scene {
  const nodes = new Map<string, Placed>();
  const inner = width - PAD * 2;

  // How many rows of backends the height can take before the tiers themselves
  // have nowhere to go. Wrapping trades height for width, and this is the
  // budget: past it, a wrapped row would push the cards off the stage.
  const budget = height - PAD * 2 - H.self - H.resource - MIN_GAP * 2 + STACK;
  const maxRows = Math.max(1, Math.min(4, Math.floor(budget / (H.backend + STACK))));
  const bPlan = grid(inner, backends.length, CELL.backend, maxRows);
  const rPlan = grid(inner, resources.length, CELL.resource, 2);
  const Y = tiers(height, Math.max(1, bPlan.sizes.length), Math.max(1, rPlan.sizes.length));

  // Tier 0. Self anchors the left; peers fill from the right so the gap between
  // them is the visual span of the link, and one peer sits opposite us.
  const selfW = Math.min(240, Math.max(190, inner * 0.24));
  nodes.set("self", { id: "self", kind: "self", x: PAD, y: Y.self, w: selfW, h: H.self });
  if (peers.length) {
    // What is left after self has taken its side. Without this a fourth peer
    // pushed the row off the left edge and drew ON TOP of us, which reads as a
    // peer that IS us — the one thing this row exists to distinguish.
    const room = inner - selfW - GAP;
    const pw = Math.max(
      100,
      Math.min(CELL.peer.max, Math.max(CELL.peer.min, (room - (peers.length - 1) * GAP) / peers.length)),
    );
    const span = Math.min(room, peers.length * pw + (peers.length - 1) * GAP);
    const step = peers.length > 1 ? (span - pw) / (peers.length - 1) : 0;
    const start = PAD + inner - span;
    peers.forEach((p, i) => nodes.set(`peer:${p.name}`, {
      id: `peer:${p.name}`, kind: "peer", x: start + i * step, y: Y.self, w: pw, h: H.peer,
    }));
  }

  // Tier 1. Backends, over as many rows as it takes to keep a name readable.
  //
  // Filled DOWN each column before moving right, which matters as soon as there
  // is more than one row. `orderBackends` has already put backends that share a
  // card next to each other in the list; filling across would then wrap that
  // run back to the left edge on the next row, and its wires would have to
  // cross the whole stage to reach a card sitting under where the run started.
  // Filling down keeps neighbours in the list neighbours on the stage, which is
  // the only thing the ordering was for.
  {
    const cols = Math.max(...bPlan.sizes);
    // A column is as deep as the number of rows long enough to reach it, so a
    // short last row leaves the right-hand columns one shallower rather than
    // leaving a hole in the middle of the grid.
    const depth = (c: number): number => bPlan.sizes.filter((n) => n > c).length;
    let i = 0;
    for (let c = 0; c < cols; c++) {
      for (let row = 0; row < depth(c); row++, i++) {
        const b = backends[i];
        if (!b) break;
        const count = bPlan.sizes[row]!;
        const span = count * bPlan.w + (count - 1) * GAP;
        const start = PAD + Math.max(0, (inner - span) / 2);
        nodes.set(`backend:${b.name}`, {
          id: `backend:${b.name}`, kind: "backend",
          x: start + c * (bPlan.w + GAP),
          y: Y.backends + row * (H.backend + STACK),
          w: bPlan.w, h: H.backend,
        });
      }
    }
  }

  // Tier 2. A card sits under the backends that declare it, then siblings are
  // pushed apart — two cards drawn on top of each other is worse than two cards
  // slightly away from the backends they belong to, because the edges still say
  // which is which. Cards wrap on the same rule as backends; the packing then
  // runs per row, so a card is only pushed off its own backends by a card it
  // actually shares the row with.
  {
    const rw = rPlan.w;
    const wanted = resources.map((r) => {
      const members = r.backends
        .map((b) => nodes.get(`backend:${b}`))
        .filter((p): p is Placed => !!p);
      const mid = members.length
        ? members.reduce((s, p) => s + p.x + p.w / 2, 0) / members.length
        : PAD + inner / 2;
      return { r, x: mid - rw / 2 };
    }).sort((a, b) => a.x - b.x);

    let i = 0;
    rPlan.sizes.forEach((count, row) => {
      // Pack in order at the position each card wants...
      const placed: { r: Resource; x: number }[] = [];
      let cursor = PAD;
      for (let c = 0; c < count; c++, i++) {
        const w = wanted[i];
        if (!w) break;
        const x = Math.max(cursor, Math.min(w.x, PAD + inner - rw));
        placed.push({ r: w.r, x });
        cursor = x + rw + GAP;
      }
      // ...then stretch the row to the full width, keeping the order and the
      // spacing's proportions. Cards follow the backends above them, and those
      // cluster: six sidecars sharing one CPU drag it to their average, which
      // put every card in the left third and left half the stage empty. The
      // edges are what say which card belongs to which backend — position only
      // has to agree with them about the ORDER.
      if (placed.length > 1) {
        const first = placed[0]!.x;
        const last = placed[placed.length - 1]!.x;
        const used = last - first;
        const room = inner - rw;
        if (used > 0 && used < room) {
          const scale = room / used;
          for (const p of placed) p.x = PAD + (p.x - first) * scale;
        }
      } else if (placed.length === 1) {
        placed[0]!.x = PAD + (inner - rw) / 2;
      }
      for (const p of placed) {
        nodes.set(`resource:${p.r.name}`, {
          id: `resource:${p.r.name}`, kind: "resource",
          x: p.x, y: Y.resources + row * (H.resource + STACK), w: rw, h: H.resource,
        });
      }
    });
  }

  const edges: Edge[] = [];
  const push = (from: string, to: string, dir: "across" | "down", lift = 0) => {
    const a = nodes.get(from), b = nodes.get(to);
    if (!a || !b) return;
    const { d, mid } = curve(a, b, dir, lift);
    edges.push({ id: `${from}>${to}`, from, to, dir, d, mid });
  };
  // Two arcs per peer, bowed opposite ways: what we send them, and what they
  // send us. They are separate facts and one line cannot hold both.
  for (const p of peers) {
    push("self", `peer:${p.name}`, "across", -14);
    push(`peer:${p.name}`, "self", "across", 14);
  }
  for (const b of backends) push("self", `backend:${b.name}`, "down");
  for (const r of resources) {
    // The host's line is drawn to the CARD, not to the backend. A backend
    // "using" the host is a fact about a process; a model split across a
    // card and the host is a fact about the hardware, and it is the second
    // one that explains the speed — the two halves exchange on every token.
    // The chain still reads end to end: backend, its card, and the other half.
    if (r.host) continue;
    for (const b of r.backends) push(`backend:${b}`, `resource:${r.name}`, "down");
  }
  const host = resources.find((r) => r.host);
  if (host) {
    for (const card of host.host!.cards) {
      push(`resource:${card}`, `resource:${host.name}`, "across");
    }
  }

  // Fill the stage when the content is shorter than it, so there is no strip of
  // dead page under the cards; grow past it only when even the tight layout
  // does not fit, which is the one case worth a scrollbar.
  return { nodes, edges, width, height: Math.max(height, Y.needed) };
}

/* -------------------------------------------------------- crossings */

/**
 * How many pairs of backend->card edges cross.
 *
 * Counted on the straight line between the two endpoints rather than on the
 * drawn curve. The curves are monotone in y and bow only slightly, so two that
 * do not cross as segments do not cross as curves either — and the point of
 * this number is to compare one ORDERING against another, not to be a pixel
 * measurement.
 *
 * Only the backend tier's downward edges are counted. The fan from self to the
 * backends leaves one point and converges nowhere, so it cannot self-cross, and
 * peer arcs are drawn deliberately bowed apart.
 */
export function countCrossings(scene: Scene): number {
  const segs = scene.edges
    .filter((e) => e.from.startsWith("backend:") && e.to.startsWith("resource:"))
    .map((e) => {
      const a = scene.nodes.get(e.from)!;
      const b = scene.nodes.get(e.to)!;
      return { x1: a.x + a.w / 2, y1: a.y + a.h, x2: b.x + b.w / 2, y2: b.y };
    });

  let n = 0;
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const p = segs[i]!, q = segs[j]!;
      // Edges into the same card converge on one point; they meet there by
      // construction rather than crossing, and counting that would punish
      // exactly the grouping this is meant to reward.
      if (p.x2 === q.x2 && p.y2 === q.y2) continue;
      if (segmentsCross(p, q)) n++;
    }
  }
  return n;
}

interface Seg { x1: number; y1: number; x2: number; y2: number }

const side = (s: Seg, x: number, y: number): number =>
  Math.sign((s.x2 - s.x1) * (y - s.y1) - (s.y2 - s.y1) * (x - s.x1));

function segmentsCross(p: Seg, q: Seg): boolean {
  const a = side(p, q.x1, q.y1), b = side(p, q.x2, q.y2);
  const c = side(q, p.x1, p.y1), d = side(q, p.x2, p.y2);
  return a !== b && c !== d && a !== 0 && b !== 0 && c !== 0 && d !== 0;
}
