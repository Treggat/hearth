/**
 * Joining by invite code. Two real nodes, each with its own hearth.yaml: the lender mints a code,
 * the borrower redeems it, and each file gains the other as a peer with one fresh token between
 * them, live, with no secret ever typed by a person. Asserted: the borrower can then read the
 * lender's state with that token; a code works once; a wrong secret, a taken name and malformed
 * input are refused without writing anything.
 *
 *     npx tsx test/invite.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.js";
import { silentLogger } from "../src/log.js";
import { createNode } from "../src/server.js";

const backend = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(req.url === "/v1/models" ? { data: [{ id: "my-model" }] } : {}));
});
await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
const beUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;

const dir = mkdtempSync(join(tmpdir(), "hearth-invite-"));
async function boot(name: string, extra = "") {
  const path = join(dir, `${name}.yaml`);
  writeFileSync(path, `name: ${name}
backends:
  gpu: { url: "${beUrl}", kind: none, serves: [my-model] }
flows:
  anything-else:
    inputs: ["*"]
    steps:
      - to: { asked: true }
${extra}`);
  const node = createNode(loadConfig(path), silentLogger);
  node.start();
  await new Promise<void>((r) => node.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
  const post = async (route: string, body: unknown) => {
    const r = await fetch(`${url}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  return { node, url, path, post };
}

const lender = await boot("lender", "lending:\n  models: [my-model]\n");
const borrower = await boot("borrower");
const secretOf = (code: string) => (JSON.parse(Buffer.from(code.slice("hearth-invite:".length), "base64url").toString()) as { s: string }).s;

// Minting.
assert.equal((await lender.post("/peers/invite", { url: "not a url" })).status, 400, "an invite needs an address to reach the lender at");
const minted = await lender.post("/peers/invite", { url: lender.url + "/" });
assert.equal(minted.status, 200);
const code = minted.body.code as string;
assert.match(code, /^hearth-invite:[A-Za-z0-9_-]+$/, "a code is one pasteable token");
assert.ok(Date.parse(minted.body.expiresAt as string) > Date.now(), "and says when it stops working");

// Redeeming.
assert.equal((await borrower.post("/peers/join", { code: "hello" })).status, 400, "a code that is not one is refused before anything is sent");
const joined = await borrower.post("/peers/join", { code });
assert.equal(joined.status, 200, JSON.stringify(joined.body));
assert.deepEqual(joined.body, { peer: "lender", url: lender.url }, "the lender is added under its own name, at the address in the code");

// Both files, one token between them.
const onLender = loadConfig(lender.path);
const onBorrower = loadConfig(borrower.path);
const token = onLender.peerTokens.borrower;
assert.match(token ?? "", /^hpeer_[0-9a-f]{48}$/, "the lender accepts the borrower with a fresh token");
assert.deepEqual(onBorrower.peers.map((p) => [p.name, p.url, p.token]), [["lender", lender.url, token]], "and the borrower presents that same token");
assert.deepEqual(onLender.peers, [], "the lender borrows nothing back: an invite lends one way");
assert.ok(!readFileSync(borrower.path, "utf8").includes(secretOf(code)), "the invite secret is never written down");

// Live on both sides: the borrower reads the lender's state with the new token, no restart.
await fetch(`${borrower.url}/network`);
const health = (await (await fetch(`${borrower.url}/healthz`)).json()) as { peers: { total: number; up: number } };
assert.deepEqual(health.peers, { total: 1, up: 1 }, "the borrower sees the lender up straight away");

// Spent.
const again = await lender.post("/peer/join", { secret: secretOf(code), name: "someone-else" });
assert.equal(again.status, 403, "a code works once");
assert.equal((await lender.post("/peer/join", { secret: "guess", name: "x" })).status, 403, "a wrong secret gets nothing");
assert.deepEqual(Object.keys(loadConfig(lender.path).peerTokens), ["borrower"], "and neither wrote a peer");

// A name the lender already has is refused, and the code is not spent on it.
const second = (await lender.post("/peers/invite", { url: lender.url })).body.code as string;
assert.equal((await lender.post("/peer/join", { secret: secretOf(second), name: "borrower" })).status, 409, "a taken name is refused");
assert.equal((await lender.post("/peer/join", { secret: secretOf(second), name: "bad name!" })).status, 400, "so is a name that cannot be a peer's");
assert.equal((await lender.post("/peer/join", { secret: secretOf(second), name: "third" })).status, 200, "and the code still works for a good one");

// The borrower will not overwrite a peer it already has.
const third = (await lender.post("/peers/invite", { url: lender.url })).body.code as string;
assert.equal((await borrower.post("/peers/join", { code: third, as: "lender" })).status, 409, "joining as a name already in use is refused");
assert.equal((await lender.post("/peer/join", { secret: secretOf(third), name: "fourth" })).status, 200, "before the lender is ever asked, so its code is unspent");

// Without `as`, the inviter's own name is checked the same way, before its code is spent.
const fifth = (await lender.post("/peers/invite", { url: lender.url })).body.code as string;
const clash = await borrower.post("/peers/join", { code: fifth });
assert.equal(clash.status, 409, "the inviter's name is already a peer this node borrows from");
assert.equal((await lender.post("/peer/join", { secret: secretOf(fifth), name: "sixth" })).status, 200, "and the code is still unspent");
assert.deepEqual(loadConfig(borrower.path).peers.map((p) => [p.name, p.token]), [["lender", token]], "the peer it has is untouched");

// A node that already lends to the inviter keeps that, and gains the way to borrow back.
const friend = await boot("friend", "peers:\n  lender: { accept: friend-lends-to-lender }\n");
const seventh = (await lender.post("/peers/invite", { url: lender.url })).body.code as string;
assert.equal((await friend.post("/peers/join", { code: seventh })).status, 200);
const onFriend = loadConfig(friend.path);
assert.equal(onFriend.peerTokens.lender, "friend-lends-to-lender", "what it lends the inviter stays as it was");
assert.deepEqual(onFriend.peers.map((p) => [p.name, p.url, p.token]), [["lender", lender.url, loadConfig(lender.path).peerTokens.friend]], "and the same entry now borrows from it");
await friend.node.close();

await lender.node.close();
await borrower.node.close();
backend.close();
console.log("invite.test.ts ok");
