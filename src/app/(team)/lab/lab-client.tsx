"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { METRIC_LABEL, SEATS, type Metric, type Seat } from "@/lib/lab-seats";
import type { ClientNumbers, ProposedTest } from "@/lib/lab";
import { addSource, createTest, decideTest, deleteSource, deleteThread, deployLearning, draftDeploy, dropTest, iterateTest, sendToTable, startTest } from "./actions";

export type LabClientRow = { id: string; name: string; slug: string; industry: string | null; spend30: number };
export type LabMessage = { id: string; role: "user" | "agent"; seat: Seat | null; author: string | null; body: string; tests: ProposedTest[]; at: string };
export type LabSource = { id: string; kind: string; title: string; url: string | null; summary: string | null; status: string; at: string; words: number };
export type LabTest = {
  id: string;
  threadId: string | null;
  title: string;
  hypothesis: string;
  change: string;
  metric: Metric;
  success: string;
  targetLift: number;
  status: "proposed" | "running" | "won" | "lost";
  startedAt: string | null;
  endsAt: string | null;
  verdict: string | null;
  learning: string | null;
  createdAt: string;
  clients: { id: string; before: ClientNumbers | null; now: ClientNumbers | null; change: number | null }[];
  briefs: { waiting: number; approved: number; tickets: number[] };
  deployed: { id: string; change: number | null }[];
  deployedAt: string | null;
};
type Tab = "table" | "tests" | "library";

