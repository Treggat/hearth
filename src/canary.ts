/**
 * Noticing a seat that answers 200 with nothing worth reading.
 *
 * Card B's vLLM returned HTTP 200 and 200 `!` characters for every request for
 * hours while hearth, llama-swap and the vLLM metrics all looked healthy. Every
 * check in the stack asked "did bytes arrive", and the bytes arrived. The answer
 * that would have caught it is not "is it up" but "does it still know anything":
 * ask a question with one right answer, in a handful of tokens, and look at what
 * comes back.
 *
 * This module is the policy half, and it holds no sockets:
 *   - `analyseAnswer` judges one final answer against an expected pattern.
 *   - `DegenerateScan` watches a stream as it is proxied, without buffering it.
 *   - `Canary` schedules the probes, keeps the per-model state, and runs the
 *     state change hooks. Everything about the backend (is it warm, is it busy,
 *     how do I call it) is supplied by the host, so the state machine can be
 *     driven in a test with no HTTP at all.
 *
 * Off unless `canary:` is configured, because a heartbeat that talks to a model
 * on its own schedule is not something to switch on for someone.
 */
import type { CanaryConfig, CanaryProbe } from "./config.js";
import type { Logger } from "./log.js";

/**
 * Why an answer failed to pass, or that it did. `ok` is the only good one;
 * `thinking` and `skipped` are inconclusive — our asking was wrong, not the
 * seat — and are the two that must never count against a model.
 */
export type CanaryReason = "ok" | "empty" | "degenerate" | "missing" | "thinking" | "skipped";

/** A failure that is about reaching the backend rather than about what it said. */
export type TransportReason = "transport" | "timeout";

export type VerdictReason = CanaryReason | TransportReason;

/** What one judged answer was. */
export interface Verdict {
  reason: VerdictReason;
  /** It passed the expected-text check. */
  ok: boolean;
  /** It counts against the seat: only `thinking` is inconclusive rather than a fault. */
  failure: boolean;
  /** One sentence, for the error body, the log line and the notification. */
  detail: string;
  /** The beginning of what actually came back, bounded. Never empty on a failure with output. */
  sample: string;
}

/** The interesting parts of one completion, wherever the server put them. */
export interface CompletionReading {
  /** The answer the client would read. */
  content: string;
  /** A reasoning model's trace, when it has one. Not the answer. */
  reasoning: string;
  finishReason: string | null;
}

/** How much of a bad answer rides along in the error body and the notification. */
const SAMPLE_MAX = 80;

/** One character this many times in a row is not language. */
const MAX_RUN = 8;
/** One whitespace-separated token this many times in a row is not language either. */
const TOKEN_RUN = 6;
/** Below this share of distinct characters, in the first screenful, it is noise. */
const MIN_DISTINCT = 0.2;
/** Too short to judge by its alphabet: "42" and "Ok" are fine answers. */
const DISTINCT_MIN_CHARS = 8;
/** Past this, the ratio says more about the language than about the answer. */
const DISTINCT_MAX_CHARS = 512;

/** The first `SAMPLE_MAX` characters, for a body that has to stay small. */
function sampleOf(text: string): string {
  return text.slice(0, SAMPLE_MAX);
}

/** The longest run of one repeated character. */
function longestRun(text: string): number {
  let best = 0;
  let run = 1;
  for (let i = 1; i < text.length; i++) {
    if (text[i] === text[i - 1]) {
      run++;
    } else {
      if (run > best) best = run;
      run = 1;
    }
  }
  return Math.max(best, text.length === 0 ? 0 : run);
}

/** Whether one whitespace-separated token repeats `n` times in a row. */
function tokenRun(text: string, n: number): boolean {
  const parts = text.split(/\s+/).filter((p) => p !== "");
  if (parts.length < n) return false;
  let run = 1;
  for (let i = 1; i < parts.length; i++) {
    if (parts[i] === parts[i - 1]) {
      run++;
      if (run >= n) return true;
    } else {
      run = 1;
    }
  }
  return false;
}

/** Distinct characters over the answer's first screenful, as a share of its length. */
function distinctRatio(text: string): number {
  const window = text.slice(0, DISTINCT_MAX_CHARS);
  return new Set(window).size / window.length;
}

/**
 * Does this read as language at all? Deliberately blunt, because a false
 * positive costs a healthy seat a minute of refusals.
 */
