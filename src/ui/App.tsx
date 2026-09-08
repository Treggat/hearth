/**
 * The console.
 *
 * Two views behind one shell. The graph IS the default page: what this box is
 * made of and what is moving through it, with one rail beside it holding every
 * action for whatever is selected, and the tables as drawers you open rather
 * than four screens you scroll past. The dashboard is the same facts laid out to
 * read top to bottom — a menu in the header switches between them, and the choice
 * is remembered. Both are handed the same poll and the same theme from here, and
 * the tables and every backend/peer panel are shared modules, so the two views
 * cannot drift apart.
 *
 * Three structural rules the old page broke, each of which cost something:
 *
 *   One place for actions. A control beside the fact it changes sounds right and
 *   scatters the controls down four sections, which is how the two switches that
 *   decide whether this box federates at all ended up in a heading two screens
 *   down.
 *
 *   Stable identity across polls. Every list here is keyed by something that
 *   survives a refresh, because reconciliation is what keeps a button's in-flight
 *   state alive through the 3s poll.
 *
 *   Motion means traffic. Nothing on this page animates unless something is
 *   really happening, or the graph becomes wallpaper.
 */
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CssBaseline from "@mui/material/CssBaseline";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import { ThemeProvider } from "@mui/material/styles";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Identity, Row, Spacer } from "./bits.js";
import Dashboard from "./dashboard.js";
import { Graph, type Sel } from "./graph.js";
import { Inspector, type Ctx } from "./inspect.js";
import { load, setKeyAsker } from "./lib.js";
import { History, ModelsTable, QueueTable } from "./tables.js";
import { makeTheme, MONO } from "./theme.js";
import { callStats } from "./why.js";
import type { UiData } from "./types.js";

/* ------------------------------------------------------------------ data */

/**
 * Pushed, with the poll kept as the way back.
 *
 * /ui/events sends one snapshot and then only what changed. The poll it
 * replaces asked for 95KB every 3 seconds and 93% of that was history the page
 * already had, so an idle box now sends nothing at all.
 *
 * The fallback is not decoration. EventSource is the one transport a proxy, an
 * extension or an older server can break in a way that looks like silence, and
 * a status page that renders nothing is worse than one that renders slowly. So
 * a stream that never delivers a snapshot is abandoned for the poll, and the
 * page carries on exactly as it used to.
 *
 * The poll keeps both its old guards. /ui/data calls peers.ensureFresh(), which
 * can exceed the 3s interval exactly when a peer is timing out — which is
 * exactly when you are watching. Unguarded, requests stack and an older
 * response can land after a newer one and render stale state over fresh.
 * document.hidden stops a forgotten background tab polling a peer-probing
 * endpoint forever.
 */
function useData(): { data: UiData | null; dead: boolean; live: boolean; refresh: () => void } {
  const [data, setData] = useState<UiData | null>(null);
  const [dead, setDead] = useState(false);
  const [live, setLive] = useState(false);
  const inFlight = useRef(false);
  const polling = useRef<number | null>(null);

  const poll = useCallback((force: boolean) => {
    // force=true skips the visibility check but NEVER the in-flight check.
    if (inFlight.current || (document.hidden && !force)) return;
    inFlight.current = true;
    load()
      .then((d) => { setData(d); setDead(false); })
      .catch((e) => { setDead(true); console.error(e); })
      .finally(() => { inFlight.current = false; });
  }, []);

  const startPolling = useCallback(() => {
    if (polling.current !== null) return;
    // The FIRST load is forced: document.hidden is true more often than you
    // would think — a background tab, a prerender, an embedded pane — and
    // gating the initial fetch on it left the page permanently blank there,
    // waiting on a visibilitychange that may never come.
    poll(true);
    polling.current = window.setInterval(() => poll(false), 3000);
  }, [poll]);

  useEffect(() => {
    let es: EventSource | null = null;
    let got = false;
    let gone = false;

    const fallBack = () => {
      if (gone) return;
      gone = true;
      es?.close();
      setLive(false);
      startPolling();
    };

    try {
      es = new EventSource("/ui/events");
    } catch {
      startPolling();
      return;
    }

    // Nothing at all within ten seconds is a stream that is not going to work,
    // whatever the reason. Long enough not to race a slow first build, short
    // enough that a broken transport is not a blank page.
    const giveUp = window.setTimeout(() => { if (!got) fallBack(); }, 10_000);

    es.addEventListener("snapshot", (e) => {
      got = true;
      setData(JSON.parse((e as MessageEvent<string>).data) as UiData);
      setDead(false);
      setLive(true);
    });

    es.addEventListener("patch", (e) => {
      const p = JSON.parse((e as MessageEvent<string>).data) as {
        set?: Partial<UiData>;
        add?: { hist: UiData["hist"] };
      };
      setData((prev) => {
        // A patch before the snapshot is a patch against nothing. Dropping it
        // is right: the next snapshot carries everything anyway.
        if (!prev) return prev;
        const next = { ...prev, ...(p.set ?? {}) };
        if (p.add?.hist) {
          // Trimmed to the server's own ring length, or a tab left open all
          // day would accumulate a history the server stopped keeping hours
          // ago and draw a chart nothing else agrees with.
          next.hist = [...next.hist, ...p.add.hist].slice(-(prev.histKeep ?? 120));
        }
        return next;
      });
      setDead(false);
    });

    es.onerror = () => {
      // EventSource retries by itself, and a node restarting is the common
      // case — so an error AFTER we have data is not a reason to abandon the
      // transport, only to say the page is stale. One that arrives before the
      // first snapshot is a transport that does not work here.
      if (!got) fallBack();
      else setDead(true);
    };

    const back = () => { if (!document.hidden && polling.current !== null) poll(true); };
    document.addEventListener("visibilitychange", back);
    return () => {
      window.clearTimeout(giveUp);
      es?.close();
      if (polling.current !== null) window.clearInterval(polling.current);
      polling.current = null;
      document.removeEventListener("visibilitychange", back);
    };
  }, [poll, startPolling]);

  return { data, dead, live, refresh: () => poll(true) };
}

