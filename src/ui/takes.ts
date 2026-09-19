/** The capability chips drawn under a model's name; shared by the models table and the inspect panel. */
import type { ModelStats } from "./types.js";

/** Only a reported `true` draws a chip; a "no" is said in capabilityGaps(). */
export function capabilityChips(st: ModelStats): string[] {
  return [
    st.vision === true ? "vision" : null,
    st.tools === true ? "tools" : null,
    st.thinking === true ? "thinking" : null,
    st.effort === true ? "effort" : null,
  ].filter((c): c is string => c !== null);
}

/** What a model has said it cannot do. Silence is not a gap. */
export function capabilityGaps(st: ModelStats): string[] {
  return [
    st.vision === false ? "text only, no images" : null,
    st.tools === false ? "no tool calls" : null,
    st.thinking === false ? "does not think" : null,
    st.effort === false ? "no effort levels" : null,
  ].filter((g): g is string => g !== null);
}