function degenerate(text: string, maxRun: number, tokenRepeat: number, minDistinct: number): boolean {
  if (text === "") return false;
  if (longestRun(text) >= maxRun) return true;
  if (tokenRun(text, tokenRepeat)) return true;
  return text.length >= DISTINCT_MIN_CHARS
    && text.length <= DISTINCT_MAX_CHARS
    && distinctRatio(text) < minDistinct;
}

/** Join an OpenAI `content` that may be a string or a list of text parts. */
function textOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) return "";
  const out: string[] = [];
  for (const part of v) {
    if (typeof part === "string") out.push(part);
    else if (part && typeof part === "object") {
      const p = part as Record<string, unknown>;
      if (typeof p.text === "string") out.push(p.text);
    }
  }
  return out.join("");
}

/** The non-empty string at `key`, or "". */
function strAt(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  return typeof v === "string" ? v : "";
}

/**
 * Pull the answer, the reasoning trace and the stop reason out of a response
 * body, or null when there is no choice in it to judge. Never throws: a body a
 * canary cannot read is a verdict of its own, not a crash in the proxy.
 */
export function readCompletion(body: unknown): CompletionReading | null {
  if (typeof body !== "object" || body === null) return null;
  const choices = (body as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const choice = choices[0];
  if (typeof choice !== "object" || choice === null) return null;
  const c = choice as Record<string, unknown>;
  const message = typeof c.message === "object" && c.message !== null
    ? c.message as Record<string, unknown>
    : null;
  const content = message ? textOf(message.content) : (typeof c.text === "string" ? c.text : "");
  // vLLM spells the trace `reasoning_content`; some builds use `reasoning`.
  const reasoning = message ? (strAt(message, "reasoning_content") || strAt(message, "reasoning")) : "";
  const finishReason = typeof c.finish_reason === "string" ? c.finish_reason : null;
  return { content, reasoning, finishReason };
}

function verdict(reason: VerdictReason, failure: boolean, detail: string, sample: string): Verdict {
  return { reason, ok: reason === "ok", failure, detail, sample };
}

/**
 * Judge one answer. `expect` is the pattern a correct answer must match.
 *
 * The reasoning channel is handled explicitly, because getting it wrong
 * degrades healthy reasoning models: a trace with an empty `content` and
 * `finish_reason: length` means the probe was given too small a budget, which
 * is our mistake and is reported as `thinking` — neither a pass nor a failure.
 * Every other empty answer IS a failure, including a model that stops of its
 * own accord having said nothing.
 */
export function analyseAnswer(reading: CompletionReading, expect: RegExp): Verdict {
  const content = reading.content.trim();
  const reasoning = reading.reasoning.trim();
  const sample = sampleOf(reading.content.trim() === "" ? reasonSample(reading) : reading.content.trim());

  if (content === "" && reasoning === "") {
    return verdict("empty", true, "the answer was empty", sample);
  }
  if (degenerate(content, MAX_RUN, TOKEN_RUN, MIN_DISTINCT)) {
    return verdict(
      "degenerate", true,
      `the answer repeats itself (${describeRepetition(content)})`,
      sample,
    );
  }
  if (content === "") {
    if (degenerate(reasoning, MAX_RUN, TOKEN_RUN, MIN_DISTINCT)) {
      return verdict("degenerate", true, "the reasoning channel repeats itself and no answer followed", sample);
    }
    if (reading.finishReason === "length") {
      return verdict(
        "thinking", false,
        "the model spent its whole token budget reasoning and never answered; raise canary.maxTokens",
        sample,
      );
    }
    return verdict("empty", true, "nothing came back in the content channel", sample);
  }
  if (!expect.test(content)) {
    if (reading.finishReason === "length") {
      return verdict(
        "degenerate", true,
        "it hit the token cap without answering the question",
        sample,
      );
    }
    return verdict("missing", true, `the answer did not match ${expect}`, sample);
  }
  return verdict("ok", false, "answered as expected", sample);
}

/** The reasoning trace, when there is no content to show instead; bounded. */
function reasonSample(reading: CompletionReading): string {
  const r = reading.reasoning.trim();
  return r === "" ? "" : `(reasoning) ${r}`;
}

/** A short phrase naming why a repetition was called one, for the error body. */
function describeRepetition(text: string): string {
  const run = longestRun(text);
  if (run >= MAX_RUN) return `${run} of the same character in a row`;
  const parts = text.split(/\s+/).filter((p) => p !== "");
  for (let i = 1; i < parts.length; i++) {
    if (parts[i] === parts[i - 1]) {
      let n = 1;
      while (i + 1 < parts.length && parts[i + 1] === parts[i]) { i++; n++; }
      if (n + 1 >= TOKEN_RUN) return `"${parts[i]}" ${n + 1} times in a row`;
    }
  }
  return `only ${new Set(text.slice(0, DISTINCT_MAX_CHARS)).size} distinct characters in ${text.length}`;
}

/** Does this verdict count against the seat? */
export function isFailure(v: Verdict): boolean {
  return v.failure;
}

// ---------------------------------------------------------------------------
// Watching a stream as it is relayed
// ---------------------------------------------------------------------------

/** A character this many times in a row in RELAYED traffic. Higher than the answer check, so a rule of dashes is not a fault. */
const PASSIVE_MAX_RUN = 32;
/** One whitespace-separated token this many times in a row in relayed traffic. */
const PASSIVE_TOKEN_RUN = 8;
/** Below this share of distinct characters, relayed text is noise. Very low: ordinary prose sits near 0.06. */
const PASSIVE_MIN_DISTINCT = 0.02;
/** Too short to judge by its alphabet. */
const PASSIVE_DISTINCT_MIN_CHARS = 32;
/** A run this long in a raw (non-SSE) body. JSON punctuation breaks runs quickly; 200 `!` does not. */
const RAW_MAX_RUN = 64;
/** A single whitespace-delimited token longer than this is truncated, so one token cannot grow the buffer. */
const TOKEN_MAX = 128;
/** An SSE line longer than this is abandoned rather than buffered. */
const SSE_CARRY_MAX = 64 * 1024;
/**
 * The most of a non-streamed body the watcher holds. A non-streamed answer
 * only exists when it is complete, so reading it means holding it; the bound is
 * what keeps a huge response from becoming the proxy's memory. Past it, only
 * the raw-run check applies to what was held.
 */
const BODY_MAX = 256 * 1024;

/** What one incremental scan calls a repetition. */
export interface ScanTuning {
  /** Characters repeated in a row. */
  maxRun: number;
  /** One token repeated in a row; Infinity disables the check. */
  tokenRun: number;
  /** Distinct-character share below which the text is noise; 0 disables the check. */
  minDistinct: number;
  distinctMinChars: number;
  distinctMaxChars: number;
}

/** The tuning for model output read out of a stream. */
const STREAM_TUNING: ScanTuning = {
  maxRun: PASSIVE_MAX_RUN,
  tokenRun: PASSIVE_TOKEN_RUN,
  minDistinct: PASSIVE_MIN_DISTINCT,
  distinctMinChars: PASSIVE_DISTINCT_MIN_CHARS,
  distinctMaxChars: DISTINCT_MAX_CHARS,
};

/** Raw bodies get only the long-run check: JSON punctuation defeats anything finer. */
const RAW_TUNING: ScanTuning = {
  maxRun: RAW_MAX_RUN,
  tokenRun: Infinity,
  minDistinct: 0,
  distinctMinChars: 0,
  distinctMaxChars: 0,
};

/**
 * Watches text go by and remembers only whether it ever became degenerate.
 *
 * Holds a bounded tail — the running character run, the token being built, a
 * short sample and a capped alphabet — so a long generation costs the proxy
 * nothing.
 */
export class DegenerateScan {
  private readonly t: ScanTuning;
  private runChar = "";
  private runLen = 0;
  private chars = 0;
  private readonly seen = new Set<string>();
  private token = "";
  private lastToken = "";
  private tokenRunLen = 0;
  private sample = "";
  private hit: Verdict | null = null;

  constructor(tuning?: Partial<ScanTuning>) {
    this.t = { ...STREAM_TUNING, ...tuning };
  }

  /** Feed a piece of the answer. True once it reads as degenerate (and stays true). */
  feed(text: string): boolean {
    for (const ch of text) {
      if (ch === this.runChar) {
        this.runLen++;
      } else {
        this.runChar = ch;
        this.runLen = 1;
      }
      if (this.hit === null && this.runLen >= this.t.maxRun) {
        this.setHit(`the same character ${JSON.stringify(ch)} ${this.runLen} times in a row`);
      }
      if (/\s/.test(ch)) this.endToken();
      else if (this.token.length < TOKEN_MAX) this.token += ch;
      this.chars++;
      if (this.seen.size < this.t.distinctMaxChars) this.seen.add(ch);
      if (this.sample.length < SAMPLE_MAX) this.sample += ch;
    }
    if (this.hit === null
        && this.t.minDistinct > 0
        && this.chars >= this.t.distinctMinChars
        && this.chars <= this.t.distinctMaxChars
        && this.seen.size / this.chars < this.t.minDistinct) {
      this.setHit(`only ${this.seen.size} distinct characters in ${this.chars}`);
    }
    return this.hit !== null;
  }

  private endToken(): void {
    if (this.token === "") return;
    if (this.token === this.lastToken) this.tokenRunLen++;
    else {
      this.lastToken = this.token;
      this.tokenRunLen = 1;
    }
    this.token = "";
    if (this.hit === null && this.tokenRunLen >= this.t.tokenRun) {
      this.setHit(`the token ${JSON.stringify(this.lastToken)} ${this.tokenRunLen} times in a row`);
    }
  }

  private setHit(detail: string): void {
    this.hit = verdict("degenerate", true, detail, this.sample);
  }

  /** The first degenerate reading, or null. */
  verdict(): Verdict | null {
    return this.hit;
  }

  /** Characters held right now; bounded by construction, and asserted in tests. */
  retained(): number {
    return this.sample.length + this.token.length + this.lastToken.length + this.seen.size;
  }
}

/**
 * Watches one proxied response without touching it.
 *
 * A stream is read frame by frame as it goes past, so a degenerate answer is
 * caught on the chunk that first shows the repetition. A NON-streamed response
 * is one JSON body that only exists once the model has finished, so it is held
 * — bounded — and judged in `finish()`; there is nothing to judge before that,
 * and pretending otherwise would mean buffering the generation itself.
 *
 * Either way the caller writes each chunk on unchanged and immediately.
 */
export class StreamWatch {
  private readonly scan: DegenerateScan;
  private readonly sse: boolean;
  private readonly decoder = new TextDecoder();
  private carry = "";
  /** The non-streamed body, bounded; see BODY_MAX. */
  private held = "";
  private done = false;
  private hit: Verdict | null = null;

  constructor(contentType?: string) {
    this.sse = /text\/event-stream/i.test(contentType ?? "");
    this.scan = new DegenerateScan(STREAM_TUNING);
  }

  /** Observe one chunk. Never throws, never blocks, never modifies it. */
  feed(chunk: Buffer | string): void {
    if (this.done || this.hit !== null) return;
    const text = typeof chunk === "string"
      ? chunk
      : this.decoder.decode(chunk as Uint8Array, { stream: true });
    if (text === "") return;
    if (!this.sse) {
      // Truncated to the bound, not merely stopped at it: one chunk can be the
      // whole body, and a cap that only refuses the next append is no cap.
      if (this.held.length < BODY_MAX) {
        this.held += text.slice(0, BODY_MAX - this.held.length);
      }
      return;
    }
    this.carry += text.replace(/\r\n/g, "\n");
    const lines = this.carry.split("\n");
    // The last piece is a line still in flight; keep it, bounded.
    this.carry = lines.pop() ?? "";
    if (this.carry.length > SSE_CARRY_MAX) this.carry = "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      let body: unknown;
      try {
        body = JSON.parse(payload);
      } catch {
        continue;
      }
      this.scan.feed(answerText(body));
    }
  }

  /**
   * The response is complete: judge what was held. For a stream this only
   * repeats the running verdict; for a non-streamed body it is the only moment
   * the answer exists at all.
   */
  finish(): Verdict | null {
    this.done = true;
    if (this.hit !== null) return this.hit;
    this.hit = this.scan.verdict();
    if (this.hit !== null || this.sse || this.held === "") return this.hit;
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.held);
    } catch {
      parsed = undefined;
    }
    const said = parsed === undefined ? "" : answerText(parsed);
    if (said !== "") {
      // The same content rules a streamed answer gets, applied to the whole body.
      const s = new DegenerateScan(STREAM_TUNING);
      s.feed(said);
      this.hit = s.verdict();
      return this.hit;
    }
    if (parsed !== undefined) {
      // It IS JSON and we read it: no answer text in it means there is nothing
      // here to judge. A base64 image or a rerank score is not a broken seat.
      return null;
    }
    // Not JSON at all — a plain-text completion from a server that answers that
    // way, or a body too large to hold whole. The raw run check is the last
    // net, and only here: reading arbitrary JSON fields as the model's words is
    // how an image becomes a "degraded" seat.
    if (/^\s*[{[]/.test(this.held)) return null;
    const s = new DegenerateScan(RAW_TUNING);
    s.feed(this.held);
    this.hit = s.verdict();
    return this.hit;
  }

  /** The degenerate verdict, once one has been seen. */
  verdict(): Verdict | null {
    return this.hit ?? this.scan.verdict();
  }

  /** How much the watcher is holding, for the no-buffering guarantee. */
  retained(): number {
    return this.sse
      ? this.scan.retained() + this.carry.length
      : this.scan.retained() + this.held.length;
  }
}

