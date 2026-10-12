/**
 * A backend named under `headroom.backends`. The failures worth catching:
 *
 *   - a request that fails, or waits, because the compressor is down, slow or wrong
 *   - the backend's key, or a backend that did not ask, reaching the compressor
 *   - two turns of one conversation named differently, so the second is compressed from scratch
 *     and the provider's cached prefix is lost; two conversations named the same
 *   - an answer that is not the conversation that was sent taken as one
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.js";
import { sessionOf } from "../src/headroom.js";
import { silentLogger } from "../src/log.js";
import { createNode } from "../src/server.js";

type Doc = Record<string, unknown>;
const listening = (s: ReturnType<typeof createServer>): Promise<number> => new Promise((r) => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));

// The name of a conversation, on its own.
const opening = [{ role: "system", content: "be brief" }, { role: "user", content: [{ type: "text", text: "hello" }] }];
assert.equal(sessionOf("app", "m", opening), sessionOf("app", "m", [...opening, { role: "assistant", content: "hi" }, { role: "user", content: "more" }]), "a conversation keeps its name as it grows");
assert.notEqual(sessionOf("app", "m", opening), sessionOf("other", "m", opening), "two callers who open alike are two conversations");
assert.notEqual(sessionOf("app", "m", opening), sessionOf("app", "m", [opening[0], { role: "user", content: "goodbye" }]));
assert.equal(sessionOf("app", "m", [{ role: "system", content: "be brief" }]), "", "nothing said yet is no conversation");

// What the compressor does next: answer as Headroom does, or one of the ways it can go wrong.
let mode: "ok" | "down" | "short" | "slow" = "ok";
const asked: { token: unknown; auth: unknown; key: unknown; body: Doc }[] = [];
const headroom = createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const body = JSON.parse(raw) as { messages: Doc[] };
  asked.push({ token: req.headers["x-headroom-proxy-token"], auth: req.headers.authorization, key: req.headers["x-api-key"], body });
  if (req.url !== "/v1/compress") return void res.writeHead(404).end();
  if (mode === "down") return void res.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "compression_timeout" }));
  if (mode === "slow") return void setTimeout(() => res.end(), 2000);
  const messages = body.messages.map((m) => (m.role === "tool" ? { ...m, content: "[shortened]" } : m));
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ messages: mode === "short" ? messages.slice(1) : messages, tokens_saved: 900 }));
});
const sent: { path: string; body: Doc }[] = [];
const provider = createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  if (req.url === "/v1/models") return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ data: [{ id: "their-model" }] }));
  sent.push({ path: req.url ?? "", body: JSON.parse(raw) as Doc });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(req.url === "/v1/messages"
    ? { id: "msg_1", type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }], usage: { input_tokens: 3, output_tokens: 1 } }
    : { id: "c1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
});
const [hPort, pPort] = [await listening(headroom), await listening(provider)];

const dir = mkdtempSync(join(tmpdir(), "hearth-headroom-"));
const config = (more: string): string => {
  const path = join(dir, "hearth.yaml");
  writeFileSync(path, `name: node-under-test
${more}backends:
  squeezed: {url: "http://127.0.0.1:${pPort}", cloud: true, key: provider-secret, serves: [their-model]}
  native: {url: "http://127.0.0.1:${pPort}", cloud: true, format: anthropic, key: provider-secret, serves: [their-native]}
  plain: {url: "http://127.0.0.1:${pPort}", cloud: true, key: provider-secret, serves: [their-plain]}
models:
  small: {backend: squeezed, as: their-model}
  native: {backend: native, as: their-native}
  plain: {backend: plain, as: their-plain}
flows:
  rest: {inputs: ["*"], steps: [{to: {asked: true}}]}
apiKeys:
  - {key: ours-secret, label: app}
`);
  return path;
};
assert.throws(() => loadConfig(config("headroom: {backends: [nobody]}\n")), /headroom\.backends/, "a name that is no backend is refused when the file is read");
assert.deepEqual(loadConfig(config("")).headroom, { backends: [], url: null, token: null, timeoutMs: 10000 }, "unset, nothing is compressed");
const node = createNode(loadConfig(config(`headroom: {url: "http://127.0.0.1:${hPort}/", token: squeeze-secret, timeoutMs: 300, backends: [squeezed, native]}\n`)), silentLogger);
node.start();
const url = `http://127.0.0.1:${await listening(node.server)}`;
const talk = [
  { role: "system", content: "be brief" },
  { role: "user", content: "read the log" },
  { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "call_1", content: "a very long log" },
];
const chat = async (model: string, messages: Doc[] = talk): Promise<Doc> => {
  const r = await fetch(`${url}/v1/chat/completions`, { method: "POST", headers: { Authorization: "Bearer ours-secret", "Content-Type": "application/json" }, body: JSON.stringify({ model, messages }) });
  assert.equal(r.status, 200, await r.clone().text());
  return sent.at(-1)!.body;
};
const toolOf = (body: Doc): unknown => (body.messages as Doc[]).at(-1)!.content;

try {
  assert.equal(toolOf(await chat("small")), "[shortened]", "the backend is sent what the compressor answered");
  const first = asked.at(-1)!;
  assert.deepEqual([first.token, first.auth, first.key], ["squeeze-secret", undefined, undefined], "the compressor gets its own token and never the backend's key");
  assert.deepEqual([first.body.model, first.body.messages], ["their-model", talk], "it is told the model as the provider names it, and the conversation as it was asked");
  const name = (first.body.config as Doc).session_id;
  await chat("small", [...talk, { role: "assistant", content: "fine" }, { role: "user", content: "and now?" }]);
  assert.equal((asked.at(-1)!.body.config as Doc).session_id, name, "the next turn is the same conversation to it");
  await chat("small", [{ role: "user", content: "something else" }]);
  assert.notEqual((asked.at(-1)!.body.config as Doc).session_id, name);

  // An Anthropic backend: compressed first, rewritten after.
  const native = await chat("native");
  assert.equal(sent.at(-1)!.path, "/v1/messages");
  assert.deepEqual((native.messages as { content: Doc[] }[]).at(-1)!.content[0], { type: "tool_result", tool_use_id: "call_1", content: "[shortened]", cache_control: { type: "ephemeral" } });

  const before = asked.length;
  assert.equal(toolOf(await chat("plain")), "a very long log", "a backend that did not ask is sent what came");
  assert.equal(asked.length, before, "and the compressor never sees it");

  // Whatever is wrong with the compressor, the request goes out whole.
  for (const wrong of ["down", "short", "slow"] as const) {
    mode = wrong;
    const began = Date.now();
    assert.equal(toolOf(await chat("small")), "a very long log", `compressor ${wrong}: the request is sent as it came`);
    assert.ok(Date.now() - began < 1500, `compressor ${wrong}: and does not wait past its limit`);
  }
  mode = "ok";
  assert.equal(toolOf(await chat("small")), "[shortened]", "and compressed again once it answers");

  // Switched on and off from the page, at once and in the file.
  const flip = (on: boolean) => fetch(`${url}/headroom`, { method: "POST", headers: { Authorization: "Bearer ours-secret", "Content-Type": "application/json" }, body: JSON.stringify({ action: "backend", name: "plain", on }) });
  assert.equal((await flip(true)).status, 200);
  assert.equal(toolOf(await chat("plain")), "[shortened]", "a backend switched on is compressed from the next request");
  assert.match(readFileSync(join(dir, "hearth.yaml"), "utf8"), /backends:.*plain/s, "and the file says so");
  assert.equal((await flip(false)).status, 200);
  assert.equal(toolOf(await chat("plain")), "a very long log");
  assert.equal((await fetch(`${url}/headroom`, { method: "POST", headers: { Authorization: "Bearer ours-secret", "Content-Type": "application/json" }, body: JSON.stringify({ action: "backend", name: "nobody", on: true }) })).status, 404);
  assert.equal((await fetch(`${url}/headroom`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://elsewhere.example" }, body: JSON.stringify({ action: "install" }) })).status >= 400, true, "a page on another site cannot install anything");

  const page = (await (await fetch(`${url}/ui/data`, { headers: { Authorization: "Bearer ours-secret" } })).json()) as { net: { nodes: { self?: boolean; backends?: { name: string; headroom?: Doc }[] }[] } };
  const mine = page.net.nodes.find((n) => n.self)!.backends!;
  assert.ok((mine.find((b) => b.name === "squeezed")!.headroom!.saved as number) >= 900, "the page is told what it saved");
  assert.equal(mine.find((b) => b.name === "plain")!.headroom, undefined);
} finally {
  await node.close();
  headroom.closeAllConnections(); headroom.close(); provider.close();
}
console.log("headroom.test.ts ok");
