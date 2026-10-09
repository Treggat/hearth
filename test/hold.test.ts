/**
 * A backend can `hold:` its hardware for an app hearth forwards to but does not schedule. While
 * the app is in use (read off its `activity:` path) the named lanes of every backend sharing
 * that hardware stay queued, or run as `models.<id>.whenHeld`; other lanes take the card as
 * before. The hold ends once the app has been idle for `idleMs`, or stops answering.
 *
 *     npx tsx test/hold.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { silentLogger } from "../src/log.js";
import { BackendPool } from "../src/pool.js";
import { createNode } from "../src/server.js";
import { Scheduler } from "../src/scheduler.js";
import { parseV1 } from "./v1.js";

const settle = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));

/** An app with a queue endpoint, whose running count the test sets. */
function fakeApp() {
  const state = { running: 0 };
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ running: state.running, queued: 0 }));
  });
  return {
    state,
    listen: () => new Promise<string>((ready) =>
      server.listen(0, "127.0.0.1", () => ready(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))),
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

const config = (appUrl: string, idleMs: number, extra: Record<string, unknown> = {}) => parseV1({
  name: "hold",
  resources: { gpu: { kind: "gpu" }, cpu: { kind: "cpu", shared: true } },
  scheduler: { lanes: { chat: { priority: 0 }, memory: { priority: 90 } } },
  backends: [
    { name: "card", url: "http://127.0.0.1:1", kind: "none", serves: ["main"], resources: ["gpu"] },
    {
      name: "app", url: appUrl, kind: "none", resources: ["gpu"],
      activity: { path: "/queue", running: "running", queued: "queued" },
      hold: { lanes: ["memory"], idleMs },
      ...extra,
    },
    { name: "spare", url: "http://127.0.0.1:1", kind: "none", serves: ["small"], resources: ["cpu"] },
  ],
  models: {
    background: { backend: "card", as: "main", lane: "memory", whenHeld: "elsewhere" },
    waits: { backend: "card", as: "main", lane: "memory" },
    elsewhere: { backend: "spare", as: "small" },
  },
});

// --- config ----------------------------------------------------------------
{
  const cfg = config("http://127.0.0.1:1", 60_000);
  assert.deepEqual(cfg.backends[1]!.hold, { lanes: ["memory"], idleMs: 60_000 }, "the block parses whole");
  assert.equal(cfg.backends[0]!.hold, null, "absent means null");
  assert.equal(cfg.models["background"]!.whenHeld, "elsewhere");
  assert.equal(cfg.models["waits"]!.whenHeld, null, "a model without one waits");

  const app = (over: Record<string, unknown>) => () => parseV1({
    name: "t",
    resources: { gpu: { kind: "gpu" }, cpu: { kind: "cpu", shared: true } },
    backends: [{
      name: "app", url: "http://127.0.0.1:1", kind: "none", resources: ["gpu"],
      activity: { path: "/queue", running: "running" }, hold: { lanes: ["chat"], idleMs: 1000 }, ...over,
    }],
  });
  assert.doesNotThrow(app({}));
  assert.throws(app({ activity: undefined }), /hold needs backends\.app\.activity/, "nothing to read the hold off");
  assert.throws(app({ resources: ["cpu"] }), /needs an exclusive resource/, "shared hardware is never held");
  assert.throws(app({ hold: { lanes: ["nope"], idleMs: 1000 } }), /"nope", which is not in scheduler\.lanes/, "a lane that does not exist");
  assert.throws(app({ hold: { lanes: [], idleMs: 1000 } }), /at least one lane/, "a hold on no lane holds nothing");
  assert.throws(app({ hold: { lanes: ["chat"] } }), /idleMs is required/, "no default for how long idle is idle");

  const model = (whenHeld: string, more: Record<string, unknown> = {}) => () => parseV1({
    name: "t",
    backend: { url: "http://127.0.0.1:1", kind: "none" },
    models: { a: { as: "x", whenHeld }, b: { as: "y", ...more } },
  });
  assert.doesNotThrow(model("b"));
  assert.throws(model("a"), /not another id under models/, "an id cannot stand in for itself");
  assert.throws(model("missing"), /not another id under models/, "the stand-in must be declared");
  assert.throws(model("b", { whenHeld: "a" }), /has a whenHeld of its own/, "no chains");
}

// --- scheduler: a held lane waits without holding up the others -------------
{
  let held = true;
  const s = new Scheduler({
    lanes: { chat: { priority: 0 }, memory: { priority: 90 } },
    concurrency: 4,
    // Aged far past the chat lane, so the held job sits at the head of the queue.
    agePerSecond: 100_000,
    heldOff: (lane) => held && lane === "memory",
  });
  const log: string[] = [];
  const job = (lane: string, name: string) => s.submit({ lane, model: "seat", caller: name }, async () => { log.push(name); });

  const background = job("memory", "background");
  await settle(20);
  const chat = job("chat", "chat");
  await chat;
  assert.deepEqual(log, ["chat"], "the lane that is not held starts past the held job at the head of the queue");
  assert.equal(s.capacity().queued["memory"], 1, "the held job is still queued, not refused");

  held = false;
  s.kick();
  await background;
  assert.deepEqual(log, ["chat", "background"], "once the hold ends, a kick starts it");
}

// --- pool: the hold follows the app's own busy signal -----------------------
{
  const app = fakeApp();
  const url = await app.listen();
  const cfg = config(url, 150);
  const pool = new BackendPool(cfg, silentLogger);
  const [card, holder] = [pool.get("card")!, pool.get("app")!];
  const read = () => holder.state.sampleActivity(holder.cfg.activity!);

  assert.equal(pool.heldOff(card.cfg, "memory"), false, "an app nobody has heard from holds nothing");
  assert.equal(pool.whenHeld("background", "memory"), null);

  await read();
  assert.equal(pool.heldOff(card.cfg, "memory"), true, "coming up counts as use: the first job is still ahead of it");
  assert.equal(pool.heldOff(card.cfg, "chat"), false, "only the lanes it names");
  assert.equal(pool.heldOff(pool.get("spare")!.cfg, "memory"), false, "only backends on its hardware");
  assert.equal(pool.heldOff(holder.cfg, "memory"), false, "never the holder itself");
  assert.equal(pool.whenHeld("background", "memory"), "elsewhere", "a model that names a stand-in runs as it");
  assert.equal(pool.whenHeld("waits", "memory"), null, "one that names none stays queued as itself");
  assert.equal(pool.whenHeld("background", "chat"), null, "and only in a held lane");
  const [view] = pool.holds();
  assert.deepEqual({ backend: view!.backend, resources: view!.resources, lanes: view!.lanes, active: view!.active },
    { backend: "app", resources: ["gpu"], lanes: ["memory"], active: true });
  assert.ok(view!.quietMs !== null && view!.quietMs < 150);

  await settle(200);
  assert.equal(pool.heldOff(card.cfg, "memory"), false, "idle for idleMs: the lanes may start again");
  assert.equal(pool.whenHeld("background", "memory"), null);
  assert.equal(pool.holds()[0]!.active, false);

  // A job showing up renews it. The path is read at most every two seconds.
  app.state.running = 1;
  await settle(2_100);
  await read();
  assert.equal(pool.heldOff(card.cfg, "memory"), true, "work on the app takes the card back for its lanes");

  app.close();
  pool.stop();
}

// --- end to end: a held request is answered by its stand-in ------------------
{
  /** A chat server that says which one it is and which id it was asked for. */
  const fakeChat = (name: string) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const asked = body ? (JSON.parse(body) as { model?: string }).model : undefined;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ model: asked, choices: [{ message: { role: "assistant", content: name } }] }));
      });
    });
    return {
      listen: () => new Promise<string>((ready) =>
        server.listen(0, "127.0.0.1", () => ready(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))),
      close: () => { server.closeAllConnections(); server.close(); },
    };
  };
  const [app, card, spare] = [fakeApp(), fakeChat("card"), fakeChat("spare")];
  const [appUrl, cardUrl, spareUrl] = [await app.listen(), await card.listen(), await spare.listen()];
  const cfg = config(appUrl, 60_000);
  cfg.backends[0]!.url = cardUrl;
  cfg.backends[2]!.url = spareUrl;
  const node = createNode(cfg, silentLogger);
  const url = await new Promise<string>((ready) =>
    node.server.listen(0, "127.0.0.1", () => ready(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}`)));
  const ask = async (model: string) => {
    const r = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
    });
    return { status: r.status, body: (await r.json()) as { model?: string; choices?: { message: { content: string } }[] } };
  };

  const before = await ask("background");
  assert.equal(before.body.choices?.[0]?.message.content, "card", "no hold: the request runs on its own backend");
  assert.equal(before.body.model, "main");

  // start() begins reading the app, whose first answer starts the hold.
  node.start();
  for (let i = 0; i < 100 && !node.pool.heldOff(node.pool.get("card")!.cfg, "memory"); i++) await settle(20);
  const during = await ask("background");
  assert.equal(during.body.choices?.[0]?.message.content, "spare", "held: the same id is answered by its stand-in");
  assert.equal(during.body.model, "small", "under the id the stand-in goes out as");

  const net = (await (await fetch(`${url}/network`)).json()) as { holds?: { backend: string; active: boolean }[] };
  assert.deepEqual(net.holds?.map((h) => [h.backend, h.active]), [["app", true]], "/network says who holds what");

  await node.close();
  for (const f of [app, card, spare]) f.close();
}

console.log("hold: ok");