/** The same object, or null. */
function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? v as Record<string, unknown> : null;
}

/**
 * The model's own words in one chunk or one whole body, whichever shape the
 * server uses. Everything that is not the model's words — the JSON around it,
 * a base64 image, a rerank score — is deliberately not read: calling a field
 * hearth does not understand "degenerate" would refuse a working seat.
 *
 * Shapes covered, because a degenerate answer can arrive in any of them:
 *   - chat, streamed (`choices[].delta.content`) and not (`message.content`);
 *   - the reasoning channel under either spelling (`reasoning_content`,
 *     `reasoning`), which is where a reasoning model's junk shows up first;
 *   - legacy completions (`choices[].text`), streamed and whole — a separate
 *     endpoint, and reading only the chat shape leaves it unwatched;
 *   - the Responses API: named events carrying `delta`, and a whole body's
 *     `output[].content[].text`.
 */
function answerText(body: unknown): string {
  const o = obj(body);
  if (o === null) return "";
  // Responses-API deltas: {type: "response.output_text.delta", delta: "..."}.
  if (typeof o.delta === "string" && typeof o.type === "string"
      && /^response\.(output_text|reasoning_text|reasoning_summary_text)\.delta$/.test(o.type)) {
    return o.delta;
  }
  const choices = o.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const c = obj(choices[0]);
    if (c !== null) {
      const carrier = obj(c.delta) ?? obj(c.message);
      if (carrier !== null) {
        const said = textOf(carrier.content)
          || strAt(carrier, "reasoning_content")
          || strAt(carrier, "reasoning");
        if (said !== "") return said;
      }
      // The legacy completions shape, streamed and whole.
      if (typeof c.text === "string") return c.text;
    }
  }
  // llama.cpp's own `/completion` answers with a bare `content` field.
  if (typeof o.content === "string") return o.content;
  // A whole Responses body: output[].content[].text.
  if (Array.isArray(o.output)) {
    const parts: string[] = [];
    for (const item of o.output) {
      const it = obj(item);
      const content = it?.content;
      if (it === null || !Array.isArray(content)) continue;
      for (const p of content) {
        const part = obj(p);
        if (part !== null && typeof part.text === "string") parts.push(part.text);
      }
    }
    if (parts.length > 0) return parts.join("");
  }
  return "";
}

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