const money = (n: number | null | undefined) => (n == null ? "—" : `$${n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0 })}`);
const pct = (n: number | null) => (n == null ? "—" : `${n > 0 ? "+" : ""}${n}%`);
const ago = (iso: string) => {
  const m = (Date.now() - Date.parse(iso)) / 60000;
  return m < 60 ? `${Math.max(1, Math.round(m))}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

export function LabClient(props: {
  threads: { id: string; title: string; updatedAt: string }[];
  threadId: string | null;
  messages: LabMessage[];
  sources: LabSource[];
  tests: LabTest[];
  clients: LabClientRow[];
  tab: Tab;
  aiOn: boolean;
}) {
  const [tab, setTab] = useState<Tab>(props.tab);
  const running = props.tests.filter((t) => t.status === "running").length;
  const won = props.tests.filter((t) => t.status === "won").length;
  const deployedClients = new Set(props.tests.flatMap((t) => t.deployed.map((d) => d.id))).size;

  const go = (t: Tab) => {
    setTab(t);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", t);
    window.history.replaceState(null, "", url);
  };

  return (
    <div className="mx-auto grid max-w-7xl gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid gap-2">
          <p className="text-xs uppercase tracking-[0.18em] text-faint">Execs &amp; leads</p>
          <h1 className="font-display text-3xl tracking-tight md:text-4xl">Ads Lab</h1>
          <p className="max-w-2xl text-sm text-muted">Think it through with the whole table, test it on the right clients, and turn what wins into what every agent knows.</p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <Pill value={running} label="running" />
          <Pill value={won} label="won" />
          <Pill value={deployedClients} label="clients learning from wins" />
        </div>
      </header>

      <nav className="flex gap-1 border-b border-line">
        {(
          [
            ["table", "Round table"],
            ["tests", `Tests${props.tests.length ? ` · ${props.tests.length}` : ""}`],
            ["library", `Library${props.sources.length ? ` · ${props.sources.length}` : ""}`],
          ] as const
        ).map(([k, l]) => (
          <button key={k} onClick={() => go(k)} className={`relative px-4 pb-3 text-sm ${tab === k ? "text-fg" : "text-muted hover:text-fg"}`}>
            {l}
            {tab === k && <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-brand" />}
          </button>
        ))}
      </nav>

      {!props.aiOn && <p className="rounded-[12px] border border-warn/40 bg-warn-soft px-4 py-3 text-sm text-warn">The AI isn&apos;t connected in this environment, so the table can&apos;t answer here.</p>}

      {tab === "table" && <RoundTable {...props} />}
      {tab === "tests" && <Tests tests={props.tests} clients={props.clients} />}
      {tab === "library" && <Library sources={props.sources} />}
    </div>
  );
}

function Pill({ value, label }: { value: number; label: string }) {
  return (
    <span className="flex items-baseline gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5">
      <span className="tabular text-sm font-semibold">{value}</span>
      <span className="text-muted">{label}</span>
    </span>
  );
}

function SeatMark({ seat, size = 30 }: { seat: Seat; size?: number }) {
  const s = SEATS[seat];
  return (
    <span className="grid shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white" style={{ width: size, height: size, background: s.tint }} title={s.name}>
      {s.name
        .split(" ")
        .map((w) => w[0])
        .join("")
        .slice(0, 2)}
    </span>
  );
}

// ─── Round table ────────────────────────────────────────────────────────────

function RoundTable({ threads, threadId, messages, tests, clients }: { threads: { id: string; title: string; updatedAt: string }[]; threadId: string | null; messages: LabMessage[]; tests: LabTest[]; clients: LabClientRow[] }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<ProposedTest | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const testById = useMemo(() => new Map(tests.map((t) => [t.id, t])), [tests]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages.length, pending]);

  const send = async (body = text) => {
    const msg = body.trim();
    if (!msg || pending) return;
    setText("");
    setError(null);
    setPending(msg);
    const r = await sendToTable(threadId, msg);
    setPending(null);
    if (!r.ok) {
      setText(msg);
      return setError(r.error);
    }
    if (r.threadId !== threadId) router.push(`/lab?t=${r.threadId}`);
    else router.refresh();
  };

  const STARTERS = [
    "What's the biggest creative opportunity across our restaurant clients right now?",
    "Read the latest call transcript in the library. What should we test from it?",
    "Our winners keep using faces in the first frame. Is that real, and how would we test it?",
  ];

  return (
    <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
      <aside className="grid content-start gap-1">
        <Link href="/lab" className={`mb-2 flex h-9 items-center justify-center rounded-brand border text-sm ${threadId ? "border-line text-muted hover:text-fg" : "border-brand/50 bg-brand-soft text-brand-text"}`}>
          + New conversation
        </Link>
        <div className="no-scrollbar flex gap-1 overflow-x-auto lg:grid lg:overflow-visible">
          {threads.map((t) => (
            <Link
              key={t.id}
              href={`/lab?t=${t.id}`}
              className={`group flex shrink-0 items-center justify-between gap-2 rounded-brand px-3 py-2 text-sm ${t.id === threadId ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface-2/60 hover:text-fg"}`}
            >
              <span className="truncate">{t.title}</span>
              <span className="text-[10px] text-faint">{ago(t.updatedAt)}</span>
            </Link>
          ))}
        </div>
      </aside>

      <section className="flex min-h-[560px] flex-col overflow-hidden rounded-[16px] border border-line bg-surface">
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="flex -space-x-1.5">
            {(Object.keys(SEATS) as Seat[]).map((s) => (
              <span key={s} className="rounded-full ring-2 ring-surface">
                <SeatMark seat={s} size={26} />
              </span>
            ))}
          </div>
          <p className="hidden text-xs text-faint sm:block">Strategist · Copywriter · Creative director · Media buyer · Analyst. They read the whole library, the winners and every test.</p>
          {threadId && (
            <button
              onClick={async () => {
                if (!confirm("Delete this conversation? Tests started from it stay.")) return;
                await deleteThread(threadId);
                router.push("/lab");
              }}
              className="text-xs text-faint hover:text-bad"
            >
              Delete
            </button>
          )}
        </div>

        <div className="grid flex-1 content-start gap-4 overflow-y-auto p-4 md:p-6" style={{ maxHeight: "68vh" }}>
          {messages.length === 0 && !pending && (
            <div className="grid gap-4 py-8 text-center">
              <p className="font-display text-2xl">What should we figure out?</p>
              <p className="mx-auto max-w-md text-sm text-muted">Bring an idea, a question, or something from the library. The table talks it through and proposes tests when one is ready.</p>
              <div className="mx-auto grid w-full max-w-xl gap-2">
                {STARTERS.map((s) => (
                  <button key={s} onClick={() => setText(s)} className="rounded-[12px] border border-line bg-bg px-4 py-3 text-left text-sm text-muted hover:border-faint hover:text-fg">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="ml-auto grid max-w-[80%] gap-1">
                <p className="text-right text-[11px] text-faint">{m.author ?? "You"}</p>
                <p className="whitespace-pre-wrap rounded-[14px] rounded-tr-[4px] bg-fg px-4 py-2.5 text-sm text-bg">{m.body}</p>
              </div>
            ) : (
              <div key={m.id} className="grid gap-3">
                <div className="flex max-w-[88%] gap-3">
                  {m.seat && <SeatMark seat={m.seat} />}
                  <div className="grid gap-1">
                    <p className="text-[11px] font-medium" style={{ color: m.seat ? SEATS[m.seat].tint : undefined }}>
                      {m.seat ? SEATS[m.seat].name : "The table"}
                    </p>
                    <p className="whitespace-pre-wrap text-sm leading-relaxed">{m.body}</p>
                  </div>
                </div>
                {m.tests.map((t, i) => (
                  <ProposalCard key={i} t={t} clients={clients} duplicate={t.duplicateOf ? (testById.get(t.duplicateOf) ?? null) : null} onStart={() => setStarting(t)} />
                ))}
              </div>
            ),
          )}

          {pending && (
            <>
              <div className="ml-auto max-w-[80%] whitespace-pre-wrap rounded-[14px] rounded-tr-[4px] bg-fg px-4 py-2.5 text-sm text-bg">{pending}</div>
              <div className="flex items-center gap-3 text-xs text-faint">
                <span className="flex -space-x-1">
                  {(Object.keys(SEATS) as Seat[]).map((s, i) => (
                    <span key={s} className="animate-pulse rounded-full ring-2 ring-surface" style={{ animationDelay: `${i * 160}ms` }}>
                      <SeatMark seat={s} size={22} />
                    </span>
                  ))}
                </span>
                The table is talking it through…
              </div>
            </>
          )}
          <div ref={end} />
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          className="grid gap-2 border-t border-line p-3"
        >
          {error && <p className="px-1 text-xs text-bad">{error}</p>}
          <div className="flex items-end gap-2">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={2}
              placeholder="Bring an idea, a question, or point at something in the library…"
              className="max-h-48 min-h-[44px] flex-1 resize-y rounded-[12px] border border-line bg-bg px-3.5 py-2.5 text-sm outline-none placeholder:text-faint focus:border-faint"
            />
            <button disabled={!text.trim() || Boolean(pending)} className="h-11 rounded-brand bg-brand px-5 text-sm font-medium text-white disabled:opacity-40">
              Send
            </button>
          </div>
        </form>
      </section>

      {starting && <StartDialog t={starting} clients={clients} tests={tests} threadId={threadId} onClose={() => setStarting(null)} />}
    </div>
  );
}

