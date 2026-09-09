/**
 * A backend can declare an `activity:` path — where it reports its OWN busy
 * state — so a backend hearth forwards to but does not schedule (ComfyUI's
 * `/queue`) can light while it works instead of drawing idle through a whole
 * render.
 *
 * The reading is where the care is: a field is an array (its length) or a number
 * (itself), and everything else — a missing field, a wrong type, an unreachable
 * backend, a timeout — is "cannot tell", never a confident zero. Only a field
 * that read as a real count is `ok`, so the page can draw unknown apart from
 * idle.
 *
 *     npx tsx test/activity.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { BackendState } from "../src/backend.js";
import { parseConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";

// --- config: parsing, defaults, and the path rule it shares with routes: ----
{
  const cfg = parseConfig({
    name: "t",
    backends: [{
      name: "comfy", url: "http://127.0.0.1:1", kind: "none",
      activity: { path: "/queue", running: "queue_running", queued: "queue_pending" },
    }],
  });
  assert.deepEqual(cfg.backends[0]!.activity,
    { path: "/queue", running: "queue_running", queued: "queue_pending" },
    "the block parses whole");

  // queued is optional; a backend with one queue just names running.
  const one = parseConfig({
    name: "t",
    backends: [{ name: "c", url: "http://127.0.0.1:1", kind: "none",
      activity: { path: "/q", running: "n" } }],
  });
  assert.equal(one.backends[0]!.activity?.queued, null, "queued defaults to null");

  // A backend that speaks /v1 declares no activity, and that is the common case.
  const none = parseConfig({ name: "t", backend: { url: "http://127.0.0.1:1", kind: "none" } });
  assert.equal(none.backends[0]!.activity, null, "absent means null, not a throw");
}

const bad = (activity: unknown, re: RegExp, why: string) =>
  assert.throws(() => parseConfig({
    name: "t",
    backends: [{ name: "c", url: "http://127.0.0.1:1", kind: "none", activity }],
  }), re, why);

// The path rule is routeList's, reused — same errors, so the two cannot drift.
bad({ path: "queue", running: "n" }, /path must start with "\/"/, "a path must be absolute");
bad({ path: "/q?a=1", running: "n" }, /must not include a query string/, "no query string");
bad({ path: "/q" }, /running is required/, "an activity block with nothing to read is a no-op");

// --- reading: array -> length, number -> value, everything else unknown -----

let body: unknown = {};
const be = createServer((req, res) => {
  if (req.url === "/boom") { res.writeHead(500); res.end("no"); return; }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
});
await new Promise<void>((r) => be.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(be.address() as AddressInfo).port}`;

// Fresh state each time so the rate-limit never skips the read under test.
const read = async (b: unknown, running: string, queued: string | null = null) => {
  body = b;
  const st = new BackendState(url, "none", silentLogger);
  await st.sampleActivity({ path: "/queue", running, queued });
  return st.activity();
};

assert.deepEqual(
  await read({ queue_running: [1, 2, 3], queue_pending: [1] }, "queue_running", "queue_pending"),
  { running: 3, queued: 1, ok: true },
  "an array field is read as its length",
);
assert.deepEqual(
  await read({ exec_info: { queue_remaining: 2 } }, "exec_info.queue_remaining"),
  { running: 2, ok: true },
  "a number field is read as itself, down a dotted path",
);
assert.deepEqual(
  await read({ queue_running: [], queue_pending: [] }, "queue_running", "queue_pending"),
  { running: 0, queued: 0, ok: true },
  "a confirmed empty queue is idle — ok, not unknown",
);
assert.deepEqual(
  await read({ nope: [] }, "queue_running"),
  { running: 0, ok: false },
  "a missing field is unknown, never a confident zero",
);
assert.deepEqual(
  await read({ queue_running: "busy" }, "queue_running"),
  { running: 0, ok: false },
  "a field that is not a count is unknown",
);

// A poll that throws — a 500, or an unreachable backend — is unknown, not idle.
{
  const st = new BackendState(url, "none", silentLogger);
  await st.sampleActivity({ path: "/boom", running: "queue_running", queued: null });
  assert.deepEqual(st.activity(), { running: 0, ok: false }, "a 5xx is unknown");
}
{
  const st = new BackendState("http://127.0.0.1:1", "none", silentLogger);
  await st.sampleActivity({ path: "/queue", running: "queue_running", queued: null });
  assert.deepEqual(st.activity(), { running: 0, ok: false }, "an unreachable backend is unknown");
}

// Before the first read has come back, "cannot tell" — not idle.
assert.deepEqual(new BackendState(url, "none", silentLogger).activity(),
  { running: 0, ok: false }, "unread is unknown");

await new Promise<void>((r) => be.close(() => r()));
console.log("activity.test.ts ok");
