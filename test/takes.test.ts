/**
 * Self-check for the capability chips under a model's name.
 *
 * Two views draw them — the models table and the inspect panel — and each had
 * its own copy of the list, which is how one word came to cover two facts on
 * both. The list lives in one place now, and this pins what it says.
 *
 *     npx tsx test/takes.test.ts
 */
import assert from "node:assert/strict";

import { capabilityChips, capabilityGaps } from "../src/ui/takes.js";

// "thinking" is the model reasoning; "effort" is a dial you can turn. A model
// can have the first without the second, and the page has to be able to say so.
assert.deepEqual(capabilityChips({ thinking: true, effort: true }), ["thinking", "effort"]);
assert.deepEqual(capabilityChips({ thinking: true, effort: false }), ["thinking"], "reasons, no dial");
assert.deepEqual(capabilityChips({ thinking: true }), ["thinking"], "and an unknown dial draws nothing");

// Order is the order they are read in: what you can send, then how it answers.
assert.deepEqual(
  capabilityChips({ context: 131072, vision: true, tools: true, thinking: true, effort: true, quant: "Q4_K" }),
  ["vision", "tools", "thinking", "effort"],
);

// A chip is a claim somebody made. Unknown and "no" both draw nothing here...
assert.deepEqual(capabilityChips({}), []);
assert.deepEqual(capabilityChips({ vision: false, tools: false, thinking: false, effort: false }), []);

// ...and the difference between them is what the tooltip is for: only a
// reported "no" is worth a sentence.
assert.deepEqual(capabilityGaps({}), [], "silence is not a gap");
assert.deepEqual(
  capabilityGaps({ vision: false, tools: false, thinking: false, effort: false }),
  ["text only, no images", "no tool calls", "does not think", "no effort levels"],
);
assert.deepEqual(capabilityGaps({ thinking: true, effort: false }), ["no effort levels"]);

console.log("takes ok");