/** How often the scheduler looks for a probe that has come due. */
const TICK_MS = 1_000;

/** Why one model is out of rotation, and what to tell whoever asked. */
export interface DegradedInfo {
  reason: VerdictReason;
  detail: string;
  /** The bad output, bounded; part of the error body. */
  sample: string;
  /** When it went degraded, for "since when" and for the notification. */
  since: number;
  /** Consecutive failures behind this reading. */
  failures: number;
}

/** One watched model, as the page, /healthz and the error body read it. */
export interface ModelHealth {
  model: string;
  backend: string;
  health: "ok" | "degraded";
  /** Consecutive failures. */
  failures: number;
  /** Consecutive clean probes, against `recoverAfter`. */
  clean: number;
  /** Probes run since startup; passive observations are not probes. */
  probes: number;
  lastProbeAt: number;
  /** How long the last probe took, in ms. What the check costs. */
  lastProbeMs: number;
  lastVerdict: Verdict | null;
  degraded: DegradedInfo | null;
  /** A recovery drop has happened and the model has not been proven since. */
  reloadPending: boolean;
  /** Recovery drops attempted. */
  recoveryCount: number;
}

/** A state change, as the notification hook receives it. */
export type CanaryEvent =
  | {
    event: "degraded";
    model: string;
    backend: string;
    reason: VerdictReason;
    detail: string;
    sample: string;
    since: number;
    failures: number;
  }
  | {
    event: "recovered";
    model: string;
    backend: string;
    /** When the outage started. */
    since: number;
    /** How long it lasted. */
    downMs: number;
    /** Probes run while it was out. */
    probes: number;
  };

