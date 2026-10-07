/** The pages beside the topology, and the inspector sheet that opens over it. */
import { Check, RotateCcw, Save, X } from "lucide-react";
import { useEffect, useState } from "react";

import type { UiData } from "../ui/types.js";
import { control, request, RequestError, select, toast, useStore } from "./store.js";
import { ago, Button, Card, cx, Empty, mono, Pill, Switch, type Tone } from "./ui.js";

const selfOf = (d: UiData) => d.net.nodes.find((n) => n.self)!;
const canWrite = (d: UiData) => d.canWarm;

/* ------------------------------------------------------------- inspector */

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <div className="w-24 shrink-0 text-dim">{k}</div>
      <div className="min-w-0 flex-1 break-words">{children}</div>
    </div>
  );
}

export function Inspector() {
  const d = useStore((s) => s.data)!;
  const sel = useStore((s) => s.sel);
  if (!sel) return null;
  const self = selfOf(d);
  let title = sel.id;
  let body: React.ReactNode = null;

  if (sel.kind === "self") {
    body = (
      <>
        <Row k="lending"><Switch label="lending" disabled={!canWrite(d)} on={d.controls.lending} onChange={(on) => void control({ lending: on }, on ? "lending resumed" : "lending paused")} /></Row>
        <Row k="borrowing"><Switch label="borrowing" disabled={!canWrite(d)} on={d.controls.borrowing} onChange={(on) => void control({ borrowing: on }, on ? "borrowing resumed" : "borrowing paused")} /></Row>
        <p className="mt-2 text-[11px] text-dim">Pausing applies at once and is not written to the config; a restart clears it.</p>
        <Row k="lent">{d.share.length ? d.share.join(", ") : "nothing"}</Row>
      </>
    );
  } else if (sel.kind === "backend") {
    const b = (self.backends ?? []).find((x) => x.name === sel.id);
    if (b) body = (
      <>
        <Row k="kind">{b.kind}{b.evicts ? " · swaps models" : ""}</Row>
        <Row k="address"><span className={mono}>{b.url}</span></Row>
        <Row k="slots"><span className="tabular">{(b.slots ?? 0) - (b.free ?? 0)} of {b.slots ?? 0} busy · {b.queued ?? 0} queued</span></Row>
        <Row k="hardware">{(b.resources ?? []).join(", ") || "none declared"}</Row>
        <Row k="loaded">{(b.loaded ?? []).join(", ") || (b.knowsWarm === false ? "cannot tell" : "nothing")}</Row>
        {(b.routes ?? []).length > 0 && <Row k="paths">{b.routes!.map((r) => <div key={r.path} className={mono}>{r.path}</div>)}</Row>}
        <Row k="serves">{(b.serves ?? []).join(", ")}</Row>
      </>
    );
  } else if (sel.kind === "peer") {
    const p = d.net.nodes.find((n) => n.name === sel.id);
    if (p) body = (
      <>
        <Row k="status">{p.up ? <Pill tone="ok">up</Pill> : <Pill tone="bad">down</Pill>}</Row>
        {!p.up && p.lastError && <Row k="last error"><span className="text-bad">{p.lastError}</span></Row>}
        <Row k="capacity"><span className="tabular">{p.free ?? "?"} of {p.slots ?? "?"} free · {p.queued ?? "?"} queued</span></Row>
        <Row k="links">
          {Object.entries(p.map ?? {}).length === 0 ? "nothing borrowed" : Object.entries(p.map ?? {}).map(([mine, theirs]) => (
            <div key={mine} className="flex items-center gap-2">
              <span className={mono}>{mine}{theirs !== mine ? ` → ${theirs}` : ""}</span>
              {canWrite(d) && (
                <button className="ml-auto text-dim hover:text-bad" aria-label={`unlink ${mine}`}
                        onClick={() => void control({ unlink: { peer: p.name, mine } }, `unlinked ${mine}`)}>
                  <X size={14} />
                </button>
              )}
            </div>
          ))}
        </Row>
        {(p.unmapped ?? []).length > 0 && (
          <Row k="also serves">
            {p.unmapped!.map((m) => (
              <div key={m} className="flex items-center gap-2">
                <span className={mono}>{m}</span>
                {canWrite(d) && (
                  <button className="ml-auto text-[11px] text-accent hover:underline"
                          onClick={() => void control({ link: { peer: p.name, mine: m, theirs: m } }, `linked ${m}`)}>link</button>
                )}
              </div>
            ))}
          </Row>
        )}
      </>
    );
  } else {
    const r = (d.net.resources ?? []).find((x) => x.name === sel.id);
    if (r) body = (
      <>
        <Row k="kind">{r.kind ?? "gpu"}{r.shared ? " · shared, not arbitrated" : ""}</Row>
        <Row k="holder">{r.holder ?? "free"}</Row>
        <Row k="backends">{r.backends.join(", ")}</Row>
      </>
    );
    title = sel.id;
  }

  return (
    <aside className="absolute inset-y-3 right-3 z-10 w-[340px] overflow-auto rounded-xl border border-line bg-panel p-4 shadow-xl">
      <div className="mb-2 flex items-center">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-dim">{sel.kind === "self" ? "this node" : sel.kind}</div>
          <div className="text-base font-semibold">{title}</div>
        </div>
        <button className="ml-auto text-dim hover:text-fg" aria-label="close" onClick={() => select(null)}><X size={16} /></button>
      </div>
      {body ?? <Empty>gone</Empty>}
    </aside>
  );
}

