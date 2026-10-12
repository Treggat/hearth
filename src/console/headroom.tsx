/** The Headroom page: install it, remove it, and choose whose conversations it compresses. */
import { Cloud, Download, Server, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { request, RequestError, toast, useStore } from "./store.js";
import { Button, Card, cx, Dialog, Empty, mono, Pill, Switch, type Tone } from "./ui.js";

const SAYS: Record<string, { tone: Tone; text: string }> = {
  absent: { tone: "dim", text: "not installed" },
  installing: { tone: "info", text: "installing" },
  starting: { tone: "info", text: "starting" },
  running: { tone: "ok", text: "running" },
  failed: { tone: "bad", text: "not running" },
  removing: { tone: "info", text: "uninstalling" },
};

export function Headroom() {
  const h = useStore((s) => s.data!.headroom);
  const backends = useStore((s) => s.data!.net.nodes.find((n) => n.self)!.backends ?? []);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const tail = useRef<HTMLPreElement>(null);
  const lines = h?.lines ?? [];
  // The newest line is the one worth reading while it works.
  useEffect(() => { if (tail.current) tail.current.scrollTop = tail.current.scrollHeight; }, [lines.length]);
  if (!h) return <Card><Empty>This node does not report Headroom.</Empty></Card>;

  const ask = async (body: Record<string, unknown>, done?: string): Promise<void> => {
    setBusy(true);
    try {
      await request("POST", "/headroom", body);
      if (done) toast("ok", done);
    } catch (e) {
      toast("bad", e instanceof RequestError || e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };
  const working = h.state === "installing" || h.state === "starting" || h.state === "removing";
  const installed = h.version !== undefined;
  // One the file names is used in place of the installed one, whatever that one is doing.
  const ready = h.own !== undefined || h.state === "running";
  const says = SAYS[h.state] ?? SAYS.absent!;
  const saved = backends.reduce((n, b) => n + (b.headroom?.saved ?? 0), 0);
  // A provider's servers first: there every token sent is paid for.
  const rows = [...backends].sort((a, b) => Number(b.cloud ?? false) - Number(a.cloud ?? false) || a.name.localeCompare(b.name));

  return (
    <div className="flex flex-col gap-4">
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-start gap-4 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-medium">Headroom</span>
              <Pill tone={says.tone} pulse={working}>{says.text}</Pill>
              {installed && <span className={cx(mono, "text-dim")}>{h.version}</span>}
            </div>
            <div className="mt-1 max-w-3xl text-[12px] text-dim">
              Shortens the long tool results, logs and files in a conversation before it is sent to a backend, so fewer tokens are paid for.
              It is a separate program by other people, installed here only when you ask: a Python environment of its own beside the config file, several hundred megabytes, listening on this machine only and reporting nothing home.
              A model then reads the shortened text, not the original.
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {!installed
              ? <Button tone="primary" disabled={busy || working || !h.can} onClick={() => void ask({ action: "install" })}><Download size={14} />{h.state === "removing" ? "Uninstalling…" : working ? "Installing…" : "Install"}</Button>
              : <>
                  {h.state === "failed" && <Button disabled={busy} onClick={() => void ask({ action: "install" })}>Start</Button>}
                  <Button disabled={busy || h.state === "removing"} onClick={() => setRemoving(true)}><Trash2 size={14} />Uninstall</Button>
                </>}
          </div>
        </div>
        {!h.can && <div className="border-t border-line px-4 py-2 text-[12px] text-warn">This node was started without a config file, and Headroom is kept beside one.</div>}
        {h.own !== undefined && <div className="border-t border-line px-4 py-2 text-[12px] text-dim">Conversations are sent to the Headroom server at <span className={mono}>{h.own}</span>, named under <span className={mono}>headroom.url</span> in the config. The one installed here is not used while that is set.</div>}
        {h.problem && h.state !== "running" && <div className="border-t border-line px-4 py-2 text-[12px] text-bad">{h.problem}</div>}
        {lines.length > 0 && (working || h.state === "failed" || !installed) && (
          <pre ref={tail} className={cx(mono, "max-h-56 overflow-auto border-t border-line bg-muted/40 px-4 py-2 text-[11px] leading-relaxed text-dim")}>{lines.join("\n")}</pre>
        )}
      </Card>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-baseline gap-x-3 border-b border-line px-4 py-2.5">
          <div className="font-medium">Backends</div>
          <div className="text-[11px] text-dim">Whose conversations are compressed. A switch takes effect at once, with no restart.</div>
          {saved > 0 && <div className="ml-auto text-[11px] text-dim">{saved.toLocaleString()} tokens saved since this node started</div>}
        </div>
        {rows.length === 0 ? <Empty>No backends are configured.</Empty> : (
          <div>
              {rows.map((b) => {
                const on = h.backends.includes(b.name);
                return (
                  <div key={b.name} className="flex items-center border-b border-line last:border-0">
                    <div className="shrink-0 py-2.5 pl-4">
                      {/* Off can always be had; on only when there is something to compress with. */}
                      <Switch on={on} disabled={busy || (!on && !ready)} label={`Compress what is sent to ${b.name}`} onChange={(v) => void ask({ action: "backend", name: b.name, on: v })} />
                    </div>
                    <div className="min-w-0 flex-1 px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        {b.cloud ? <Cloud size={14} className="text-cloud" /> : <Server size={14} className="text-dim" />}
                        <span className="font-medium">{b.name}</span>
                        {b.cloud && <span className="rounded border border-cloud/50 px-1 text-[9px] uppercase text-cloud">cloud</span>}
                      </div>
                      <div className="truncate text-[11px] text-dim">{(b.serves ?? []).join(", ") || b.url}</div>
                    </div>
                    <div className="max-w-[45%] shrink-0 px-4 py-2.5 text-right text-[12px]">
                      {!on ? <span className="text-dim">sent as it comes</span>
                        : b.headroom?.trouble ? <span className="text-bad">sent whole: Headroom {b.headroom.trouble}</span>
                        : <span className="text-ok">compressed{(b.headroom?.saved ?? 0) > 0 ? ` · ${b.headroom!.saved.toLocaleString()} tokens saved` : ""}</span>}
                    </div>
                  </div>
                );
              })}

          </div>
        )}
        {!ready && <div className="border-t border-line px-4 py-2 text-[11px] text-dim">Install Headroom to switch a backend on.</div>}
      </Card>

      {removing && (
        <Dialog title="Uninstall Headroom" label="Uninstall Headroom" size="sm" onClose={() => setRemoving(false)}>
          <div className="flex flex-col gap-4 p-4 text-[13px]">
            <div>It is stopped and everything installed for it is deleted from this machine. Backends that are switched on stay switched on and are sent whole until it is installed again.</div>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setRemoving(false)}>Keep it</Button>
              <Button tone="primary" onClick={() => { setRemoving(false); void ask({ action: "uninstall" }); }}>Uninstall</Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
