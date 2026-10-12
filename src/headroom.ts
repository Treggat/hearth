/**
 * A Headroom server run beside this node makes a request smaller before it is sent: long tool
 * results, logs and files in the conversation are compressed, the system prompt and tools are not
 * read. Only the conversation goes to it; the backend's key never does.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

import { getJson, send } from "./upstream.js";

type Doc = Record<string, unknown>;

export interface HeadroomConfig {
  /** The backends whose conversations are compressed before they are sent. */
  backends: string[];
  /** A Headroom server run by hand, used in place of the one installed from the console; null is the installed one. */
  url: string | null;
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
export async function compress(body: Doc, h: { url: string; token: string | null; timeoutMs: number }, who: string, maxBytes: number, signal?: AbortSignal): Promise<Compressed> {
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

/** The release the console installs. A newer one is a change to this line, tried before it is made. */
export const HEADROOM_VERSION = "0.40.0";

/** What the console is told about the Headroom this node installed and runs. */
export interface HostView {
  /** `absent`: not installed. `installing`, `starting`, `removing`: on its way. `running`: answering. `failed`: installed, and not running. */
  state: "absent" | "installing" | "starting" | "running" | "failed" | "removing";
  /** The release that is installed. */
  version?: string;
  /** Why it is not running, or why the install stopped. */
  problem?: string;
  /** The last lines the install or the server wrote. */
  lines: string[];
  /** Whether this node has somewhere to install it: it is kept beside the config file. */
  can: boolean;
}

const KEPT_LINES = 60;
const win = process.platform === "win32";

/** Hands each whole line a program writes to `say`. */
function lines(child: ChildProcess, say: (line: string) => void): void {
  for (const out of [child.stdout, child.stderr]) {
    let held = "";
    out?.setEncoding("utf8").on("data", (c: string) => {
      const got = (held + c).split(/\r?\n/);
      held = got.pop() ?? "";
      for (const l of got) if (l.trim() !== "") say(l);
    });
  }
}

/** Runs one program to its end. Never a shell: the arguments go as they are. */
function run(cmd: string, args: string[], say: (line: string) => void, hold?: (child: ChildProcess) => void): Promise<number> {
  return new Promise((done) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch {
      return done(-1);
    }
    hold?.(child);
    lines(child, say);
    child.on("error", () => done(-1));
    child.on("close", (code) => done(code ?? -1));
  });
}

/** A port nothing is listening on, on this machine. */
const freePort = (): Promise<number> => new Promise((done, fail) => {
  const s = createServer();
  s.once("error", fail).listen(0, "127.0.0.1", () => {
    const { port } = s.address() as { port: number };
    s.close(() => done(port));
  });
});

/**
 * The Headroom this node installs, runs and removes at the operator's word. It lives in one
 * directory beside the config file: a Python environment of its own with one release in it. The
 * server listens on this machine only, on a port chosen as it starts, and reports nothing home.
 */
export class HeadroomHost {
  private state: HostView["state"] = "absent";
  private problem: string | undefined;
  private said: string[] = [];
  private child: ChildProcess | null = null;
  private port = 0;
  /** Counts starts and stops, so one that was overtaken does nothing more. */
  private turn = 0;
  private again: ReturnType<typeof setTimeout> | null = null;
  private fails = 0;

  constructor(private readonly dir: string | null, private readonly log: { info: (msg: string, f?: Doc) => void; warn: (msg: string, f?: Doc) => void }) {}

  private get python(): string {
    return join(this.dir!, "venv", win ? "Scripts" : "bin", win ? "python.exe" : "python");
  }

  /** The release on disk, or null when there is none. */
  private installed(): string | null {
    if (this.dir === null) return null;
    try {
      const v = (JSON.parse(readFileSync(join(this.dir, "installed.json"), "utf8")) as Doc).version;
      return typeof v === "string" && existsSync(this.python) ? v : null;
    } catch {
      return null;
    }
  }

  private say = (line: string): void => {
    this.said = [...this.said, line.slice(0, 300)].slice(-KEPT_LINES);
  };

  view(): HostView {
    const version = this.installed();
    return { state: this.state, ...(version ? { version } : {}), ...(this.problem ? { problem: this.problem } : {}), lines: this.said, can: this.dir !== null };
  }

  /** Where it answers, while it does. */
  url(): string | null {
    return this.state === "running" ? `http://127.0.0.1:${this.port}` : null;
  }

  /** Why a request cannot be compressed by it right now. */
  why(): string {
    if (this.state === "absent") return "is not installed";
    if (this.state === "failed") return `is not running: ${this.problem ?? "it stopped"}`;
    return `is ${this.state}`;
  }

  private fail(problem: string): void {
    this.state = this.installed() === null ? "absent" : "failed";
    this.problem = problem;
    this.say(problem);
    this.log.warn("headroom.host_failed", { error: problem });
  }