/* --------------------------------------------------------------- drawers */

type Drawer = "queue" | "models" | "history" | null;

function DrawerTab({ label, count, tone = "quiet", open, onClick }: {
  label: string;
  count?: React.ReactNode;
  /** The count's colour, and it means what it means everywhere else on the
   *  page: amber is something to look at, red is something that broke. */
  tone?: "quiet" | "work" | "fault";
  open: boolean;
  onClick: () => void;
}) {
  return (
    <Button onClick={onClick} aria-expanded={open}
            aria-controls={open ? "hearth-drawer" : undefined} sx={[
      {
        borderColor: "transparent", borderRadius: 0, px: 1.5, py: 0.75,
        borderBottom: "2px solid", borderBottomColor: "transparent",
        "&:hover": { borderColor: "transparent", borderBottomColor: "line", background: "none" },
      },
      open && {
        color: "text.primary", borderBottomColor: "success.main",
        "&:hover": { borderBottomColor: "success.main" },
      },
    ]}>
      {label}
      {count !== undefined && (
        <Box component="span" sx={{
          ml: 0.75,
          color: tone === "fault" ? "error.main" : tone === "work" ? "warning.main" : "faint",
        }}>{count}</Box>
      )}
    </Button>
  );
}

/* ------------------------------------------------------------ graph view */

