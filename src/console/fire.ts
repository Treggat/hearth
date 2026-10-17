/**
 * The node's load as a fire: how brightly the coals glow under the smoke and
 * how many embers rise off them. Idle is banked, not out; a full queue is a
 * full fire. Pure, so the mapping can be tested without a browser.
 */

/** `load` is 0 for idle to 1 for a full queue; anything else reads as the nearest end. */
export function fire(load: number): { heat: number; embers: number } {
  const l = Number.isFinite(load) ? Math.max(0, Math.min(1, load)) : 0;
  // The coals never go out, and embers stay rare until there is work.
  return { heat: 0.1 + 0.9 * l, embers: 0.02 + 0.38 * l * l };
}

/** A node's own fire: four numbers in [0, 1) from its name, the same every time it is drawn. */
export function seedOf(name: string): [number, number, number, number] {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619) >>> 0;
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let k = 0; k < 4; k++) {
    h = (h ^ (h << 13)) >>> 0;
    h = (h ^ (h >>> 17)) >>> 0;
    h = (h ^ (h << 5)) >>> 0;
    out[k] = h / 4294967296;
  }
  return out;
}