  /** A Python that can hold it, by the names one goes under. */
  private async findPython(): Promise<string[] | null> {
    for (const c of win ? [["python"], ["py", "-3"], ["python3"]] : [["python3"], ["python"]]) {
      let ok = false;
      await run(c[0]!, [...c.slice(1), "-c", "import sys; print('py-ok' if sys.version_info >= (3, 10) else 'py-old')"], (l) => { if (l.trim() === "py-ok") ok = true; });
      if (ok) return c;
    }
    return null;
  }

  /** Installs it and starts it. Returns at once; `view()` says how it is going. */
  install(): void {
    if (this.dir === null || this.state === "installing" || this.state === "starting" || this.state === "removing") return;
    if (this.installed() !== null) return void this.start();
    const dir = this.dir;
    this.state = "installing";
    this.problem = undefined;
    this.said = [];
    const turn = ++this.turn;
    const hold = (c: ChildProcess): void => { this.child = c; };
    void (async () => {
      const python = await this.findPython();
      if (turn !== this.turn) return;
      if (python === null) return this.fail("Python 3.10 or newer was not found on this machine, and Headroom is a Python program");
      mkdirSync(dir, { recursive: true });
      this.say("making its Python environment");
      const made = await run(python[0]!, [...python.slice(1), "-m", "venv", join(dir, "venv")], this.say, hold);
      if (turn !== this.turn) return;
      if (made !== 0) return this.fail("its Python environment could not be made");
      this.say(`installing headroom-ai ${HEADROOM_VERSION}: several hundred megabytes, so this takes minutes`);
      const code = await run(this.python, ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--progress-bar", "off", `headroom-ai[proxy]==${HEADROOM_VERSION}`], this.say, hold);
      if (turn !== this.turn) return;
      this.child = null;
      if (code !== 0) return this.fail("the install did not finish; the lines above say why");
      writeFileSync(join(dir, "installed.json"), JSON.stringify({ version: HEADROOM_VERSION }));
      this.log.info("headroom.installed", { version: HEADROOM_VERSION });
      this.state = "failed";
      this.start();
    })().catch((e) => this.fail(String(e instanceof Error ? e.message : e)));
  }

  /** Starts what is installed; does nothing when nothing is. */
  start(): void {
    if (this.dir === null || this.installed() === null || this.state === "starting" || this.state === "running" || this.state === "installing" || this.state === "removing") return;
    const dir = this.dir;
    this.state = "starting";
    this.problem = undefined;
    const turn = ++this.turn;
    void (async () => {
      this.port = await freePort();
      if (turn !== this.turn) return;
      const child = spawn(this.python, ["-c", "from headroom.cli import main; main()", "proxy", "--host", "127.0.0.1", "--port", String(this.port), "--no-telemetry"], {
        stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
        env: { ...process.env, HEADROOM_BEACON: "off", DO_NOT_TRACK: "1", HEADROOM_UPDATE_CHECK: "off", HEADROOM_CONFIG_DIR: join(dir, "state") },
      });
      this.child = child;
      // Each request it serves is a line; those would push out the ones that say how it is.
      lines(child, (l) => { if (!l.includes("proxy_inbound_")) this.say(l); });
      const ended = (why: string): void => {
        if (turn !== this.turn) return;
        this.turn++;
        this.child = null;
        this.fail(why);
        // It is meant to be running: tried again, a little later each time it will not stay up.
        this.again = setTimeout(() => this.start(), Math.min(60_000, 5_000 * 2 ** this.fails++));
        this.again.unref();
      };
      child.on("error", (e) => ended(e.message));
      child.on("exit", (code) => ended(`it stopped (exit ${code ?? "?"})`));
      // Its first start loads what it compresses with, which is slow from a cold disk.
      for (let waited = 0; waited < 180_000 && turn === this.turn; waited += 1000) {
        try {
          await getJson(`http://127.0.0.1:${this.port}/health`, { headersTimeoutMs: 2000 });
          if (turn !== this.turn) return;
          this.state = "running";
          this.fails = 0;
          this.log.info("headroom.running", { port: this.port });
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      if (turn === this.turn) child.kill();
    })().catch((e) => this.fail(String(e instanceof Error ? e.message : e)));
  }

  /** Stops it, and whatever install is under way. What is on disk stays. */
  stop(): void {
    this.turn++;
    if (this.again) clearTimeout(this.again);
    this.again = null;
    this.child?.kill();
    this.child = null;
    this.state = this.installed() === null ? "absent" : "failed";
    this.problem = this.state === "failed" ? "it was stopped" : undefined;
  }

  /** Stops it and removes everything that was installed for it. Returns at once; `view()` says when it is gone. */
  uninstall(): void {
    if (this.dir === null || this.state === "removing") return;
    this.stop();
    this.state = "removing";
    this.problem = undefined;
    this.said = [];
    // The directory is this node's own: install() made it, and nothing else is kept there. It is
    // thousands of files, and one may still be held for a moment by the server that was just stopped.
    rm(this.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }).then(() => {
      this.state = "absent";
      this.log.info("headroom.uninstalled");
    }, (e: unknown) => this.fail(`it could not be removed: ${String(e instanceof Error ? e.message : e)}`));
  }
}
