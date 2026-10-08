/**
 * hearth.yaml, edited by section or as text. Every save is reviewed first: a dry run returns the
 * file it would write, shown as a diff with what needs a restart, and only then is it written.
 */
import { Plus, RotateCcw, Save, Trash2, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { lineDiff, opsBetween, type Op } from "./diff.js";
import { request, RequestError, toast, useStore } from "./store.js";
import { Button, Card, cx, mono, Pill, Switch } from "./ui.js";

type File = { text: string; hash: string; doc: Record<string, unknown> | null };
type Plan = { before: string; after: string; restartPending: string[]; commit: () => Promise<void> };
type Err = { message: string; path: string | null };

/** The sections, in the order an operator reaches for them; anything else at the top level is "Node". */
const SECTIONS: { key: string; label: string; hint: string; item?: unknown; entry?: unknown }[] = [
  { key: "backends", label: "Backends", hint: "Servers hearth fronts. A backend is its own queue.", item: { name: "", url: "http://127.0.0.1:", kind: "llama-swap", resources: [] } },
  { key: "resources", label: "Hardware", hint: "Cards and CPUs. Backends on the same exclusive card take turns.", entry: { kind: "gpu" } },
  { key: "models", label: "Models & routes", hint: "Per-model routing, aliases, slots and parameters.", entry: { policy: "local" } },
  { key: "scheduler", label: "Lanes & queues", hint: "Lane priorities and ceilings, queue limits." },
  { key: "peers", label: "Peers", hint: "Other hearth nodes and which of their models you borrow.", item: { name: "", url: "http://", token: "env:", models: {} } },
  { key: "node", label: "Node", hint: "Name, listen addresses, sharing, deadlines and limits." },
];
const OWN = new Set(SECTIONS.map((s) => s.key).filter((k) => k !== "node"));
const ENUMS: Record<string, string[]> = {
  kind: ["llama-swap", "ollama", "single", "none", "gpu", "cpu", "other"],
  policy: ["local", "peer", "spillover", "fastest"],
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const fmt = (path: (string | number)[]) => path.map((p, i) => (typeof p === "number" ? `[${p}]` : i ? `.${p}` : p)).join("");
const INPUT = "h-8 w-full rounded-md border bg-bg px-2 text-[12px] focus:border-accent focus:outline-none";

/** What a secret reads back as from the server; the hint is what steers a plaintext one to `env:`. */
const STANDIN = /^hearth-secret\d+$/;
function secretHint(name: string, v: unknown): string | null {
  // An apiKeys entry is a bare key or {key, label, models}; the secret sits in the same place either way.
  const vals = Array.isArray(v) ? v.flatMap((x) => (isObj(x) ? [x.key] : [x])) : isObj(v) ? Object.values(v) : [v];
  if (vals.some((x) => typeof x === "string" && STANDIN.test(x))
      && (name === "apiKeys" || name === "peerTokens" || name === "token" || name === "key")) {
    return "stored in the file in plain text — `env:NAME` keeps it out of hearth.yaml";
  }
  return null;
}

/** A list of scalars as one line: edit freely, commit on Enter or blur — so `a, b` is typeable at all. */
function ListInput({ v, onChange, bad }: { v: string[]; onChange: (v: string[]) => void; bad: boolean }) {
  const [raw, setRaw] = useState(() => v.join(", "));
  useEffect(() => { setRaw(v.join(", ")); }, [v]);
  const commit = () => {
    const next = raw.split(",").map((x) => x.trim()).filter(Boolean);
    if (next.length === v.length && next.every((x, i) => x === v[i])) { setRaw(v.join(", ")); return; }
    onChange(next);
  };
  return (
    <input className={cx(INPUT, mono, bad ? "border-bad" : "border-line")} value={raw} placeholder="a, b, c"
           onChange={(e) => setRaw(e.target.value)}
           onKeyDown={(e) => e.key === "Enter" && commit()}
           onBlur={commit} />
  );
}

function Scalar({ name, v, onChange, bad }: { name: string; v: unknown; onChange: (v: unknown) => void; bad: boolean }) {
  const base = cx(INPUT, bad ? "border-bad" : "border-line");
  if (typeof v === "boolean") return <Switch label={name} on={v} onChange={onChange} />;
  if (typeof v === "number" || v === null)
    return <input type="number" className={cx(base, "tabular w-40")} value={v ?? ""} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />;
  const kinds = ENUMS[name];
  if (kinds && typeof v === "string") {
    const opts = name === "kind" && ["gpu", "cpu", "other"].includes(v) ? ["gpu", "cpu", "other"] : name === "kind" ? kinds.slice(0, 4) : kinds;
    return <select className={cx(base, "w-40")} value={v} onChange={(e) => onChange(e.target.value)}>{opts.map((o) => <option key={o}>{o}</option>)}</select>;
  }
  if (Array.isArray(v)) {
    return <ListInput v={v as string[]} onChange={onChange} bad={bad} />;
  }
  return <input className={cx(base, mono)} value={v === null || v === undefined ? "" : String(v)} onChange={(e) => onChange(e.target.value)} />;
}

/** Any value: maps as labelled rows, lists of maps as cards, scalars and scalar lists as inputs. */
function Value({ name, v, path, onChange, err, entry }: {
  name: string; v: unknown; path: (string | number)[]; onChange: (v: unknown) => void; err: Err | null; entry?: unknown;
}): ReactNode {
  const bad = err?.path === fmt(path);
  if (isObj(v)) {
    return <Obj v={v} path={path} onChange={onChange} err={err} entry={entry} />;
  }
  if (Array.isArray(v) && v.some(isObj)) {
    return (
      <div className="flex flex-col gap-2">
        {v.map((item, i) => (
          <Card key={i} className={cx("p-3", err?.path?.startsWith(fmt([...path, i])) && "border-bad")}>
            <div className="mb-1 flex items-center">
              <span className="font-medium">{isObj(item) && typeof item.name === "string" ? item.name || "new" : `#${i + 1}`}</span>
              <button className="ml-auto text-dim hover:text-bad" aria-label="remove" onClick={() => onChange(v.filter((_, k) => k !== i))}><Trash2 size={14} /></button>
            </div>
            <Value name={name} v={item} path={[...path, i]} err={err} onChange={(n) => onChange(v.map((x, k) => (k === i ? n : x)))} />
          </Card>
        ))}
      </div>
    );
  }
  return (
    <div>
      <Scalar name={name} v={v} onChange={onChange} bad={bad} />
      {bad && <div className="mt-1 text-[11px] text-bad">{err!.message}</div>}
      {!bad && secretHint(name, v) && <div className="mt-1 text-[11px] text-warn">{secretHint(name, v)}</div>}
    </div>
  );
}

function Obj({ v, path, onChange, err, entry }: {
  v: Record<string, unknown>; path: (string | number)[]; onChange: (v: unknown) => void; err: Err | null; entry?: unknown;
}) {
  const [adding, setAdding] = useState("");
  const add = () => {
    const k = adding.trim();
    if (!k || k in v) return;
    onChange({ ...v, [k]: entry !== undefined ? structuredClone(entry) : "" });
    setAdding("");
  };
  return (
    <div className="flex flex-col">
      {Object.entries(v).map(([k, x]) => (
        <div key={k} className="group flex items-start gap-3 border-b border-line/50 py-1.5 last:border-0">
          <div className={cx("w-40 shrink-0 pt-1.5 text-dim", mono)}>{k}</div>
          <div className="min-w-0 flex-1">
            {/* A cleared field becomes null in the draft, which opsBetween turns into a key deletion. */}
            <Value name={k} v={x} path={[...path, k]} err={err} onChange={(n) => onChange({ ...v, [k]: n })} />
          </div>
          <button className="pt-2 text-dim opacity-0 hover:text-bad group-hover:opacity-100" aria-label={`remove ${k}`}
                  onClick={() => { const { [k]: _, ...rest } = v; onChange(rest); }}><X size={13} /></button>
        </div>
      ))}
      <div className="flex items-center gap-2 pt-2">
        <input value={adding} onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()}
               placeholder={entry !== undefined ? "add an entry…" : "add a field…"}
               className={cx("h-7 w-48 rounded-md border border-dashed border-line bg-transparent px-2 text-[12px] focus:border-accent focus:outline-none", mono)} />
        {adding && <Button onClick={add}><Plus size={12} />add</Button>}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- review */

function Review({ plan, onClose }: { plan: Plan; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const lines = lineDiff(plan.before, plan.after);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-6" onClick={onClose}>
      <Card className="flex max-h-[85vh] w-full max-w-3xl flex-col shadow-2xl">
        <div className="flex items-center gap-3 border-b border-line px-4 py-3" onClick={(e) => e.stopPropagation()}>
          <span className="font-semibold">Review changes to hearth.yaml</span>
          {plan.restartPending.length ? <Pill tone="warn">restart to apply {plan.restartPending.join(", ")}</Pill> : <Pill tone="ok">applies live</Pill>}
          <button className="ml-auto text-dim hover:text-fg" onClick={onClose} aria-label="close"><X size={16} /></button>
        </div>
        <pre className="min-h-0 flex-1 overflow-auto px-0 py-2 font-mono text-[12px] leading-5" onClick={(e) => e.stopPropagation()}>
          {lines.map((l, i) => (
            <div key={i} className={cx("px-4", l.kind === "+" && "bg-ok/10 text-ok", l.kind === "-" && "bg-bad/10 text-bad", l.kind === "…" && "text-dim")}>
              {l.kind === "…" ? "  ⋯" : `${l.kind} ${l.text}`}
            </div>
          ))}
        </pre>
        <div className="flex justify-end gap-2 border-t border-line px-4 py-3" onClick={(e) => e.stopPropagation()}>
          <Button onClick={onClose}>keep editing</Button>
          <Button tone="primary" disabled={busy} onClick={() => { setBusy(true); void plan.commit().finally(() => setBusy(false)); }}>
            <Save size={13} />save
          </Button>
        </div>
      </Card>
    </div>
  );
}

/* ---------------------------------------------------------------- page */

export function Config() {
  const status = useStore((s) => s.data!.config);
  const [file, setFile] = useState<File | null>(null);
  const [tab, setTab] = useState<string>("backends");
  const [drafts, setDrafts] = useState<Record<string, unknown>>({});
  const [text, setText] = useState("");
  const [err, setErr] = useState<Err | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);

  const load = async () => {
    try {
      const f = await request<File>("GET", "/config");
      setFile(f);
      setText(f.text);
      setDrafts({});
      setErr(null);
    } catch (e) {
      setErr({ message: e instanceof Error ? e.message : String(e), path: null });
    }
  };
  useEffect(() => { void load(); }, []);
  const dirty = Object.keys(drafts).length > 0 || (file !== null && text !== file.text);
  // An edit made elsewhere moves the hash; follow it unless there is unsaved work here.
  useEffect(() => { if (file && status.hash !== file.hash && !dirty) void load(); }, [status.hash]);

  const doc = file?.doc ?? {};
  const nodeOf = (d: Record<string, unknown>) => Object.fromEntries(Object.entries(d).filter(([k]) => !OWN.has(k)));
  const original = (key: string) => (key === "node" ? nodeOf(doc) : doc[key]);
  const current = (key: string) => (key in drafts ? drafts[key] : original(key));

  /** Dry-run, show the diff, and write only on confirm. */
  const review = async (body: { ops?: Op[]; text?: string }) => {
    if (!file) return;
    try {
      const dry = await request<{ text: string; restartPending: string[] }>("PATCH", "/config", { baseHash: file.hash, ...body, dryRun: true });
      setErr(null);
      setPlan({
        before: file.text, after: dry.text, restartPending: dry.restartPending,
        commit: async () => {
          try {
            const out = await request<{ restartPending: string[] }>("PATCH", "/config", { baseHash: file.hash, ...body });
            toast("ok", out.restartPending.length ? `saved — restart to apply ${out.restartPending.join(", ")}` : "saved and applied");
            setPlan(null);
            await load();
          } catch (e) {
            setPlan(null);
            setErr({ message: e instanceof Error ? e.message : String(e), path: e instanceof RequestError ? e.path : null });
          }
        },
      });
    } catch (e) {
      setErr({ message: e instanceof Error ? e.message : String(e), path: e instanceof RequestError ? e.path : null });
    }
  };
  const saveSection = (key: string) => {
    const ops = key === "node" ? opsBetween(original("node"), drafts.node) : opsBetween(original(key), drafts[key], [key]);
    if (ops.length) void review({ ops });
  };
  const sec = SECTIONS.find((s) => s.key === tab);

  return (
    <div className="flex h-full flex-col gap-3">
      <Card className="flex flex-wrap items-center gap-3 px-4 py-3">
        {status.error ? <Pill tone="bad">does not load</Pill> : status.restartPending.length ? <Pill tone="warn">restart needed</Pill> : <Pill tone="ok">applied</Pill>}
        <span className={mono}>{status.path ?? "in memory — no config file"}</span>
        {status.restartPending.length > 0 && <span className="text-warn">restart hearth to apply: {status.restartPending.join(", ")}</span>}
        {status.error && <span className="w-full text-bad">{status.error} — the node keeps running the last config that loaded.</span>}
      </Card>
      {status.path && file && (
        <div className="flex min-h-0 flex-1 gap-3">
          <nav className="flex w-44 shrink-0 flex-col gap-0.5">
            {[...SECTIONS.map((s) => ({ key: s.key, label: s.label })), { key: "yaml", label: "hearth.yaml" }].map((s) => (
              <button key={s.key} onClick={() => setTab(s.key)}
                      className={cx("flex h-8 items-center rounded-lg px-3 text-left", tab === s.key ? "bg-muted font-medium" : "text-dim hover:bg-muted/60 hover:text-fg",
                        s.key === "yaml" && "mt-2 font-mono text-[12px]")}>
                {s.label}{s.key in drafts && <span className="ml-auto size-1.5 rounded-full bg-accent" />}
              </button>
            ))}
          </nav>
          <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
              <div>
                <div className="font-medium">{sec?.label ?? "hearth.yaml"}</div>
                <div className="text-[11px] text-dim">{sec?.hint ?? "The whole file, comments and all. ⌘S reviews and saves."}</div>
              </div>
              <div className="ml-auto flex gap-2">
                {sec ? (
                  <>
                    <Button disabled={!(tab in drafts)} onClick={() => { const { [tab]: _, ...rest } = drafts; setDrafts(rest); setErr(null); }}><RotateCcw size={13} />revert</Button>
                    <Button tone="primary" disabled={!(tab in drafts)} onClick={() => saveSection(tab)}><Save size={13} />review & save</Button>
                  </>
                ) : (
                  <>
                    <Button disabled={text === file.text} onClick={() => setText(file.text)}><RotateCcw size={13} />revert</Button>
                    <Button tone="primary" disabled={text === file.text} onClick={() => void review({ text })}><Save size={13} />review & save</Button>
                  </>
                )}
              </div>
            </div>
            {err && <div className="border-b border-line bg-bad/10 px-4 py-2 text-bad">{err.message}</div>}
            {sec ? (
              <div className="min-h-0 flex-1 overflow-auto p-4">
                {current(tab) === undefined ? (
                  <Button onClick={() => setDrafts({ ...drafts, [tab]: sec.item ? [] : {} })}><Plus size={13} />add a {sec.label.toLowerCase()} section</Button>
                ) : (
                  <>
                    <Value name={tab} v={current(tab)} path={tab === "node" ? [] : [tab]} err={err} entry={sec.entry}
                           onChange={(n) => setDrafts({ ...drafts, [tab]: n })} />
                    {sec.item !== undefined && (
                      <div className="mt-3"><Button onClick={() => setDrafts({ ...drafts, [tab]: [...((current(tab) as unknown[]) ?? []), structuredClone(sec.item)] })}>
                        <Plus size={13} />add {sec.label.toLowerCase().replace(/s$/, "")}
                      </Button></div>
                    )}
                  </>
                )}
              </div>
            ) : (
              <textarea spellCheck={false} value={text} onChange={(e) => setText(e.target.value)}
                        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); if (text !== file.text) void review({ text }); } }}
                        className="min-h-0 flex-1 resize-none bg-transparent p-4 font-mono text-[12px] leading-5 outline-none" />
            )}
          </Card>
        </div>
      )}
      {plan && <Review plan={plan} onClose={() => setPlan(null)} />}
    </div>
  );
}
