/**
 * hearth.yaml v1 → v2, on the YAML document so comments travel with the values they sit on.
 * v2 groups what v1 spread over the top level: lending:, borrowing:, backendDefaults:, one
 * entry per peer, and maps keyed by name for backends and peers.
 */
import { Document, isMap, isScalar, isSeq, YAMLMap, type Node } from "yaml";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Top-level keys that only v1 has, and where each one lives now. */
const MOVED: Record<string, string[]> = {
  share: ["lending", "models"],
  peerLane: ["lending", "lane"],
  peerMaxConcurrent: ["lending", "maxConcurrent"],
  peerRateLimit: ["lending", "rateLimit"],
  peerFirstByteMs: ["borrowing", "firstByteMs"],
  peerFreshMs: ["borrowing", "freshMs"],
  peerDownMs: ["borrowing", "downMs"],
  peerPollMs: ["borrowing", "pollMs"],
  peerStaleMs: ["borrowing", "staleMs"],
  coldPenalty: ["borrowing", "coldPenalty"],
  backendFirstByteMs: ["backendDefaults", "firstByteMs"],
  backendIdleMs: ["backendDefaults", "idleMs"],
};

/** The first v1-only thing in a parsed config, named for the error, or null for a v2 file. */
export function v1Marker(raw: Record<string, unknown>): string | null {
  for (const k of [...Object.keys(MOVED), "backend", "peerTokens", "notes"]) if (k in raw) return k;
  if (Array.isArray(raw.backends)) return "backends as a list";
  if (Array.isArray(raw.peers)) return "peers as a list";
  if (isObj(raw.scheduler) && "concurrency" in raw.scheduler) return "scheduler.concurrency";
  return null;
}

/** Rewrite a v1 document in place; returns one line per change, for the CLI to print. */
export function migrateDoc(doc: Document): string[] {
  const done: string[] = [];
  const move = (from: (string | number)[], to: (string | number)[]) => {
    const node = doc.getIn(from, true);
    if (node === undefined) return;
    doc.deleteIn(from);
    doc.setIn(to, node);
    done.push(`${from.join(".")} → ${to.join(".")}`);
  };

  for (const [k, to] of Object.entries(MOVED)) move([k], to);
  move(["scheduler", "concurrency"], ["backendDefaults", "concurrency"]);

  // `backend:` (one) and `backends:` (a list) both become a map keyed by name.
  // With both, which one was meant is the operator's call: `backend:` stays and the parser says so.
  const single = doc.get("backend", true);
  if (isMap(single) && !doc.has("backends")) {
    const name = String(single.get("name") ?? "default");
    single.delete("name");
    doc.delete("backend");
    doc.setIn(["backends", name], single);
    done.push(`backend → backends.${name}`);
  }
  listToMap(doc, "backends", done);
  const backends = doc.get("backends", true);
  if (isMap(backends)) {
    for (const pair of backends.items) {
      const b = pair.value;
      if (!isMap(b) || !b.has("llamaSwapExtras")) continue;
      const on = b.get("llamaSwapExtras") !== false;
      if (b.has("kind")) throw new Error("a backend sets kind and llamaSwapExtras, not both — keep kind, then migrate");
      b.delete("llamaSwapExtras");
      b.set("kind", on ? "llama-swap" : "none");
      done.push(`backends.${String(isScalar(pair.key) ? pair.key.value : pair.key)}.llamaSwapExtras → kind`);
    }
  }

  // One entry per peer: the token it presents to us joins the entry we borrow through.
  listToMap(doc, "peers", done);
  const tokens = doc.get("peerTokens", true);
  if (isMap(tokens)) {
    for (const pair of tokens.items) {
      const name = String(isScalar(pair.key) ? pair.key.value : pair.key);
      doc.setIn(["peers", name, "accept"], pair.value);
    }
    doc.delete("peerTokens");
    done.push("peerTokens.<name> → peers.<name>.accept");
  }

  // A note belongs to its model.
  const notes = doc.get("notes", true);
  if (isMap(notes)) {
    for (const pair of notes.items) {
      const id = String(isScalar(pair.key) ? pair.key.value : pair.key);
      doc.setIn(["models", id, "note"], pair.value);
    }
    doc.delete("notes");
    done.push("notes.<model> → models.<model>.note");
  }

  // `batch` was the older name for a model's concurrency.
  const models = doc.get("models", true);
  if (isMap(models)) {
    for (const pair of models.items) {
      const m = pair.value;
      if (!isMap(m) || !m.has("batch")) continue;
      if (!m.has("concurrency")) m.set("concurrency", m.get("batch", true));
      m.delete("batch");
      done.push(`models.${String(isScalar(pair.key) ? pair.key.value : pair.key)}.batch → concurrency`);
    }
  }
  const sched = doc.get("scheduler", true);
  if (isMap(sched) && sched.items.length === 0) doc.delete("scheduler");

  // Moved keys land at the end; put the file back in reading order. Comments ride on their pairs.
  const top = doc.contents;
  if (isMap(top)) {
    const rank = (k: unknown) => {
      const i = ORDER.indexOf(String(isScalar(k) ? k.value : k));
      return i === -1 ? ORDER.length : i;
    };
    top.items.sort((a, b) => rank(a.key) - rank(b.key));
  }
  return done;
}

/** v2's top level in the order a reader wants it: who this is, what it runs, how it shares. */
const ORDER = [
  "name", "listen", "resources", "backends", "backendDefaults", "models", "scheduler",
  "peers", "lending", "borrowing", "apiKeys", "operator", "maxBodyBytes", "shutdownGraceMs", "stateFile",
];

/** `[{name: a, ...}]` → `{a: {...}}`, keeping each entry's node and its comments. */
function listToMap(doc: Document, key: string, done: string[]): void {
  const seq = doc.get(key, true);
  if (!isSeq(seq)) return;
  // Made by the document, so it carries the schema later setIn calls need to add entries.
  const map = doc.createNode({}) as YAMLMap<unknown, Node>;
  for (const item of seq.items) {
    if (!isMap(item)) continue;
    const name = String(item.get("name") ?? "");
    // A map cannot hold the same name twice, so the second would silently replace the first.
    if (map.has(name)) throw new Error(`two ${key} are both named "${name}" — rename one, then migrate`);
    item.delete("name");
    map.set(name, item as Node);
  }
  map.commentBefore = seq.commentBefore;
  doc.set(key, map);
  done.push(`${key}: a list → a map keyed by name`);
}

/** The same rewrite on a plain object: test fixtures and anything else holding v1 as data. */
export function migrate(raw: unknown): unknown {
  if (!isObj(raw) || v1Marker(raw) === null) return raw;
  const doc = new Document(raw);
  migrateDoc(doc);
  return doc.toJS();
}
