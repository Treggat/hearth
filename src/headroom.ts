/**
 * A Headroom server run beside this node makes a request smaller before it is sent: long tool
 * results, logs and files in the conversation are compressed, the system prompt and tools are not
 * read. Only the conversation goes to it; the backend's key never does.
 */
import { createHash } from "node:crypto";

import { send } from "./upstream.js";

type Doc = Record<string, unknown>;

export interface HeadroomConfig {
  /** Where its proxy listens. */
  url: string;
  /** Its proxy token, where it asks for one. */
  token: string | null;
  /** How long one compression may take before the request goes out as it came. */
  timeoutMs: number;
}

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => (typeof p === "object" && p !== null && typeof (p as Doc).text === "string" ? (p as Doc).text : "")).join("") : "";

/**
 * One name per conversation: who asked, of which model, and how it opened. Headroom answers a
 * conversation it knows with the turns it already returned, unchanged, so what the provider has
 * cached of them is still read.
 */
export function sessionOf(who: string, model: string, messages: unknown[]): string {
  const hash = createHash("sha256").update(`${who}\n${model}\n`);
  let said = false;
  for (const m of messages) {
    if (typeof m !== "object" || m === null) continue;
    const { role, content } = m as Doc;
    hash.update(`${String(role)}\n${textOf(content)}\n`);
    // The opening is the system prompt and the first thing said after it.
    if (role !== "system" && role !== "developer") { said = true; break; }
  }
  return said ? hash.digest("hex").slice(0, 32) : "";
}

/** What compressing a request came to: the body to send, and how many tokens it is smaller by. */
export interface Compressed {
  body: Doc;
  saved: number;
  /** Why the body is as it came, where compression was asked for and did not happen. */
  problem?: string;
}

/**
 * `body` with its conversation compressed. Never fails a request: whatever goes wrong, the body is
 * returned as it came and `problem` says why.
 */
export async function compress(body: Doc, h: HeadroomConfig, who: string, maxBytes: number, signal?: AbortSignal): Promise<Compressed> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const model = typeof body.model === "string" ? body.model : "";
  const session = sessionOf(who, model, messages);
  if (session === "" || model === "") return { body, saved: 0 };
  const own = new AbortController();
  const timer = setTimeout(() => own.abort(), h.timeoutMs);
  try {
    const up = await send(`${h.url}/v1/compress`, {
      method: "POST",
      json: { messages, model, config: { session_id: session } },
      headers: h.token ? { "X-Headroom-Proxy-Token": h.token } : {},
      signal: signal ? AbortSignal.any([signal, own.signal]) : own.signal,
    });
    // The answer is the conversation again, so it may be as large as a request is allowed to be.
    const raw = await up.text(maxBytes);
    if (own.signal.aborted) return { body, saved: 0, problem: `no answer in ${h.timeoutMs}ms` };
    if (!up.ok) return { body, saved: 0, problem: `answered ${up.status}: ${raw.slice(0, 120)}` };
    const got = JSON.parse(raw) as Doc;
    // A conversation may not come back shorter or longer in turns: that is not compression of what was said.
    if (!Array.isArray(got.messages) || got.messages.length !== messages.length) return { body, saved: 0, problem: "its answer was not the conversation it was sent" };
    return { body: { ...body, messages: got.messages }, saved: typeof got.tokens_saved === "number" && got.tokens_saved > 0 ? got.tokens_saved : 0 };
  } catch (e) {
    return { body, saved: 0, problem: own.signal.aborted ? `no answer in ${h.timeoutMs}ms` : String(e instanceof Error ? e.message : e).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}
