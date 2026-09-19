/**
 * What a model can take, as the words drawn under its name.
 *
 * Pure, and in one place, because two views draw this list — the models table
 * and the inspect panel — and each having its own copy is how one word came to
 * cover two facts on both.
 */
import type { ModelStats } from "./types.js";

/**
 * The capability chips a model has earned, in the order they are read: what you
 * can send it, then how it answers.
 *
 * `thinking` is the model reasoning before it answers. `effort` is a dial —
 * its template takes a `reasoning_effort`. Two chips because they are two
 * facts: plenty of models reason with nothing to turn, and a chip that said
 * "thinking" for the dial left those models looking like they do not think.
 *
 * Only a reported `true` draws anything. Unknown and "no" look the same here on
 * purpose; capabilityGaps() is where a "no" gets said.
 */
export function capabilityChips(st: ModelStats): string[] {
  return [
    st.vision === true ? "vision" : null,
    st.tools === true ? "tools" : null,
    st.thinking === true ? "thinking" : null,
    st.effort === true ? "effort" : null,
  ].filter((c): c is string => c !== null);
}

/** What a model has SAID it cannot do, for the tooltip. Silence is not a gap. */
export function capabilityGaps(st: ModelStats): string[] {
  return [
    st.vision === false ? "text only, no images" : null,
    st.tools === false ? "no tool calls" : null,
    st.thinking === false ? "does not think" : null,
    st.effort === false ? "no effort levels" : null,
  ].filter((g): g is string => g !== null);
}
