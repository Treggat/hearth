/**
 * Live state: /ui/events pushes a snapshot then top-level patches; /ui/data is polled if the
 * stream never delivers. Components select narrow slices, so one tick re-renders only what moved.
 */
import { create } from "zustand";

import { forgetKey, rememberKey, storedKey } from "../ui/lib.js";
import type { UiData } from "../ui/types.js";

export type Page = "topology" | "models" | "queue" | "config";
export type Sel = { kind: "self" | "peer" | "backend" | "resource"; id: string } | null;
type Toast = { tone: "ok" | "bad"; text: string; id: number } | null;

interface State {
  data: UiData | null;
  live: boolean;
  dead: boolean;
  page: Page;
  sel: Sel;
  toast: Toast;
  /** A pending key request from a write, resolved by the key dialog. */
  askKey: ((key: string | null) => void) | null;
}

export const useStore = create<State>(() => ({
  data: null,
  live: false,
  dead: false,
  page: (location.hash.slice(1) as Page) || "topology",
  sel: null,
  toast: null,
  askKey: null,
}));

export const go = (page: Page) => {
  location.hash = page;
  useStore.setState({ page, sel: null });
};
export const select = (sel: Sel) => useStore.setState({ sel });

let toastSeq = 0;
export function toast(tone: "ok" | "bad", text: string): void {
  const id = ++toastSeq;
  useStore.setState({ toast: { tone, text, id } });
  setTimeout(() => {
    if (useStore.getState().toast?.id === id) useStore.setState({ toast: null });
  }, tone === "ok" ? 2200 : 6000);
}

/** Open the stream, falling back to polling if no snapshot arrives; reconnects are the browser's. */
export function connect(): void {
  let gotSnapshot = false;
  let poll: number | null = null;
  const load = async () => {
    try {
      const r = await fetch("/ui/data", { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      useStore.setState({ data: (await r.json()) as UiData, dead: false });
    } catch {
      useStore.setState({ dead: true });
    }
  };
  const es = new EventSource("/ui/events");
  es.addEventListener("snapshot", (e) => {
    gotSnapshot = true;
    if (poll !== null) clearInterval(poll);
    poll = null;
    useStore.setState({ data: JSON.parse((e as MessageEvent).data) as UiData, live: true, dead: false });
  });
  es.addEventListener("patch", (e) => {
    const cur = useStore.getState().data;
    if (!cur) return;
    const p = JSON.parse((e as MessageEvent).data) as { set?: Partial<UiData>; add?: { hist: UiData["hist"] } };
    const next = { ...cur, ...p.set } as UiData;
    if (p.add) {
      const keep = (cur as { histKeep?: number }).histKeep ?? 120;
      next.hist = [...cur.hist, ...p.add.hist].slice(-keep);
    }
    useStore.setState({ data: next, live: true });
  });
  es.onerror = () => useStore.setState({ live: false });
  setTimeout(() => {
    if (gotSnapshot || poll !== null) return;
    void load();
    poll = window.setInterval(() => { if (!document.hidden) void load(); }, 3000);
  }, 4000);
}

function askForKey(): Promise<string | null> {
  return new Promise((resolve) => useStore.setState({ askKey: resolve }));
}

/**
 * A request the node may want a key for. Asks once, remembers the key in this browser, and
 * forgets it on a 401. Errors come back as `{message, path}` so a form can place them.
 */
export async function request<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  const mode = useStore.getState().data?.control;
  let key = storedKey() ?? "";
  if (mode === "key" && !key) {
    const entered = await askForKey();
    useStore.setState({ askKey: null });
    if (!entered) throw new RequestError("a key is needed to change anything here", null);
    key = entered.trim();
    rememberKey(key);
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  const r = await fetch(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const d = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (r.status === 401) {
    forgetKey();
    throw new RequestError("key rejected — try again to re-enter it", null);
  }
  if (!r.ok) {
    const err = (d.error ?? {}) as { message?: string; path?: string | null };
    throw new RequestError(err.message ?? (typeof d.error === "string" ? d.error : `failed (${r.status})`), err.path ?? null);
  }
  return d as T;
}

export class RequestError extends Error {
  constructor(message: string, readonly path: string | null) {
    super(message);
  }
}

/** A /control change that saves itself: toast on success, toast with the reason on failure. */
export async function control(body: Record<string, unknown>, done: string): Promise<boolean> {
  try {
    await request("POST", "/control", body);
    toast("ok", done);
    return true;
  } catch (e) {
    toast("bad", e instanceof Error ? e.message : String(e));
    return false;
  }
}
