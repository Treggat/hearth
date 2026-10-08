/**
 * The `canary:` block: off unless asked for, and loud when it is wrong.
 *
 * This is a heartbeat that talks to a model on its own schedule, so it is opt-in
 * twice over — the block itself, and `passive:` for watching real traffic. What
 * it must not do is fail quietly: a bad `expect:` regex would only show up
 * thirty seconds after startup, inside a probe nobody is watching, which is how
 * a broken canary protects nothing.
 *
 *   npx tsx test/canary-config.test.ts
 */
import assert from "node:assert/strict";

import { parseV1 } from "./v1.js";

/** The smallest config that loads, with the canary block under test spliced in. */
const withCanary = (canary: unknown): Record<string, unknown> => ({
  name: "c",
  backends: [{ name: "cardb", url: "http://127.0.0.1:9999", kind: "llama-swap", serves: ["gpt-oss", "gpu2"] }],
  canary,
});

// --- absent means off ------------------------------------------------------
{
  const cfg = parseV1({
    name: "c",
    backends: [{ name: "cardb", url: "http://127.0.0.1:9999", kind: "llama-swap" }],
  });
  assert.equal(cfg.canary, null, "no canary block means no canary, and no probes");
}

// --- the defaults ----------------------------------------------------------
{
  const cfg = parseV1(withCanary({ models: { "gpu2": {} } }));
  assert.ok(cfg.canary, "a canary block with a model is a canary");
  const d = cfg.canary!.defaults;
  assert.equal(d.expect, "Paris", "the default question is the one from the incident");
  assert.equal(d.failureThreshold, 2, "two consecutive fails, so one blip is not an outage");
  assert.equal(d.recoverAfter, 1, "one clean answer brings it back");
  assert.equal(cfg.canary!.passive, false, "watching real traffic is opt-in on its own");
  assert.equal(cfg.canary!.notify, null, "no webhook unless one is named");
  assert.equal(cfg.canary!.recovery, null, "recovery is off unless asked for");
  assert.deepEqual(Object.keys(cfg.canary!.models), ["gpu2"]);
  assert.ok(d.prompt.length > 0, "a default prompt exists");
  assert.ok(d.maxTokens >= 1 && d.timeoutMs > 0 && d.intervalMs > 0);
}

// --- per-model overrides ---------------------------------------------------
// gpt-oss is a reasoning model: it needs more room than the default, and the
// override must apply to it alone.
{
  const cfg = parseV1(withCanary({
    maxTokens: 64,
    models: { "gpt-oss": { maxTokens: 1024 }, "gpu2": {} },
  }));
  assert.equal(cfg.canary!.models["gpt-oss"]!.maxTokens, 1024);
  assert.equal(cfg.canary!.models["gpu2"]!.maxTokens, undefined, "an override is not inherited by its neighbours");
  assert.equal(cfg.canary!.defaults.maxTokens, 64, "and the default stays what it was");
}

// --- a whole backend at once ------------------------------------------------
{
  const cfg = parseV1(withCanary({ backends: { cardb: { intervalMs: 5_000 } } }));
  assert.deepEqual(Object.keys(cfg.canary!.backends), ["cardb"]);
  assert.equal(cfg.canary!.backends["cardb"]!.intervalMs, 5_000);
}

// --- a backend nobody declared ---------------------------------------------
// A typo here would silently probe nothing, which is the worst outcome.
{
  assert.throws(
    () => parseV1(withCanary({ backends: { cardbb: {} } })),
    /canary\.backends\.cardbb/,
    "an unknown backend name must be refused",
  );
}

// --- naming nothing ---------------------------------------------------------
{
  assert.throws(
    () => parseV1(withCanary({ passive: true })),
    /canary/,
    "a canary that asks no model is a config mistake, not a no-op",
  );
}

// --- an expect that will not compile ---------------------------------------
{
  assert.throws(
    () => parseV1(withCanary({ expect: "Par(is", models: { "gpu2": {} } })),
    /canary\.expect/,
    "a bad regex must fail at --check, not inside a probe",
  );
}

// --- numbers are numbers ---------------------------------------------------
{
  assert.throws(
    () => parseV1(withCanary({ maxTokens: "lots", models: { "gpu2": {} } })),
    /canary\.maxTokens/,
  );
  assert.throws(
    () => parseV1(withCanary({ failureThreshold: 0, models: { "gpu2": {} } })),
    /canary\.failureThreshold/,
    "a threshold of zero would degrade on the first reading",
  );
}

// --- the notification hook --------------------------------------------------
{
  process.env.HEARTH_TEST_KEY = "sekrit";
  try {
    const cfg = parseV1(withCanary({
      models: { "gpu2": {} },
      notify: {
        url: "http://192.168.1.3:9876/api/notifications",
        headers: { "x-api-key": "env:HEARTH_TEST_KEY" },
      },
    }));
    const n = cfg.canary!.notify!;
    assert.equal(n.url, "http://192.168.1.3:9876/api/notifications");
    assert.equal(n.headers["x-api-key"], "sekrit", "env: indirection keeps the key out of the file");
    assert.ok(n.timeoutMs > 0, "a hook that hangs must not hang the canary");
  } finally {
    delete process.env.HEARTH_TEST_KEY;
  }
  assert.throws(
    () => parseV1(withCanary({ models: { "gpu2": {} }, notify: { url: "" } })),
    /canary\.notify\.url/,
  );
}

// --- gentle recovery --------------------------------------------------------
// The block IS the flag: naming it turns it on, and `unload: false` is how you
// say "tell me, but do not touch the seat".
{
  const on = parseV1(withCanary({ models: { "gpu2": {} }, recovery: {} }));
  assert.equal(on.canary!.recovery!.unload, true, "declaring recovery: enables it");
  assert.ok(on.canary!.recovery!.cooldownMs > 0, "and it comes with a cooldown");

  const off = parseV1(withCanary({ models: { "gpu2": {} }, recovery: { unload: false } }));
  assert.equal(off.canary!.recovery!.unload, false);

  const timed = parseV1(withCanary({ models: { "gpu2": {} }, recovery: { cooldownMs: 60_000 } }));
  assert.equal(timed.canary!.recovery!.cooldownMs, 60_000);

  assert.throws(
    () => parseV1(withCanary({ models: { "gpu2": {} }, recovery: { cooldownMs: 0 } })),
    /canary\.recovery\.cooldownMs/,
    "a zero cooldown would unload the seat on every tick",
  );
}

// --- passive is opt-in ------------------------------------------------------
{
  const cfg = parseV1(withCanary({ models: { "gpu2": {} }, passive: true }));
  assert.equal(cfg.canary!.passive, true);
}

console.log("canary-config.test.ts ok");