/**
 * Everything the canary needs to know about one model that the host knows
 * better: whether it is resident, whether the seat is free, how to ask it
 * something, and whether it can be dropped.
 */
export interface ProbeTarget {
  /** The advertised id, which is what an error body must name. */
  model: string;
  /** The backend slot's name. */
  backend: string;
  /** The id the backend itself knows this model by. */
  wire: string;
  /** The backend can drop this one model (llama-swap's per-model unload). */
  canUnload: boolean;
  /** The model is resident, so a probe generates instead of loading. */
  warm: boolean;
  /** Nothing is running or queued on this backend. */
  idle: boolean;
  /** A probe could start right now: a free slot and nothing waiting. */
  ready: boolean;
  /** Models the backend holds now; 0 means a reload would evict nothing. */
  loadedCount: number;
  /**
   * Run one probe and judge it. `load` is true only for the reload that a
   * recovery asked for, and only while the card is empty.
   */
  probe: (probe: CanaryProbe, signal: AbortSignal, load: boolean) => Promise<Verdict>;
  /** Ask the backend to drop this one model. False when it would not. */
  unload: () => Promise<boolean>;
}

export interface CanaryOptions {
  cfg: CanaryConfig;
  log: Logger;
  /** Every model opted in, recomputed each tick: a llama-swap catalog moves. */
  targets: () => ProbeTarget[];
  /** A state change to announce. Must not throw; a slow hook is the hook's problem. */
  notify?: (event: CanaryEvent) => void;
  now?: () => number;
}

