/**
 * The node's topology, left to right: peers, this node, then its hardware as containers holding
 * the backends that run on it. One edge per route work takes; one dot per request on it.
 */
import {
  Background, BaseEdge, Controls, getBezierPath, Handle, Position, ReactFlow,
  type Edge, type EdgeProps, type Node, type NodeProps,
} from "@xyflow/react";
import { CircuitBoard, Cpu, Flame, Globe, Server } from "lucide-react";
import { memo, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";

import type { Backend, Node as NetNode, Resource, UiData } from "../ui/types.js";
import { select, useStore } from "./store.js";
import { cx, Dot, type Tone } from "./ui.js";

type Card = { title: string; sub: string; tone: Tone; icon: ReactNode; meter?: [number, number]; busy?: boolean; selected?: boolean };
type Chip = { name: string; tone: Tone; busy: boolean; sub: string };
type Group = { title: string; sub: string; icon: ReactNode; hot: boolean; selected?: boolean; chips?: Chip[]; picked?: string };

const CardNode = memo(function CardNode({ data }: NodeProps<Node<Card>>) {
  return (
    <div className={cx(
      "w-[200px] rounded-xl border bg-panel px-3 py-2 shadow-sm transition-colors",
      data.selected ? "border-accent ring-2 ring-accent/25" : "border-line hover:border-dim/40",
    )}>
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2">
        <span className="text-dim">{data.icon}</span>
        <span className="truncate font-medium">{data.title}</span>
        <span className="ml-auto"><Dot tone={data.tone} pulse={data.busy} /></span>
      </div>
      <div className="mt-0.5 truncate text-[11px] text-dim">{data.sub}</div>
      {data.meter && data.meter[1] > 1 && (
        <div className="mt-1.5 flex gap-0.5">
          {Array.from({ length: Math.min(data.meter[1], 16) }, (_, i) => (
            <span key={i} className={cx("h-1 flex-1 rounded-full", i < data.meter![0] ? "bg-accent" : "bg-line")} />
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

/** A card or CPU: the frame its backends sit in, so "runs on" needs no line. */
const GroupNode = memo(function GroupNode({ data }: NodeProps<Node<Group>>) {
  return (
    <div className={cx(
      "h-full w-full rounded-2xl border border-dashed transition-colors",
      data.hot ? "border-ok/60 bg-ok/[0.04]" : "border-line bg-muted/30",
      data.selected && "ring-2 ring-accent/25",
    )}>
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2 px-3 pt-2 text-[11px]">
        <span className={data.hot ? "text-ok" : "text-dim"}>{data.icon}</span>
        <span className="font-semibold uppercase tracking-wide">{data.title}</span>
        <span className="truncate text-dim">{data.sub}</span>
      </div>
      {data.chips && (
        <div className="grid grid-cols-2 gap-1.5 px-3 pt-2">
          {data.chips.map((c) => (
            <button key={c.name} title={c.sub}
                    onClick={(e) => { e.stopPropagation(); select({ kind: "backend", id: c.name }); }}
                    className={cx("flex h-8 items-center gap-1.5 rounded-lg border bg-panel px-2 text-left text-[11px] transition-colors",
                      data.picked === c.name ? "border-accent" : c.busy ? "border-accent/50" : "border-line hover:border-dim/40")}>
              <Dot tone={c.tone} pulse={c.busy} />
              <span className="truncate font-medium">{c.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

const nodeTypes = { card: CardNode, hardware: GroupNode };

type Pulse = { key: string; back: boolean; t: number };
type Flow = { jobs: string[]; pulses: Pulse[]; color?: string; reverse?: boolean; dashed?: boolean };

const TRIP_MS = 900;

/**
 * Pulses per edge, kept outside the edge components because React Flow remounts those on every
 * update: one out when a request appears, one back when it ends, each with the time it set off.
 */
const tracked = new Map<string, { seen: Set<string>; pulses: Pulse[] }>();
function pulsesFor(edge: string, jobs: string[]): Pulse[] {
  const now = Date.now();
  const cur = tracked.get(edge);
  const ids = new Set(jobs);
  if (!cur) {
    // The first reading is the state we found, not traffic we watched start.
    tracked.set(edge, { seen: ids, pulses: [] });
    return [];
  }
  // Several in one reading leave one after another, so a burst reads as a stream rather than one dot.
  let n = 0;
  for (const j of jobs) if (!cur.seen.has(j)) cur.pulses.push({ key: `o:${j}`, back: false, t: now + 90 * n++ });
  for (const j of cur.seen) if (!ids.has(j)) cur.pulses.push({ key: `b:${j}`, back: true, t: now + 90 * n++ });
  cur.seen = ids;
  cur.pulses = cur.pulses.filter((p) => now - p.t < TRIP_MS).slice(-12);
  return [...cur.pulses];
}

/** One trip along the path, eased, placed by its start time so a remounted edge resumes it mid-flight. */
function PulseDot({ path, color, reverse, t }: { path: string; color: string; reverse: boolean; t: number }) {
  const dot = useRef<SVGCircleElement>(null);
  const track = useRef<SVGPathElement>(null);
  useLayoutEffect(() => {
    let raf = 0;
    const step = () => {
      const c = dot.current;
      const p = track.current;
      if (!c || !p) return;
      const k = (Date.now() - t) / TRIP_MS;
      if (k < 0) {
        raf = requestAnimationFrame(step);
        return;
      }
      if (k >= 1) {
        c.setAttribute("opacity", "0");
        return;
      }
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      const at = p.getPointAtLength((reverse ? 1 - e : e) * p.getTotalLength());
      c.setAttribute("cx", String(at.x));
      c.setAttribute("cy", String(at.y));
      c.setAttribute("opacity", String(Math.min(1, k / 0.08, (1 - k) / 0.12)));
      raf = requestAnimationFrame(step);
    };
    step();
    return () => cancelAnimationFrame(raf);
  }, [path, t, reverse]);
  return (
    <g>
      <path ref={track} d={path} fill="none" stroke="none" />
      <circle ref={dot} r={3.5} fill={color} opacity={0} className="flow-dot" />
    </g>
  );
}

/** Requests as pulses that always finish their trip; the line stays lit while anything runs on it. */
const FlowEdge = memo(function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<Edge<Flow>>) {
  const [path] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const color = data?.color ?? "var(--accent)";
  const hot = (data?.jobs ?? []).length > 0;
  return (
    <>
      <BaseEdge id={id} path={path} style={{
        stroke: hot ? color : data?.dashed ? "var(--bad)" : "var(--border)",
        strokeWidth: hot ? 2 : 1, strokeDasharray: data?.dashed ? "4 4" : undefined, opacity: hot ? 0.45 : 0.8,
      }} />
      {(data?.pulses ?? []).map((p) => (
        // Out runs source to target unless the edge is drawn the other way round; back is the opposite.
        <PulseDot key={p.key} t={p.t} path={path} color={p.back ? "var(--ok)" : color} reverse={p.back !== Boolean(data?.reverse)} />
      ))}
    </>
  );
});

const edgeTypes = { flow: FlowEdge };

const W = 200;
const H = 64;
const GAP = 12;
const PAD = 14;
const HEAD = 38;

function backendTone(b: Backend): Tone {
  if (b.answering === false) return "bad";
  if ((b.loaded ?? []).length > 0) return "ok";
  if ((b.loading ?? []).length > 0) return "warn";
  return b.knowsWarm === false ? "dim" : "info";
}

function backendSub(b: Backend, run: number): string {
  if (b.answering === false) return "not answering";
  if (run > 0 || (b.queued ?? 0) > 0) return `${run} running · ${b.queued ?? 0} queued`;
  if ((b.loading ?? []).length) return `loading ${b.loading![0]}`;
  if ((b.loaded ?? []).length) return b.loaded!.join(", ");
  return b.knowsWarm === false ? "idle" : "nothing loaded";
}

/** Peers | this node | hardware groups stacked, each a grid of its backends. Deterministic, so nothing moves per tick. */
function layout(d: UiData, sel: { kind: string; id: string } | null) {
  const self = d.net.nodes.find((n) => n.self)!;
  const peers = d.net.nodes.filter((n) => !n.self);
  const resources = d.net.resources ?? [];
  const is = (kind: string, id: string) => sel?.kind === kind && sel.id === id;

  const runningIds = new Map<string, string[]>();
  const peerIds = new Map<string, string[]>();
  for (const j of d.q.jobs) {
    if (j.state !== "running") continue;
    if (j.offbox && j.peer) peerIds.set(j.peer, [...(peerIds.get(j.peer) ?? []), j.id]);
    else if (j.backend) runningIds.set(j.backend, [...(runningIds.get(j.backend) ?? []), j.id]);
  }

  // Each backend sits in the first card it names, else its first resource, else "other".
  const home = new Map<string, Backend[]>();
  const order = [...resources.filter((r) => !r.shared), ...resources.filter((r) => r.shared)].map((r) => r.name);
  for (const b of self.backends ?? []) {
    const rs = b.resources ?? [];
    const key = rs.find((r) => resources.some((x) => x.name === r && !x.shared)) ?? rs[0] ?? "other";
    if (!order.includes(key)) order.push(key);
    home.set(key, [...(home.get(key) ?? []), b]);
  }

  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const X = { peer: 0, self: 290, group: 590 };
  let y = 0;
  for (const key of order) {
    const members = home.get(key) ?? [];
    if (members.length === 0) continue;
    const r: Resource | undefined = resources.find((x) => x.name === key);
    const hot = members.some((b) => (runningIds.get(b.name) ?? []).length > 0);
    // Many small backends read as chips behind one line; a few big ones keep a card and a line each.
    const chips = members.length > 3;
    const width = chips ? 2 * 150 + 6 + 24 : W + PAD * 2;
    const height = chips ? HEAD + 4 + Math.ceil(members.length / 2) * 38 + 6 : HEAD + members.length * H + (members.length - 1) * GAP + PAD;
    nodes.push({
      id: `resource:${key}`, type: "hardware", position: { x: X.group, y }, style: { width, height },
      data: {
        title: key, hot, selected: is("resource", key),
        icon: r?.kind === "cpu" ? <Cpu size={13} /> : <CircuitBoard size={13} />,
        sub: r?.shared ? "shared" : r?.holder ? `· ${r.holder}` : r ? "· free" : "",
        ...(chips ? {
          picked: sel?.kind === "backend" ? sel.id : undefined,
          chips: members.map((b) => {
            const n = (runningIds.get(b.name) ?? []).length;
            return { name: b.name, busy: n > 0, tone: n > 0 ? "accent" as Tone : backendTone(b), sub: backendSub(b, n) };
          }),
        } : {}),
      } satisfies Group,
    });
    if (chips) {
      const all = members.flatMap((b) => runningIds.get(b.name) ?? []);
      edges.push({ id: `e:group:${key}`, source: "self", target: `resource:${key}`, type: "flow", data: { jobs: all, pulses: pulsesFor(`e:group:${key}`, all) } });
      y += height + 24;
      continue;
    }
    members.forEach((b, i) => {
      const run = runningIds.get(b.name) ?? [];
      nodes.push({
        id: `backend:${b.name}`, type: "card", parentId: `resource:${key}`, extent: "parent",
        position: { x: PAD, y: HEAD + i * (H + GAP) },
        data: {
          title: b.name, icon: <Server size={14} />, tone: run.length > 0 ? "accent" : backendTone(b),
          sub: backendSub(b, run.length), meter: [run.length, b.slots ?? 0], busy: run.length > 0, selected: is("backend", b.name),
        } satisfies Card,
      });
      edges.push({ id: `e:backend:${b.name}`, source: "self", target: `backend:${b.name}`, type: "flow", data: { jobs: run, pulses: pulsesFor(`e:backend:${b.name}`, run) } });
    });
    y += height + 24;
  }
  const mid = Math.max(y - 24, H) / 2;

  nodes.unshift({
    id: "self", type: "card", position: { x: X.self, y: mid - H / 2 },
    data: {
      title: self.name, icon: <Flame size={14} className="text-accent" />, tone: "accent",
      sub: `${d.q.jobs.filter((j) => j.state === "running").length} running · ${d.q.jobs.filter((j) => j.state === "queued").length} queued`,
      selected: is("self", self.name),
    } satisfies Card,
  });
  peers.forEach((p: NetNode, i) => {
    nodes.push({
      id: `peer:${p.name}`, type: "card", position: { x: X.peer, y: mid - (peers.length * (H + GAP)) / 2 + i * (H + GAP) },
      data: {
        title: p.name, icon: <Globe size={14} />, tone: p.up ? "ok" : "bad",
        sub: p.up ? `${Object.keys(p.map ?? {}).length} linked · ${p.free ?? 0}/${p.slots ?? 0} free` : "down",
        busy: (peerIds.get(p.name) ?? []).length > 0, selected: is("peer", p.name),
      } satisfies Card,
    });
    // Work we send them flows out from this node, so the dots run right to left.
    edges.push({
      id: `e:peer:${p.name}`, source: `peer:${p.name}`, target: "self", type: "flow",
      data: { jobs: peerIds.get(p.name) ?? [], pulses: pulsesFor(`e:peer:${p.name}`, peerIds.get(p.name) ?? []), color: "var(--info)", reverse: true, dashed: !p.up },
    });
  });
  return { nodes, edges };
}

export function Topology() {
  const data = useStore((s) => s.data)!;
  const sel = useStore((s) => s.sel);
  const dark = document.documentElement.classList.contains("dark");
  const { nodes, edges } = useMemo(() => layout(data, sel), [data.net, data.q.jobs, sel]);
  return (
    <ReactFlow
      nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
      nodesDraggable={false} nodesConnectable={false} elementsSelectable={false}
      fitView fitViewOptions={{ padding: 0.12 }} minZoom={0.3} maxZoom={1.5}
      // Grouped cards are measured after the first paint, so fit again once they are.
      onInit={(rf) => setTimeout(() => void rf.fitView({ padding: 0.12 }), 60)}
      colorMode={dark ? "dark" : "light"} proOptions={{ hideAttribution: true }}
      onNodeClick={(_, n) => {
        const [kind, ...rest] = n.id.split(":");
        select(kind === "self" ? { kind: "self", id: data.net.nodes.find((x) => x.self)!.name } : { kind: kind as "peer", id: rest.join(":") });
      }}
      onPaneClick={() => select(null)}
    >
      <Background gap={20} size={1} color="var(--border)" />
      <Controls showInteractive={false} position="bottom-left" />
    </ReactFlow>
  );
}