/* ---------------------------------------------------------------- models */

function NoteCell({ model, note, editable }: { model: string; note: string; editable: boolean }) {
  const [draft, setDraft] = useState(note);
  useEffect(() => setDraft(note), [note]);
  if (!editable) return <span className="text-dim">{note}</span>;
  const commit = () => {
    if (draft.trim() === note.trim()) return;
    void control({ notes: { [model]: draft.trim() === "" ? null : draft } }, "note saved");
  };
  return (
    <input
      value={draft} placeholder="add a note peers will see"
      onChange={(e) => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setDraft(note); }}
      className="w-full rounded-md border border-transparent bg-transparent px-1.5 py-1 text-[12px] hover:border-line focus:border-accent focus:outline-none"
    />
  );
}

export function Models() {
  const d = useStore((s) => s.data)!;
  const self = selfOf(d);
  const local = new Set(d.catalog);
  const ids = [...new Set([...d.catalog, ...d.net.available])].sort();
  const where = (m: string) => {
    const out: string[] = [];
    for (const b of self.backends ?? []) if ((b.serves ?? []).includes(m)) out.push(b.name);
    for (const p of d.net.nodes) if (!p.self && (p.serves ?? []).includes(m)) out.push(`${p.name} (peer)`);
    return out;
  };
  const state = (m: string): [Tone, string] =>
    d.net.readyNow.includes(m) ? ["ok", "warm"] : (d.net.unknownWarm ?? []).includes(m) ? ["dim", "unknown"] : ["info", "cold"];
  return (
    <Card className="overflow-hidden">
      <table className="w-full text-left">
        <thead className="border-b border-line bg-muted/50 text-[11px] uppercase tracking-wide text-dim">
          <tr>
            <th className="px-4 py-2 font-medium">model</th>
            <th className="px-2 py-2 font-medium">state</th>
            <th className="px-2 py-2 font-medium">served by</th>
            <th className="px-2 py-2 font-medium">context</th>
            <th className="px-2 py-2 font-medium">lent</th>
            <th className="w-[34%] px-2 py-2 font-medium">note</th>
          </tr>
        </thead>
        <tbody>
          {ids.map((m) => {
            const [tone, word] = state(m);
            const stats = self.stats?.[m];
            const lent = d.configuredShare.includes(m);
            return (
              <tr key={m} className="border-b border-line/60 last:border-0 hover:bg-muted/40">
                <td className={cx("px-4 py-2", mono)}>{m}</td>
                <td className="px-2 py-2"><Pill tone={tone}>{word}</Pill></td>
                <td className="px-2 py-2 text-dim">{where(m).join(", ")}</td>
                <td className="tabular px-2 py-2 text-dim">{stats?.context ? `${Math.round(stats.context / 1024)}k` : "—"}</td>
                <td className="px-2 py-2">
                  {local.has(m)
                    ? <Switch label={`lend ${m}`} disabled={!canWrite(d)} on={lent} onChange={(on) => void control({ share: { [m]: on } }, on ? `lending ${m}` : `holding ${m}`)} />
                    : <span className="text-dim">—</span>}
                </td>
                <td className="px-2 py-1">{local.has(m) ? <NoteCell model={m} note={stats?.note ?? ""} editable={canWrite(d)} /> : null}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {ids.length === 0 && <Empty>No models yet — backends report theirs once reachable.</Empty>}
    </Card>
  );
}

/* ----------------------------------------------------------------- queue */

export function Queue() {
  const jobs = useStore((s) => s.data!.q.jobs);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const rows = [...jobs].sort((a, b) => (a.state === b.state ? a.since - b.since : a.state === "running" ? -1 : 1));
  return (
    <Card className="overflow-hidden">
      <table className="w-full text-left">
        <thead className="border-b border-line bg-muted/50 text-[11px] uppercase tracking-wide text-dim">
          <tr>{["state", "model", "lane", "caller", "where", "time"].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((j) => (
            <tr key={j.id} className="border-b border-line/60 last:border-0">
              <td className="px-4 py-2">{j.state === "running" ? <Pill tone="accent" pulse>running</Pill> : <Pill tone="dim">#{j.position + 1} queued</Pill>}</td>
              <td className={cx("px-4 py-2", mono)}>{j.model}</td>
              <td className="px-4 py-2">{j.lane}</td>
              <td className="px-4 py-2 text-dim">{j.caller}</td>
              <td className="px-4 py-2 text-dim">{j.offbox ? `${j.peer} (peer)` : j.backend}</td>
              <td className="tabular px-4 py-2 text-dim">{ago(j.since)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <Empty>Nothing queued or running.</Empty>}
    </Card>
  );
}

/* ---------------------------------------------------------------- config */

export function Config() {
  const status = useStore((s) => s.data!.config);
  const [file, setFile] = useState<{ text: string; hash: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<{ message: string; path: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const f = await request<{ text: string; hash: string }>("GET", "/config");
      setFile(f);
      setDraft(f.text);
      setErr(null);
    } catch (e) {
      setErr({ message: e instanceof Error ? e.message : String(e), path: null });
    }
  };
  useEffect(() => { void load(); }, []);
  // A save elsewhere (a toggle, a hand edit) moves the hash; reload unless this editor has unsaved text.
  useEffect(() => {
    if (file && status.hash !== file.hash && draft === file.text) void load();
  }, [status.hash]);

  const dirty = file !== null && draft !== file.text;
  const save = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const out = await request<{ text: string; hash: string; restartPending: string[] }>("PATCH", "/config", { baseHash: file.hash, text: draft });
      setFile({ text: out.text, hash: out.hash });
      setErr(null);
      toast("ok", out.restartPending.length ? `saved — restart to apply ${out.restartPending.join(", ")}` : "saved and applied");
    } catch (e) {
      setErr({ message: e instanceof Error ? e.message : String(e), path: e instanceof RequestError ? e.path : null });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-3">
      <Card className="flex flex-wrap items-center gap-3 px-4 py-3">
        {status.error ? <Pill tone="bad">does not load</Pill> : status.restartPending.length ? <Pill tone="warn">restart needed</Pill> : <Pill tone="ok">applied</Pill>}
        <span className={mono}>{status.path ?? "in memory — no config file"}</span>
        {status.savedAt && <span className="text-dim">last saved {new Date(status.savedAt).toLocaleTimeString()}</span>}
        {status.restartPending.length > 0 && <span className="text-warn">restart hearth to apply: {status.restartPending.join(", ")}</span>}
        {status.error && <span className="w-full text-bad">{status.error} — the node keeps running the last config that loaded.</span>}
      </Card>
      {status.path && (
        <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <span className="font-medium">hearth.yaml</span>
            <span className="text-dim">{dirty ? "edited — not saved" : "matches the file"}</span>
            <div className="ml-auto flex gap-2">
              <Button onClick={() => { if (file) setDraft(file.text); setErr(null); }} disabled={!dirty || busy}><RotateCcw size={13} />revert</Button>
              <Button tone="primary" onClick={() => void save()} disabled={!dirty || busy}>{busy ? <Check size={13} /> : <Save size={13} />}save</Button>
            </div>
          </div>
          {err && <div className="border-b border-line bg-bad/10 px-3 py-2 text-bad">{err.path ? <b className={mono}>{err.path}: </b> : null}{err.message}</div>}
          <textarea
            spellCheck={false} value={draft} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); if (dirty) void save(); } }}
            className="min-h-0 flex-1 resize-none bg-transparent p-4 font-mono text-[12px] leading-5 outline-none"
          />
        </Card>
      )}
    </div>
  );
}