function Console({ d, ctx, dead, live, menu }: {
  d: UiData | null; ctx: Ctx; dead: boolean; live: boolean; menu?: React.ReactNode;
}) {
  const [sel, setSel] = useState<Sel>(null);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const self = d?.net.nodes.find((n) => n.self);
  const queued = d ? Object.values(d.q.capacity.queued).reduce((a, b) => a + b, 0) : 0;
  const running = d ? d.q.jobs.filter((j) => j.state === "running" && !j.offbox).length : 0;
  const calls = callStats(d?.calls);

  const toggle = (which: Exclude<Drawer, null>) =>
    setDrawer((cur) => (cur === which ? null : which));

  // Escape backs out of whatever is open, innermost first. The rail's own
  // "← everything" link is a small target and the only other way out of a
  // selection, and a drawer covering half the stage has no way out at all
  // without finding the tab that opened it again.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // A dialog or a menu is on top of this and owns the key while it is up.
      if (document.querySelector(".MuiModal-root")) return;
      if (drawer) setDrawer(null);
      else if (sel) setSel(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawer, sel]);

  return (
    <Box sx={{
      // Exactly one viewport on a wide screen, so the drawer bar is always
      // reachable without scrolling and the stage takes whatever is left over.
      minHeight: "100dvh", height: { lg: "100dvh" }, overflow: { lg: "hidden" },
      display: "flex", flexDirection: "column", bgcolor: "background.default",
    }}>
      {/* Header. Identity and the two facts you would reload the page to check. */}
      <Box component="header" sx={{
        display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap",
        px: 3, py: 1.25, borderBottom: "1px solid", borderColor: "line",
        bgcolor: "background.paper", flexShrink: 0,
      }}>
        {menu}
        <Identity name={self?.name} dead={dead} live={live} size="sm" />
        <Spacer />
        {d && (
          <Row spacing={2} align="baseline" sx={{ fontFamily: MONO, fontSize: 11, color: "text.secondary" }}>
            <Box component="span">
              <Box component="b" sx={{ color: running ? "success.main" : "text.primary" }}>{running}</Box> running
            </Box>
            <Box component="span">
              <Box component="b" sx={{ color: queued ? "warning.main" : "text.primary" }}>{queued}</Box> queued
            </Box>
            {d.q.capacity.resident && (
              <Tooltip title="the first model currently loaded on this node">
                <Box component="span" sx={{ cursor: "help" }}>
                  resident <Box component="span" sx={{ color: "success.main" }}>{d.q.capacity.resident}</Box>
                </Box>
              </Tooltip>
            )}
          </Row>
        )}
      </Box>

      {!d ? (
        <Typography sx={{ color: "faint", p: 4 }}>
          {dead ? `no answer from ${live ? "/ui/events" : "/ui/data"}` : "loading…"}
        </Typography>
      ) : (
        <>
          {/* Stage and rail. The rail drops under the stage on a narrow screen
              rather than shrinking into a column of wrapped words. */}
          {/* The rail only sits beside the stage where both fit: MIN_STAGE for
              the graph plus the rail's own 340 plus padding. Below that the
              stage would be narrower than its own floor and scroll sideways
              with the controls still taking a third of the width, so the rail
              goes under it instead. */}
          <Box sx={{
            flex: "1 1 auto", minHeight: 0,
            display: "grid",
            gridTemplateColumns: { xs: "1fr", lg: "minmax(0,1fr) 340px" },
          }}>
            <Box sx={{ p: 2, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
              <Graph d={d} sel={sel} onSelect={setSel} />
            </Box>
            <Inspector d={d} sel={sel} ctx={ctx} onSelect={setSel} />
          </Box>

          {/* Drawers. Closed by default: the graph answers most visits, and a
              page that opens with three tables under it is the page this
              replaced. */}
          <Box component="footer" sx={{
            borderTop: "1px solid", borderColor: "line", bgcolor: "background.paper", flexShrink: 0,
          }}>
            <Row spacing={0} align="center" sx={{ px: 1.5, borderBottom: drawer ? "1px solid" : "none", borderColor: "line" }}>
              <DrawerTab label="queue" count={d.q.jobs.length} tone={queued > 0 ? "work" : "quiet"}
                         open={drawer === "queue"} onClick={() => toggle("queue")} />
              <DrawerTab label="models" count={`${d.net.readyNow.length}/${d.net.available.length}`}
                         open={drawer === "models"} onClick={() => toggle("models")} />
              <DrawerTab label="last 10 minutes"
                         count={calls.failed ? `${calls.failed} failed` : calls.n}
                         tone={calls.failed ? "fault" : "quiet"}
                         open={drawer === "history"} onClick={() => toggle("history")} />
              <Spacer />
              <Typography sx={{
                fontFamily: MONO, fontSize: 10, pr: 1.5,
                color: dead ? "error.main" : "faint",
                display: { xs: "none", sm: "block" },
              }}>
                {/* Never claims to be live while nothing is arriving: the
                    header and this line describe the same connection. */}
                {dead ? "stale · nothing arriving"
                  : live ? "live · pushed from /ui/events" : "polls /ui/data every 3s"}
              </Typography>
            </Row>
            {drawer && (
              <Box id="hearth-drawer" role="region" aria-label={drawer}
                   sx={{ p: 2, maxHeight: "45dvh", overflowY: "auto" }}>
                {drawer === "queue" && <QueueTable d={d} />}
                {drawer === "models" && <ModelsTable d={d} ctx={ctx} onSelect={setSel} />}
                {drawer === "history" && <History d={d} />}
              </Box>
            )}
          </Box>
        </>
      )}
    </Box>
  );
}

/* -------------------------------------------------------------- the key */

/**
 * Asking for the API key, in the page.
 *
 * This was `window.prompt`, which has room for a sentence and no room for the
 * two things an operator actually needs: what this key IS, and where to get it.
 * So the first write on a keyed node opened a bare box asking for a secret, with
 * a rejection indistinguishable from a click that did nothing.
 *
 * Mounted once by the shell and handed to lib.ts, which resolves the promise it
 * hands back — so `postWrite` can wait for a person without the write path
 * knowing anything about React.
 */
function KeyDialog() {
  const [resolve, setResolve] = useState<((k: string | null) => void) | null>(null);
  const [value, setValue] = useState("");

  useEffect(() => {
    setKeyAsker(() => new Promise<string | null>((r) => {
      setValue("");
      // Stored through a setter function, or React would call the resolver
      // instead of storing it — useState treats a function argument as an
      // updater, and a promise that resolves itself on mount is a fine way to
      // spend an afternoon.
      setResolve(() => r);
    }));
  }, []);

  const done = (k: string | null) => {
    resolve?.(k);
    setResolve(null);
  };

  return (
    <Dialog open={resolve !== null} onClose={() => done(null)} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontSize: 14, fontWeight: 600 }}>
        This node needs a key for controls
      </DialogTitle>
      <DialogContent>
        <Typography sx={{ fontSize: 11.5, color: "text.secondary", mb: 1.5, lineHeight: 1.7 }}>
          Reading is open on this socket; changing something is not. The key is stored
          in this browser only and never leaves it. If the node refuses it you will be
          told on the control, and asked again next time.
        </Typography>
        <TextField
          autoFocus fullWidth type="password" value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && value.trim()) done(value.trim()); }}
          slotProps={{ htmlInput: { "aria-label": "API key", spellCheck: false } }}
        />
        <Typography sx={{ fontFamily: MONO, fontSize: 10.5, color: "faint", mt: 1.5 }}>
          {/* Points at the CONFIG, not at anyone's box. An earlier version of
              this line printed the exact ssh command that fetches the key on the
              node it was written for — a host alias and an env path, baked into
              a public repo and wrong for every other operator. Whoever is
              looking at this dialog knows where their own config lives. */}
          any key from this node&apos;s apiKeys list
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => done(null)}>cancel</Button>
        <Button onClick={() => done(value.trim() || null)} disabled={!value.trim()}>use key</Button>
      </DialogActions>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ views */

