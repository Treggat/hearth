/**
 * The minute a model spends coming off the disk.
 *
 * Measured on the live box: a 32k-context model took **47.8 seconds** to load.
 * For all of it the console said `nothing loaded` and drew a running job — both
 * true, and between them they explain nothing. The question you actually have
 * while looking at it is "is this stuck, or is it reading a file", and the page
 * could not answer it.
 *
 * llama-swap had been saying so the whole time. Every event frame carries a
 * state per model, and `apply()` kept `ready` and dropped the rest:
 *
 *     "state":"starting"    <- this
 *     "state":"ready"
 *     "state":"stopped"
 *
 *     npx tsx test/loading.test.ts
 */
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { parseConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { createNode } from "../src/server.js";

interface UiBackend { name: string; loaded?: string[]; loading?: string[] }

const frame = (models: { id: string; state: string }[]) =>
  `data: ${JSON.stringify({ type: "modelStatus", data: JSON.stringify(models) })}\n\n`;

/** A llama-swap whose model state the test drives. */
const swap = () => {
  let live: ServerResponse | null = null;
  const s = createServer((req, res) => {
    if (req.url === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(frame([{ id: "big", state: "stopped" }]));
      live = res;
      return;
    }
    res.writeHead(404); res.end();
  });
  return { s, say: (models: { id: string; state: string }[]) => live?.write(frame(models)) };
};

const { s, say } = swap();
await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
const node = createNode(
  parseConfig({
    name: "load",
    resources: { gpu: { kind: "gpu" } },
    backends: [{
      name: "swap", url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
      kind: "llama-swap", resources: ["gpu"],
    }],
  }),
  silentLogger,
);
node.start();
const base = await new Promise<string>((ready) =>
  node.server.listen(0, "127.0.0.1", () =>
    ready(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}`)),
);

const backend = async (): Promise<UiBackend> => {
  const d = (await (await fetch(`${base}/ui/data`)).json()) as {
    net: { nodes: { self?: boolean; backends?: UiBackend[] }[] };
  };
  return d.net.nodes.find((n) => n.self)!.backends!.find((b) => b.name === "swap")!;
};
const until = async (want: (b: UiBackend) => boolean, ms = 4_000) => {
  const t0 = Date.now();
  for (;;) {
    const b = await backend();
    if (want(b) || Date.now() - t0 > ms) return b;
    await new Promise((r) => setTimeout(r, 25));
  }
};

// --- nothing loading, nothing claimed --------------------------------------
{
  const b = await until((x) => x.loading !== undefined);
  assert.deepEqual(b.loading, [], "a backend with nothing starting says so with an empty list");
  assert.deepEqual(b.loaded, [], "and nothing is loaded either");
}

// --- the load is visible while it happens ----------------------------------
// The whole point. This is the state the page had no way to draw.
{
  say([{ id: "big", state: "starting" }]);
  const b = await until((x) => (x.loading ?? []).length > 0);
  assert.deepEqual(b.loading, ["big"], "the model coming off the disk is named");
  assert.deepEqual(b.loaded, [], "and it is NOT loaded yet — that is the distinction");
}

// --- and stops being visible when it lands ---------------------------------
{
  say([{ id: "big", state: "ready" }]);
  const b = await until((x) => (x.loaded ?? []).length > 0);
  assert.deepEqual(b.loaded, ["big"], "loaded once llama-swap says ready");
  assert.deepEqual(b.loading, [], "and no longer loading — a stuck spinner is its own bug");
}

// --- unloading is not loading ----------------------------------------------
// `stopped` is the state of every model llama-swap knows about and is not
// running, which is most of them. Counting those as loading would light the
// whole row up permanently.
{
  say([{ id: "big", state: "stopped" }, { id: "other", state: "stopped" }]);
  const b = await until((x) => (x.loaded ?? []).length === 0);
  assert.deepEqual(b.loading, [], "a stopped model is not a loading one");
}

await node.close();
s.closeAllConnections();
s.close();
console.log("loading.test.ts ok");