function ProposalCard({ t, clients, duplicate, onStart }: { t: ProposedTest; clients: LabClientRow[]; duplicate: LabTest | null; onStart: () => void }) {
  const names = t.clientIds.map((id) => clients.find((c) => c.id === id)?.name).filter(Boolean);
  return (
    <div className="ml-10 grid gap-3 rounded-[14px] border border-brand/30 bg-[linear-gradient(135deg,rgba(178,30,44,0.10),transparent_60%)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] uppercase tracking-[0.14em] text-brand-text">Proposed test</span>
        <span className="text-xs text-faint">
          {METRIC_LABEL[t.metric]} · aim {Math.round(t.targetLift * 100)}% better
        </span>
      </div>
      <p className="font-heading text-lg leading-snug">{t.title}</p>
      <p className="text-sm text-muted">{t.hypothesis}</p>
      <p className="text-sm">
        <span className="text-faint">What changes: </span>
        {t.change}
      </p>
      <p className="text-xs text-faint">A win: {t.success}</p>
      {names.length > 0 && <p className="text-xs text-muted">On: {names.join(", ")}</p>}
      {duplicate ? (
        <div className="rounded-[10px] border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn">
          Already in the lab: &ldquo;{duplicate.title}&rdquo; ({duplicate.status === "lost" ? "flopped" : duplicate.status}).{t.duplicateWhy ? ` ${t.duplicateWhy}` : ""}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button onClick={onStart} className="h-9 rounded-brand bg-fg px-4 text-sm font-medium text-bg">
          {duplicate ? "Run it anyway…" : "Set up the test…"}
        </button>
      </div>
    </div>
  );
}

function ClientPicker({ clients, chosen, setChosen, tests, exclude }: { clients: LabClientRow[]; chosen: string[]; setChosen: (ids: string[]) => void; tests: LabTest[]; exclude?: string }) {
  const [q, setQ] = useState("");
  const busy = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const t of tests) if (t.status === "running" && t.id !== exclude) for (const c of t.clients) m.set(c.id, [...(m.get(c.id) ?? []), t.title]);
    return m;
  }, [tests, exclude]);
  const term = q.trim().toLowerCase();
  const list = clients
    .filter((c) => !term || c.name.toLowerCase().includes(term) || c.industry?.toLowerCase().includes(term))
    .sort((a, b) => Number(chosen.includes(b.id)) - Number(chosen.includes(a.id)) || b.spend30 - a.spend30);
  return (
    <div className="grid gap-2">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a client or industry" className="h-9 rounded-brand border border-line bg-bg px-3 text-sm outline-none placeholder:text-faint" />
      <div className="grid max-h-64 gap-0.5 overflow-y-auto rounded-[10px] border border-line p-1">
        {list.map((c) => {
          const on = chosen.includes(c.id);
          const also = busy.get(c.id);
          return (
            <label key={c.id} className={`flex cursor-pointer items-center gap-3 rounded-[8px] px-2.5 py-2 text-sm ${on ? "bg-surface-2" : "hover:bg-surface-2/50"}`}>
              <input type="checkbox" checked={on} onChange={() => setChosen(on ? chosen.filter((x) => x !== c.id) : [...chosen, c.id])} />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{c.name}</span>
                <span className="block truncate text-[11px] text-faint">
                  {c.industry ?? "Industry not set"} · {money(c.spend30)} in 30 days
                </span>
                {also && <span className="block truncate text-[11px] text-warn">Already testing: {also.join(", ")}</span>}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function Sheet({ children, onClose, wide }: { children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`grid max-h-[92vh] w-full gap-4 overflow-y-auto rounded-[18px] border border-line bg-bg p-5 ${wide ? "max-w-[720px]" : "max-w-[560px]"}`}>{children}</div>
    </div>,
    document.body,
  );
}

function StartDialog({ t, clients, tests, threadId, onClose, existing }: { t: ProposedTest; clients: LabClientRow[]; tests: LabTest[]; threadId: string | null; onClose: () => void; existing?: string }) {
  const router = useRouter();
  const [chosen, setChosen] = useState<string[]>(t.clientIds);
  const [days, setDays] = useState(14);
  const [busy, act] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const go = (start: boolean) =>
    act(async () => {
      setError(null);
      const r = existing ? await startTest(existing, chosen, days) : await createTest({ ...t, clientIds: chosen, threadId, days, start });
      if (!r.ok) return setError(r.error);
      onClose();
      router.refresh();
    });
  return (
    <Sheet onClose={onClose}>
      <div className="grid gap-1">
        <p className="text-[11px] uppercase tracking-[0.14em] text-brand-text">Set up the test</p>
        <p className="font-heading text-xl leading-snug">{t.title}</p>
        <p className="text-sm text-muted">{t.change}</p>
      </div>
      <ClientPicker clients={clients} chosen={chosen} setChosen={setChosen} tests={tests} />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-faint">Read it after</span>
        {[7, 14, 21, 30].map((d) => (
          <button key={d} onClick={() => setDays(d)} className={`h-8 rounded-full px-3 text-xs ${days === d ? "bg-fg text-bg" : "border border-line text-muted"}`}>
            {d} days
          </button>
        ))}
      </div>
      <p className="text-xs text-faint">
        Starting takes each client&apos;s last 14 days as the baseline. The strategist writes each client&apos;s brief for the test as a suggestion on Home, so a person approves it before anything is made.
      </p>
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button onClick={() => go(true)} disabled={busy || !chosen.length} className="h-10 rounded-brand bg-brand px-5 text-sm font-medium text-white disabled:opacity-40">
          {busy ? "Starting…" : `Start on ${chosen.length} ${chosen.length === 1 ? "client" : "clients"}`}
        </button>
        {!existing && (
          <button onClick={() => go(false)} disabled={busy} className="h-10 rounded-brand border border-line px-4 text-sm text-muted hover:text-fg">
            Keep as an idea
          </button>
        )}
        <button onClick={onClose} className="h-10 px-3 text-sm text-faint hover:text-fg">
          Cancel
        </button>
      </div>
    </Sheet>
  );
}

// ─── Tests ──────────────────────────────────────────────────────────────────

function Tests({ tests, clients }: { tests: LabTest[]; clients: LabClientRow[] }) {
  const groups: [LabTest["status"], string, string][] = [
    ["running", "Running", "Live on clients now"],
    ["proposed", "Ideas", "Saved from the table, not started"],
    ["won", "Won", "Deploy the learning to every client it fits"],
    ["lost", "Flopped", "Take it back to the table and iterate"],
  ];
  if (!tests.length)
    return (
      <div className="grid place-items-center gap-2 rounded-[16px] border border-dashed border-line px-6 py-16 text-center">
        <p className="font-medium">No tests yet</p>
        <p className="max-w-sm text-sm text-muted">Talk an idea through at the round table. When it&apos;s ready, the table proposes a test you can start on the clients it fits.</p>
      </div>
    );
  return (
    <div className="grid gap-8">
      {groups.map(([status, title, hint]) => {
        const list = tests.filter((t) => t.status === status);
        if (!list.length) return null;
        return (
          <section key={status} className="grid gap-3">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="font-heading text-xl">
                {title} <span className="text-faint">{list.length}</span>
              </h2>
              <span className="text-xs text-faint">{hint}</span>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              {list.map((t) => (
                <TestCard key={t.id} t={t} clients={clients} tests={tests} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

const STATUS_TONE: Record<LabTest["status"], string> = { running: "bg-brand-soft text-brand-text", proposed: "bg-surface-2 text-muted", won: "bg-ok-soft text-ok", lost: "bg-bad-soft text-bad" };
const STATUS_LABEL: Record<LabTest["status"], string> = { running: "Running", proposed: "Idea", won: "Won", lost: "Flopped" };

function TestCard({ t, clients, tests }: { t: LabTest; clients: LabClientRow[]; tests: LabTest[] }) {
  const router = useRouter();
  const [calling, setCalling] = useState<null | "won" | "lost">(null);
  const [note, setNote] = useState("");
  const [busy, act] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [deploy, setDeploy] = useState<{ learning: string; clients: { id: string; why: string }[] } | null>(null);
  const name = (id: string) => clients.find((c) => c.id === id)?.name ?? "Client";

  const total = t.startedAt && t.endsAt ? Date.parse(t.endsAt) - Date.parse(t.startedAt) : 0;
  const [now] = useState(() => Date.now());
  const progress = total && t.startedAt ? Math.min(1, (now - Date.parse(t.startedAt)) / total) : 0;
  const daysLeft = t.endsAt ? Math.ceil((Date.parse(t.endsAt) - now) / 86_400_000) : null;
  const changes = t.clients.map((c) => c.change).filter((x): x is number => x != null);
  const avg = changes.length ? Math.round((changes.reduce((a, b) => a + b, 0) / changes.length) * 10) / 10 : null;
  const deployAvg = (() => {
    const xs = t.deployed.map((d) => d.change).filter((x): x is number => x != null);
    return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null;
  })();

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) =>
    act(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) return setError(r.error ?? "Something went wrong.");
      after?.();
      router.refresh();
    });

  return (
    <article className="grid content-start gap-3 rounded-[16px] border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="grid gap-1">
          <span className="flex items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[t.status]}`}>{STATUS_LABEL[t.status]}</span>
            <span className="text-xs text-faint">{METRIC_LABEL[t.metric]}</span>
          </span>
          <p className="font-heading text-lg leading-snug">{t.title}</p>
        </div>
        {avg != null && t.status !== "proposed" && (
          <span className={`tabular shrink-0 text-right font-display text-2xl ${avg < 0 ? "text-ok" : avg > 0 ? "text-bad" : "text-muted"}`}>
            {pct(avg)}
            <span className="block font-sans text-[10px] text-faint">cost per result</span>
          </span>
        )}
      </div>
      <p className="text-sm text-muted">{t.hypothesis}</p>
      <p className="text-sm">
        <span className="text-faint">Changes: </span>
        {t.change}
      </p>

      {t.status === "running" && total > 0 && (
        <div className="grid gap-1">
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full bg-brand" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <p className="text-[11px] text-faint">{daysLeft != null && daysLeft > 0 ? `${daysLeft} days to read it` : "Ready to read"}</p>
        </div>
      )}

      {t.clients.length > 0 && t.status !== "proposed" && (
        <div className="overflow-hidden rounded-[10px] border border-line">
          <table className="w-full text-xs">
            <thead className="bg-surface-2/60 text-faint">
              <tr>
                <th className="px-3 py-1.5 text-left font-normal">Client</th>
                <th className="px-2 py-1.5 text-right font-normal">Before</th>
                <th className="px-2 py-1.5 text-right font-normal">{t.status === "running" ? "Now" : "After"}</th>
                <th className="px-3 py-1.5 text-right font-normal">Change</th>
              </tr>
            </thead>
            <tbody>
              {t.clients.map((c) => (
                <tr key={c.id} className="border-t border-line">
                  <td className="max-w-[160px] truncate px-3 py-1.5">{name(c.id)}</td>
                  <td className="tabular px-2 py-1.5 text-right text-muted">{money(c.before?.cpr)}</td>
                  <td className="tabular px-2 py-1.5 text-right">{money(c.now?.cpr)}</td>
                  <td className={`tabular px-3 py-1.5 text-right ${c.change == null ? "text-faint" : c.change < 0 ? "text-ok" : "text-bad"}`}>{pct(c.change)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(t.briefs.waiting > 0 || t.briefs.approved > 0) && (
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          {t.briefs.waiting > 0 && (
            <Link href="/pipeline" className="text-brand-text hover:underline">
              {t.briefs.waiting} {t.briefs.waiting === 1 ? "brief" : "briefs"} waiting on Home
            </Link>
          )}
          {t.briefs.approved > 0 && <span>· {t.briefs.approved} approved</span>}
          {t.briefs.tickets.map((n) => (
            <Link key={n} href={`/board?t=${n}`} className="rounded-full border border-line px-2 py-0.5 hover:border-faint">
              #{n}
            </Link>
          ))}
        </p>
      )}

      {t.verdict && <p className="rounded-[10px] bg-bg px-3 py-2 text-sm text-muted">&ldquo;{t.verdict}&rdquo;</p>}

      {t.status === "won" && t.deployed.length > 0 && (
        <div className="grid gap-1 rounded-[12px] border border-ok/30 bg-ok/[0.07] p-3">
          <p className="text-sm">{t.learning}</p>
          <p className="text-xs text-muted">
            In {t.deployed.length} {t.deployed.length === 1 ? "client's" : "clients'"} memory
            {deployAvg != null && (
              <>
                {" · "}
                <span className={deployAvg < 0 ? "text-ok" : "text-bad"}>{pct(deployAvg)} cost per result since</span>
              </>
            )}
          </p>
        </div>
      )}

      {error && <p className="text-xs text-bad">{error}</p>}

      {calling ? (
        <div className="grid gap-2">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            autoFocus
            placeholder={calling === "won" ? "What happened? (e.g. cheaper leads on 3 of 4, held for two weeks)" : "Why do you think it flopped?"}
            className="rounded-[10px] border border-line bg-bg px-3 py-2 text-sm outline-none placeholder:text-faint"
          />
          <div className="flex gap-2">
            <button onClick={() => run(() => decideTest(t.id, calling === "won", note), () => setCalling(null))} disabled={busy} className="h-9 rounded-brand bg-fg px-4 text-sm text-bg disabled:opacity-50">
              {busy ? "Saving…" : calling === "won" ? "Call it a win" : "Call it a flop"}
            </button>
            <button onClick={() => setCalling(null)} className="h-9 px-3 text-sm text-faint">
              Back
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2 pt-1">
          {t.status === "proposed" && (
            <>
              <button onClick={() => setStarting(true)} className="h-9 rounded-brand bg-fg px-4 text-sm text-bg">
                Start…
              </button>
              <button onClick={() => run(() => dropTest(t.id))} disabled={busy} className="h-9 px-3 text-sm text-faint hover:text-bad">
                Drop
              </button>
            </>
          )}
          {t.status === "running" && (
            <>
              <button onClick={() => setCalling("won")} className="h-9 rounded-brand border border-ok/50 px-4 text-sm text-ok hover:bg-ok/10">
                It won
              </button>
              <button onClick={() => setCalling("lost")} className="h-9 rounded-brand border border-line px-4 text-sm text-muted hover:text-fg">
                It flopped
              </button>
            </>
          )}
          {t.status === "won" && (
            <button onClick={() => run(async () => { const r = await draftDeploy(t.id); if (r.ok) setDeploy({ learning: r.learning, clients: r.clients }); return r; })} disabled={busy} className="h-9 rounded-brand bg-ok px-4 text-sm font-medium text-white disabled:opacity-60">
              {busy ? "Finding where it fits…" : t.deployed.length ? "Deploy to more clients" : "Deploy the learning"}
            </button>
          )}
          {t.status === "lost" && (
            <button onClick={() => act(async () => { const r = await iterateTest(t.id); if (!r.ok) return setError(r.error); router.push(`/lab?t=${r.threadId}`); })} disabled={busy} className="h-9 rounded-brand bg-fg px-4 text-sm text-bg disabled:opacity-60">
              {busy ? "The table is thinking…" : "Iterate with the table"}
            </button>
          )}
          {t.threadId && (
            <Link href={`/lab?t=${t.threadId}`} className="grid h-9 place-items-center px-3 text-sm text-faint hover:text-fg">
              Conversation
            </Link>
          )}
        </div>
      )}

      {starting && (
        <StartDialog
          t={{ title: t.title, hypothesis: t.hypothesis, change: t.change, metric: t.metric, success: t.success, targetLift: t.targetLift, clientIds: t.clients.map((c) => c.id), duplicateOf: null, duplicateWhy: "" }}
          clients={clients}
          tests={tests}
          threadId={t.threadId}
          existing={t.id}
          onClose={() => setStarting(false)}
        />
      )}
      {deploy && <DeployDialog t={t} draft={deploy} clients={clients} onClose={() => setDeploy(null)} />}
    </article>
  );
}

function DeployDialog({ t, draft, clients, onClose }: { t: LabTest; draft: { learning: string; clients: { id: string; why: string }[] }; clients: LabClientRow[]; onClose: () => void }) {
  const router = useRouter();
  const [learning, setLearning] = useState(draft.learning);
  const [chosen, setChosen] = useState<string[]>(draft.clients.map((c) => c.id));
  const [more, setMore] = useState(false);
  const [busy, act] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const why = new Map(draft.clients.map((c) => [c.id, c.why]));
  return (
    <Sheet onClose={onClose} wide>
      <div className="grid gap-1">
        <p className="text-[11px] uppercase tracking-[0.14em] text-ok">Deploy the learning</p>
        <p className="font-heading text-xl">{t.title}</p>
      </div>
      <label className="grid gap-1.5">
        <span className="text-xs text-faint">The learning, as every agent will read it in client memory</span>
        <textarea value={learning} onChange={(e) => setLearning(e.target.value)} rows={3} className="rounded-[10px] border border-line bg-surface px-3 py-2 text-sm outline-none" />
      </label>
      <div className="grid gap-2">
        <p className="text-xs text-faint">Where it fits (the tested clients get it too)</p>
        {draft.clients.length === 0 && !more && <p className="text-sm text-muted">The table didn&apos;t find other clients it clearly fits. Add some by hand if you know better.</p>}
        {!more &&
          draft.clients.map((c) => {
            const on = chosen.includes(c.id);
            return (
              <label key={c.id} className={`flex cursor-pointer items-start gap-3 rounded-[10px] border px-3 py-2 text-sm ${on ? "border-ok/40 bg-ok/[0.06]" : "border-line"}`}>
                <input type="checkbox" className="mt-1" checked={on} onChange={() => setChosen(on ? chosen.filter((x) => x !== c.id) : [...chosen, c.id])} />
                <span>
                  {clients.find((x) => x.id === c.id)?.name}
                  <span className="block text-xs text-muted">{why.get(c.id)}</span>
                </span>
              </label>
            );
          })}
        {more ? (
          <ClientPicker clients={clients} chosen={chosen} setChosen={setChosen} tests={[]} />
        ) : (
          <button onClick={() => setMore(true)} className="w-fit text-xs text-muted hover:text-fg">
            + Choose from every client
          </button>
        )}
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex gap-2">
        <button
          onClick={() =>
            act(async () => {
              setError(null);
              const r = await deployLearning(t.id, learning, chosen);
              if (!r.ok) return setError(r.error);
              onClose();
              router.refresh();
            })
          }
          disabled={busy}
          className="h-10 rounded-brand bg-ok px-5 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? "Deploying…" : `Deploy to ${new Set([...chosen, ...t.clients.map((c) => c.id)]).size} clients`}
        </button>
        <button onClick={onClose} className="h-10 px-3 text-sm text-faint hover:text-fg">
          Cancel
        </button>
      </div>
    </Sheet>
  );
}

// ─── Library ────────────────────────────────────────────────────────────────

const KINDS = [
  ["note", "Note", "An idea, a rule, anything worth knowing"],
  ["doc", "Brief or doc", "Paste it or upload a text file"],
  ["transcript", "Call transcript", "From a client or team call"],
  ["video", "YouTube video", "The AI watches it through its page and captions"],
  ["link", "Article or link", "The AI reads the page"],
  ["skill", "Skill", "A method the table should use"],
] as const;
const KIND_LABEL = Object.fromEntries(KINDS.map(([k, l]) => [k, l])) as Record<string, string>;

function Library({ sources }: { sources: LabSource[] }) {
  const router = useRouter();
  const [kind, setKind] = useState<string>("note");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [body, setBody] = useState("");
  const [busy, act] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const linky = kind === "video" || kind === "link";
  const reading = sources.some((s) => s.status === "reading");

  useEffect(() => {
    if (!reading) return;
    const t = setInterval(() => router.refresh(), 6000);
    return () => clearInterval(t);
  }, [reading, router]);

  const add = () =>
    act(async () => {
      setError(null);
      const r = await addSource({ kind, title, url: linky ? url : "", body: linky ? "" : body });
      if (!r.ok) return setError(r.error);
      setTitle("");
      setUrl("");
      setBody("");
      router.refresh();
    });

  return (
    <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
      <section className="grid content-start gap-3 rounded-[16px] border border-line bg-surface p-4">
        <p className="font-heading text-lg">Add to the library</p>
        <div className="grid grid-cols-2 gap-1.5">
          {KINDS.map(([k, l, hint]) => (
            <button key={k} onClick={() => setKind(k)} title={hint} className={`rounded-[10px] border px-3 py-2 text-left text-xs ${kind === k ? "border-brand/50 bg-brand-soft text-fg" : "border-line text-muted hover:text-fg"}`}>
              {l}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-faint">{KINDS.find(([k]) => k === kind)?.[2]}</p>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional, the AI names it)" className="h-9 rounded-brand border border-line bg-bg px-3 text-sm outline-none placeholder:text-faint" />
        {linky ? (
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={kind === "video" ? "https://www.youtube.com/watch?v=…" : "https://"} className="h-9 rounded-brand border border-line bg-bg px-3 text-sm outline-none placeholder:text-faint" />
        ) : (
          <>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} placeholder="Paste it here…" className="rounded-[10px] border border-line bg-bg px-3 py-2 text-sm outline-none placeholder:text-faint" />
            <label className="w-fit cursor-pointer text-xs text-muted hover:text-fg">
              Or upload a text file (.txt, .md, .csv, .srt, .vtt)
              <input
                type="file"
                accept=".txt,.md,.markdown,.csv,.srt,.vtt,.json,text/plain"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  setBody(await f.text());
                  if (!title) setTitle(f.name.replace(/\.[a-z0-9]+$/i, ""));
                }}
              />
            </label>
          </>
        )}
        {error && <p className="text-xs text-bad">{error}</p>}
        <button onClick={add} disabled={busy || (linky ? !url.trim() : !body.trim())} className="h-10 rounded-brand bg-brand text-sm font-medium text-white disabled:opacity-40">
          {busy ? "Adding…" : "Add"}
        </button>
        <p className="text-[11px] text-faint">The round table reads everything here. For a PDF or Google Doc, paste its text.</p>
      </section>

      <section className="grid content-start gap-3">
        {sources.length === 0 ? (
          <div className="grid place-items-center gap-2 rounded-[16px] border border-dashed border-line px-6 py-16 text-center">
            <p className="font-medium">Nothing here yet</p>
            <p className="max-w-sm text-sm text-muted">Briefs that worked, call transcripts, a creator&apos;s video breakdown, a framework the team swears by. The table thinks with all of it.</p>
          </div>
        ) : (
          sources.map((s) => (
            <article key={s.id} className="grid gap-2 rounded-[14px] border border-line bg-surface p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="grid min-w-0 gap-0.5">
                  <span className="text-[11px] text-faint">
                    {KIND_LABEL[s.kind] ?? s.kind} · {ago(s.at)} ago{s.words ? ` · ${s.words.toLocaleString("en-US")} words` : ""}
                  </span>
                  <p className="truncate font-medium">{s.title}</p>
                  {s.url && (
                    <a href={s.url} target="_blank" rel="noreferrer" className="truncate text-xs text-muted hover:text-fg">
                      {s.url}
                    </a>
                  )}
                </div>
                <button
                  onClick={async () => {
                    if (!confirm("Remove this from the library?")) return;
                    await deleteSource(s.id);
                    router.refresh();
                  }}
                  className="shrink-0 text-xs text-faint hover:text-bad"
                >
                  Remove
                </button>
              </div>
              {s.status === "reading" ? (
                <p className="flex items-center gap-2 text-xs text-brand-text">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" />
                  Reading it…
                </p>
              ) : s.status === "failed" ? (
                <p className="text-xs text-bad">Couldn&apos;t read it{s.summary ? `: ${s.summary}` : ""}. Paste the text instead.</p>
              ) : (
                s.summary && <p className="whitespace-pre-wrap text-sm text-muted">{s.summary}</p>
              )}
            </article>
          ))
        )}
      </section>
    </div>
  );
}