/**
 * Which view is showing, remembered per browser.
 *
 * The graph is the default where there is room for it — it is what a visit is
 * usually for. The stage has a floor of MIN_STAGE px and a rail beside it, so
 * on a phone the graph is a diagram you scroll sideways with its controls
 * pushed below the fold; the dashboard is the same facts in a column, which is
 * what a narrow screen wants. So the FALLBACK follows the viewport and an
 * explicit choice always wins over it, in either direction.
 *
 * localStorage can throw (private mode, storage disabled), and a page that
 * refuses to render because it could not remember a preference is worse than
 * one that forgets it, so both sides are guarded.
 */
type View = "graph" | "dashboard";
const VIEW_KEY = "hearth.view";

function useView(fallback: View): [View, (v: View) => void] {
  const [view, setView] = useState<View>(() => {
    try {
      const stored = localStorage.getItem(VIEW_KEY);
      return stored === "dashboard" || stored === "graph" ? stored : fallback;
    } catch { return fallback; }
  });
  const choose = useCallback((v: View) => {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode: this session only */ }
  }, []);
  return [view, choose];
}

/**
 * The view switcher.
 *
 * Two mutually exclusive destinations, drawn as two controls that both say
 * where they go and which one you are on. A menu would hide half of that
 * behind a click and read as "there is navigation here", which there is not —
 * there are two views.
 */
function ViewMenu({ view, onView }: { view: View; onView: (v: View) => void }) {
  const item = (v: View, label: string) => (
    <Button
      key={v}
      onClick={() => onView(v)}
      aria-current={view === v ? "page" : undefined}
      sx={[
        { border: "none", px: 0.75, py: 0.25, color: "faint",
          "&:hover": { border: "none", color: "text.primary", background: "none" } },
        view === v && { color: "text.primary", textDecoration: "underline",
                        textUnderlineOffset: 4, textDecorationColor: "success.main" },
      ]}
    >{label}</Button>
  );
  return (
    <Row spacing={0} align="center" component="span" sx={{ display: "inline-flex", mr: 0.5 }}>
      {item("graph", "graph")}
      {item("dashboard", "dashboard")}
    </Row>
  );
}

/* ------------------------------------------------------------------ page */

export default function App() {
  const { data, dead, live, refresh } = useData();
  const prefersDark = useMediaQuery("(prefers-color-scheme: dark)");
  const theme = useMemo(() => makeTheme(prefersDark ? "dark" : "light"), [prefersDark]);
  // Matches the breakpoint the stage-and-rail layout itself uses.
  const roomy = useMediaQuery("(min-width: 1200px)");
  const [view, setView] = useView(roomy ? "graph" : "dashboard");
  const ctx: Ctx = {
    canWarm: data?.canWarm ?? false,
    control: data?.control ?? "off",
    refresh,
  };
  // One menu element, handed to whichever view is mounted so it sits inside that
  // view's own header rather than floating over it.
  const menu = <ViewMenu view={view} onView={setView} />;
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <KeyDialog />
      {view === "graph"
        ? <Console d={data} ctx={ctx} dead={dead} live={live} menu={menu} />
        : <Dashboard d={data} ctx={ctx} dead={dead} live={live} menu={menu} />}
    </ThemeProvider>
  );
}