/** What the state machine tracks per model, including the scheduling fields the views do not expose. */
interface ModelState extends Omit<ModelHealth, "health"> {
  /** When the next probe is due. */
  nextProbeAt: number;
  /** When recovery last acted, for the cooldown. */
  recoveryAt: number;
}

/**
 * Schedules the probes and owns the per-model verdict.
 *
 * Safe by construction in the two ways that matter: a probe is only ever run
 * against a model that is already resident on a seat with a free slot, so a
 * canary can neither load nor evict; and a recovery drop is only ever asked of
 * an idle seat that can do it, at most once per cooldown.
 */
export class Canary {
  private readonly cfg: CanaryConfig;
  private readonly log: Logger;
  private readonly deps: CanaryOptions;
  private readonly now: () => number;
  private readonly states = new Map<string, ModelState>();
  private readonly inFlight = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: CanaryOptions) {
    this.deps = opts;
    this.cfg = opts.cfg;
    this.log = opts.log;
    this.now = opts.now ?? Date.now;
  }

  /** The probe config for one model: its own overrides over its backend's over the defaults. */
  probeFor(model: string, backend: string): CanaryProbe {
    return {
      ...this.cfg.defaults,
      ...(this.cfg.backends[backend] ?? {}),
      ...(this.cfg.models[model] ?? {}),
    };
  }

  /** Is this model opted in at all? A scoped backend answers for its own models. */
  has(model: string, backend?: string): boolean {
    if (this.cfg.models[model] !== undefined) return true;
    return backend !== undefined && this.cfg.backends[backend] !== undefined;
  }

  /** Is this (model, backend) pair one the canary watches? Pointless work is skipped on this. */
  watches(model: string, backend: string): boolean {
    return this.has(model, backend);
  }

  /** The fast refusal for a degraded model, or null. */
  refuse(model: string): DegradedInfo | null {
    return this.states.get(model)?.degraded ?? null;
  }

  stateOf(model: string): ModelHealth | null {
    const st = this.states.get(model);
    return st ? this.view(st) : null;
  }

  snapshot(): ModelHealth[] {
    return [...this.states.values()].map((st) => this.view(st));
  }

  degradedCount(): number {
    let n = 0;
    for (const st of this.states.values()) if (st.degraded !== null) n++;
    return n;
  }

  /** Record a degenerate completion seen in real traffic, through the same counters a probe uses. */
  observePassive(model: string, backend: string, verdict: Verdict): void {
    if (!this.cfg.passive) return;
    if (this.has(model, backend) === false) return;
    if (verdict.reason === "thinking") return;
    this.record({ model, backend }, verdict, "passive");
  }

  start(): void {
    if (this.timer !== null) return;
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    // Never a reason for the process to stay up.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Probe whatever has come due. Awaits everything it starts, so a caller (and
   * a test) can wait for a full round.
   */
  async tick(): Promise<void> {
    const now = this.now();
    const work: Promise<void>[] = [];
    for (const t of this.deps.targets()) {
      const st = this.state(t);
      const probe = this.probeFor(t.model, t.backend);
      // Recovery first, and if it acted, this tick is not also a probe: the drop
      // it just asked for has not landed yet, and probing now would race it.
      const acted = await this.recover(t, st, now, probe);
      if (acted) continue;
      if (this.inFlight.has(t.model)) continue;
      if (st.nextProbeAt > now) continue;
      // Never LOAD a seat: a cold model is skipped, not probed.
      if (!t.warm && !st.reloadPending) {
        this.log.debug("canary.skipped_cold", { model: t.model, backend: t.backend });
        continue;
      }
      // A recovery reload is allowed to load, but only onto an empty card, so
      // it cannot evict a neighbour that real traffic put there meanwhile.
      if (!t.warm && t.loadedCount > 0) {
        this.log.debug("canary.reload_deferred", {
          model: t.model, backend: t.backend, loaded: t.loadedCount,
          detail: "the model was dropped for recovery and is waiting for the card to be free",
        });
        continue;
      }
      if (!t.ready) {
        this.log.debug("canary.skipped_busy", { model: t.model, backend: t.backend });
        continue;
      }
      // The interval is the time between PROBES, not between attempts. A probe
      // skipped because the seat was cold or busy leaves the timer where it is,
      // so the first moment the model is warm it gets asked — rather than the
      // tick that found it cold pushing the next attempt a whole interval away.
      st.nextProbeAt = now + probe.intervalMs;
      work.push(this.run(t, probe, !t.warm));
    }
    await Promise.all(work);
  }

  /** One probe, with the deadline the config asked for. Never rejects. */
  private async run(t: ProbeTarget, probe: CanaryProbe, load: boolean): Promise<void> {
    this.inFlight.add(t.model);
    const startedAt = this.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), probe.timeoutMs);
    timer.unref?.();
    try {
      let v: Verdict;
      try {
        v = await t.probe(probe, ctrl.signal, load);
      } catch (e) {
        v = ctrl.signal.aborted
          ? {
            reason: "timeout", ok: false, failure: true,
            detail: `no answer within ${probe.timeoutMs}ms`, sample: "",
          }
          : {
            reason: "transport", ok: false, failure: true,
            detail: e instanceof Error ? e.message : String(e), sample: "",
          };
      }
      this.record(t, v, "probe");
      // Recorded on the reading, so the cost of the check is visible rather than
      // a thing you have to go and measure before trusting it.
      this.state(t).lastProbeMs = Math.max(0, this.now() - startedAt);
    } finally {
      clearTimeout(timer);
      this.inFlight.delete(t.model);
    }
  }

  /**
   * The gentlest nudge, and only for a seat that can take it: drop the one
   * model so the next request has to load it fresh. True when it acted.
   */
  private async recover(
    t: ProbeTarget, st: ModelState, now: number, _probe: CanaryProbe,
  ): Promise<boolean> {
    const rec = this.cfg.recovery;
    if (st.degraded === null || rec === null || !rec.unload || !t.canUnload) return false;
    if (now - st.recoveryAt < rec.cooldownMs) return false;
    if (!t.warm) return false;
    // Never on a busy seat: the drop is a reload for whoever is waiting.
    if (!t.idle) {
      this.log.debug("canary.recovery_deferred", {
        model: t.model, backend: t.backend, detail: "the seat is busy",
      });
      return false;
    }
    st.recoveryAt = now;
    st.recoveryCount++;
    let dropped = false;
    try {
      dropped = await t.unload();
    } catch (e) {
      this.log.warn("canary.recovery_failed", {
        model: t.model, backend: t.backend, wire: t.wire,
        detail: e instanceof Error ? e.message : String(e),
      });
    }
    if (dropped) {
      st.reloadPending = true;
      // Exactly what was done, so a later reader can tell recovery from a crash.
      this.log.warn("canary.recovery_unloaded", {
        model: t.model, backend: t.backend, wire: t.wire,
        reason: st.degraded.reason, detail: "dropped so the next request reloads it",
      });
    } else {
      this.log.warn("canary.recovery_refused", {
        model: t.model, backend: t.backend, wire: t.wire,
        detail: "the backend would not unload it; notification only",
      });
    }
    return true;
  }

  /** Fold one verdict into a model's state, and announce whatever changed. */
  private record(t: Pick<ProbeTarget, "model" | "backend">, v: Verdict, source: "probe" | "passive"): void {
    const now = this.now();
    const st = this.state(t);
    const probe = this.probeFor(t.model, t.backend);
    st.lastVerdict = v;
    st.lastProbeAt = now;
    if (source === "probe") st.probes++;

    // Inconclusive: either the probe asked for too little (a reasoning model's
    // trace filled the budget) or it never got a lane. Both are our mistake, not
    // the seat's. Neither fails the model nor forgives a failure already counted.
    if (v.reason === "thinking" || v.reason === "skipped") {
      this.log.info("canary.inconclusive", {
        model: t.model, backend: t.backend, reason: v.reason, detail: v.detail,
      });
      return;
    }

    if (v.ok) {
      st.failures = 0;
      st.reloadPending = false;
      if (st.degraded !== null) {
        st.clean++;
        if (st.clean >= probe.recoverAfter) {
          const since = st.degraded.since;
          st.degraded = null;
          st.clean = 0;
          this.log.warn("canary.recovered", {
            model: t.model, backend: t.backend, downMs: now - since, probes: st.probes,
          });
          this.emit({
            event: "recovered", model: t.model, backend: t.backend,
            since, downMs: now - since, probes: st.probes,
          });
        }
        return;
      }
      st.clean = 0;
      return;
    }

    st.clean = 0;
    st.failures++;
    if (st.degraded !== null) {
      st.degraded = {
        reason: v.reason, detail: v.detail, sample: v.sample,
        since: st.degraded.since, failures: st.failures,
      };
      this.log.warn("canary.still_degraded", {
        model: t.model, backend: t.backend, reason: v.reason, failures: st.failures,
      });
      return;
    }
    if (st.failures < probe.failureThreshold) {
      this.log.warn("canary.failed", {
        model: t.model, backend: t.backend, reason: v.reason, detail: v.detail,
        failures: st.failures, threshold: probe.failureThreshold,
      });
      return;
    }
    st.degraded = {
      reason: v.reason, detail: v.detail, sample: v.sample, since: now, failures: st.failures,
    };
    this.log.error("canary.degraded", {
      model: t.model, backend: t.backend, reason: v.reason, detail: v.detail,
      failures: st.failures, sample: v.sample, source,
    });
    this.emit({
      event: "degraded", model: t.model, backend: t.backend,
      reason: v.reason, detail: v.detail, sample: v.sample, since: now, failures: st.failures,
    });
  }

  private emit(event: CanaryEvent): void {
    const hook = this.deps.notify;
    if (hook === undefined) return;
    try {
      hook(event);
    } catch (e) {
      this.log.warn("canary.notify_failed", {
        event: event.event, model: event.model,
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private state(t: { model: string; backend: string }): ModelState {
    let st = this.states.get(t.model);
    if (st === undefined) {
      st = {
        model: t.model,
        backend: t.backend,
        failures: 0,
        clean: 0,
        probes: 0,
        lastProbeAt: 0,
        lastProbeMs: 0,
        lastVerdict: null,
        degraded: null,
        reloadPending: false,
        recoveryCount: 0,
        nextProbeAt: 0,
        recoveryAt: 0,
      };
      this.states.set(t.model, st);
    }
    st.backend = t.backend;
    return st;
  }

  private view(st: ModelState): ModelHealth {
    return {
      model: st.model,
      backend: st.backend,
      health: st.degraded === null ? "ok" : "degraded",
      failures: st.failures,
      clean: st.clean,
      probes: st.probes,
      lastProbeAt: st.lastProbeAt,
      lastProbeMs: st.lastProbeMs,
      lastVerdict: st.lastVerdict,
      degraded: st.degraded,
      reloadPending: st.reloadPending,
      recoveryCount: st.recoveryCount,
    };
  }
}
