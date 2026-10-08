/**
 * The operator login on the status port. `uiListen.control: key` already serves the gated
 * writes there; with an operator configured it serves the login and the config editor too,
 * behind the same gates the main port holds. A status port without `control` stays read-only.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

import { parseConfig } from "../src/config.js";
import { hashPassword } from "../src/login.js";
import { createNode } from "../src/server.js";
import { silentLogger } from "../src/log.js";

const passHash = await hashPassword("right-horse");
const listenUi = async (node: ReturnType<typeof createNode>): Promise<string> => {
  const port = await new Promise<number>((ready) =>
    node.uiServer!.listen(0, "127.0.0.1", () => ready((node.uiServer!.address() as AddressInfo).port)));
  return `http://127.0.0.1:${port}`;
};
const signIn = (ui: string, pass: string): Promise<Response> =>
  fetch(`${ui}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user: "jadeyn", pass }),
  });

// --- control: key, with an operator ------------------------------------------
{
  const node = createNode(parseConfig({
    backend: { url: "http://127.0.0.1:9292" },
    apiKeys: ["test-key"],
    operator: { user: "jadeyn", passHash },
    uiListen: { host: "127.0.0.1", port: 4143, control: "key" },
  }), silentLogger);
  const ui = await listenUi(node);

  const boot = (await (await fetch(`${ui}/ui/data`)).json()) as { operator: string | null; login: boolean };
  assert.equal(boot.operator, null, "nobody is signed in yet");
  assert.equal(boot.login, true, "the page is told a login exists on this socket");

  // The event stream overlays the per-socket fields on a shared snapshot; it must say the same.
  const stream = await fetch(`${ui}/ui/events`);
  const reader = stream.body!.getReader();
  let frame = "";
  while (!frame.includes("\n\n")) frame += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  assert.match(frame, /"login":true/, "the stream's snapshot offers the login too");

  const closed = await fetch(`${ui}/config`);
  assert.equal(closed.status, 401, "the config is there, and it wants a credential");
  await closed.text();

  const wrong = await signIn(ui, "wrong-horse");
  assert.equal(wrong.status, 401, "a wrong password is refused here as on the main port");
  await wrong.text();

  const r = await signIn(ui, "right-horse");
  assert.equal(r.status, 200, "the right one signs in");
  await r.text();
  const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0]!;
  assert.match(cookie, /^hearth_op=/, "and the session rides a cookie");

  const open = await fetch(`${ui}/config`, { headers: { Cookie: cookie } });
  assert.equal(open.status, 200, "the session opens the config on the status port");
  await open.text();

  const seen = (await (await fetch(`${ui}/ui/data`, { headers: { Cookie: cookie } })).json()) as { operator: string | null };
  assert.equal(seen.operator, "jadeyn", "and the page can say who is signed in");

  const out = await fetch(`${ui}/logout`, { method: "POST", headers: { Cookie: cookie } });
  assert.equal(out.ok, true, "sign-out is served too");
  await out.text();
  const after = await fetch(`${ui}/config`, { headers: { Cookie: cookie } });
  assert.equal(after.status, 401, "and the cookie is worth nothing afterwards");
  await after.text();

  const other = await fetch(`${ui}/queue`, { headers: { Authorization: "Bearer test-key" } });
  assert.equal(other.status, 404, "every other path is still not served here, key or no key");
  await other.text();
  await node.close();
}

// --- no control: the status port is the page and nothing else -----------------
{
  const node = createNode(parseConfig({
    backend: { url: "http://127.0.0.1:9292" },
    apiKeys: ["test-key"],
    operator: { user: "jadeyn", passHash },
    uiListen: { host: "127.0.0.1", port: 4143 },
  }), silentLogger);
  const ui = await listenUi(node);

  const boot = (await (await fetch(`${ui}/ui/data`)).json()) as { login: boolean };
  assert.equal(boot.login, false, "no login is offered where none is served");
  const l = await signIn(ui, "right-horse");
  assert.equal(l.status, 404, "the login is not on a read-only status port");
  await l.text();
  const c = await fetch(`${ui}/config`, { headers: { Authorization: "Bearer test-key" } });
  assert.equal(c.status, 404, "nor is the config, even with a key");
  await c.text();
  await node.close();
}

console.log("status-login.test.ts ok");
