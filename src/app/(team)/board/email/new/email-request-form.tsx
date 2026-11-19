"use client";

import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AiProgress } from "@/components/ai-progress";
import { useAgentCall } from "@/components/agent-call-provider";
import { AgentGlyph } from "@/components/assistant-call-parts";
import { CALL_ROLES } from "@/lib/agent-call/call-context";
import { tintOf } from "@/lib/agent-look";
import { pushParams, replaceParams, useParam } from "@/lib/url-state";
import { emailPace, emailPools, requestFit, unitsOfRequest, type EmailAllotment, type Units } from "@/lib/email-allotment-core";
import type { EmailKind, Plan, PlanItem, Start, StartData } from "@/lib/email-request";
import type { CopyDoc } from "@/lib/copy-docs/server";
import { Progress, Spark, Stepper } from "@/app/(team)/requests/new/parts";
import { CopyDocView } from "@/app/(team)/copy/[id]/copy-doc-view";
import { approveCopy, loadCopy, requestCopy } from "@/app/(team)/copy/actions";
import { EmailRequestChat } from "./email-request-chat";
import { planRequest, sendPreview, startFor, writeCopy, type SendPreview } from "./actions";

// The email request, built like the creative request (Client, Start, Write, Review) with the one thing email adds: the
// copy, written during the request with the strategist. Client: the email clients, grouped by pace against their email
// allotment. Start: chat or call the Email Strategist, fill it in, or start from a suggestion (their own ideas, what
// worked for similar brands in their industry, the flows they're missing) or copy already drafted from their SOW.
// Plan: what it is (campaigns, a flow, texts), how many, what for, when, how urgent (the platform, client ID, HQ,
// Figma and website are known, never asked), then the strategist's plan, one line per email, to change. Copy: the
// copywriter's document, every line editable and open to comments (the copywriter learns from both), approved into
// the client's HQ Drive under Email Marketing. Send: the one batched Asana request, every field shown before it's made.
// Each step lives in the address (back returns to it); the request in progress is kept in this browser per client.

type ClientOption = { id: string; name: string; slug: string; industry: string | null };
type StepKey = "client" | "start" | "plan" | "copy" | "send";
const STEPS: { key: StepKey; label: string }[] = [
  { key: "client", label: "Client" },
  { key: "start", label: "Start" },
  { key: "plan", label: "Plan" },
  { key: "copy", label: "Copy" },
  { key: "send", label: "Send" },
];
const KIND: Record<EmailKind, { label: string; one: string; many: string; max: number; unit: string }> = {
  campaign: { label: "Email campaigns", one: "campaign", many: "campaigns", max: 5, unit: "Campaigns" },
  flow: { label: "Email flow", one: "message", many: "messages", max: 6, unit: "Messages in the flow" },
  sms: { label: "SMS campaigns", one: "text", many: "texts", max: 5, unit: "Texts" },
  sms_flow: { label: "SMS flow", one: "text", many: "texts", max: 6, unit: "Texts in the flow" },
};
const PRIORITY = [
  { key: "low", label: "Low" },
  { key: "normal", label: "Normal" },
  { key: "high", label: "High" },
  { key: "urgent", label: "Urgent" },
] as const;
const SOURCE: Record<Start["source"], string> = { client: "Ideas for them", similar: "Worked for similar brands", starter: "Flows they're missing", sow: "From the SOW" };

const initials = (name: string) =>
  name
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

const monthKey = (offset: number) => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
};
const monthName = (key: string) => new Date(`${key}T12:00:00`).toLocaleDateString("en-US", { month: "long", year: new Date(`${key}T12:00:00`).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });

type Work = { kind: EmailKind; count: number; idea: string; month: string | null; priority: string; suggestionId: string | null; from: string | null; plan: Plan | null };
const emptyWork = (): Work => ({ kind: "campaign", count: 3, idea: "", month: monthKey(0), priority: "normal", suggestionId: null, from: null, plan: null });
const SAVE = (clientId: string) => `kz:email-request:${clientId}`;
const readWork = (clientId: string): Work | null => {
  try {
    const raw = sessionStorage.getItem(SAVE(clientId));
    return raw ? (JSON.parse(raw) as Work) : null;
  } catch {
    return null;
  }
};
const saveWork = (clientId: string, w: Work | null) => {
  try {
    if (w) sessionStorage.setItem(SAVE(clientId), JSON.stringify(w));
    else sessionStorage.removeItem(SAVE(clientId));
  } catch {
    // Private windows: the form works, it just isn't kept
  }
};

export function EmailRequestForm({
  clients,
  allotments,
  strategists,
  initialClient,
  initialIdea,
  initialDoc,
}: {
  clients: ClientOption[];
  allotments: Record<string, EmailAllotment>;
  strategists: Record<string, string>;
  initialClient: string | null;
  initialIdea: string | null;
  initialDoc: string | null;
}) {
  const slug = useParam("client");
  const stepParam = useParam("step") as StepKey | null;
  const docParam = useParam("doc") ?? initialDoc;
  const via = useParam("via");
  const client = clients.find((c) => c.slug === slug) ?? clients.find((c) => c.id === initialClient) ?? null;
  const step: StepKey = !client ? "client" : stepParam && STEPS.some((s) => s.key === stepParam) && stepParam !== "client" ? stepParam : docParam ? "copy" : "start";
  const at = STEPS.findIndex((s) => s.key === step);

  const [work, setWorkState] = useState<Work>(emptyWork);
  const setWork = useCallback(
    (patch: Partial<Work>) =>
      setWorkState((w) => {
        const next = { ...w, ...patch };
        if (client) saveWork(client.id, next);
        return next;
      }),
    [client],
  );
  // The request in progress for this client, back after a refresh
  useEffect(() => {
    if (!client) return;
    const saved = readWork(client.id);
    void Promise.resolve().then(() => setWorkState(saved ?? emptyWork()));
  }, [client]);

  const go = (key: StepKey, extra: Record<string, string | null> = {}) => {
    pushParams({ step: key === "start" ? null : key, ...extra });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const jump = (i: number) => {
    const key = STEPS[i].key;
    if (key === "client") pushParams({ client: null, step: null, doc: null, via: null });
    else go(key);
  };

  return (
    <div className="grid gap-8 px-4 pb-24 pt-4 md:px-6 md:pt-6">
      <header className="grid gap-5">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">New email request</p>
          <Link href="/board/email" className="min-h-11 content-center text-[13px] text-muted hover:text-fg md:min-h-0">
            Cancel
          </Link>
        </div>
        <Progress steps={STEPS.map((s) => s.label)} current={at} onJump={jump} />
      </header>

      {step === "client" && (
        <section className="grid gap-6">
          <div className="grid gap-2">
            <h1 className="font-display text-[34px] leading-tight tracking-tight md:text-[44px]">Who&rsquo;s it for?</h1>
            <p className="text-[14.5px] text-muted">Search by name. The plan, the copy and the request go to that client&rsquo;s Email Strategist.</p>
          </div>
          <ClientPicker clients={clients} allotments={allotments} onPick={(c) => pushParams({ client: c.slug, step: null, doc: null, via: null })} />
        </section>
      )}

      {client && step === "start" && (
        <StartStep
          key={client.id}
          client={client}
          allotment={allotments[client.id]}
          strategist={strategists[client.id] ?? null}
          chat={via === "chat"}
          initialIdea={initialIdea}
          onChat={(on) => pushParams({ via: on ? "chat" : null })}
          onPick={(s) => {
            const w: Work = { ...emptyWork(), kind: s.kind, count: s.kind === "flow" || s.kind === "sms_flow" ? 4 : 1, idea: `${s.title}: ${s.idea}`, suggestionId: s.suggestionId, from: SOURCE[s.source], month: s.sendOn ? `${s.sendOn.slice(0, 7)}-01` : monthKey(0) };
            setWorkState(w);
            saveWork(client.id, w);
            go("plan");
          }}
          onBlank={() => {
            setWork({ ...emptyWork() });
            go("plan");
          }}
          onDoc={(id) => go("copy", { doc: id, via: null })}
        />
      )}

      {client && step === "plan" && (
        <PlanStep
          client={client}
          allotment={allotments[client.id]}
          work={work}
          setWork={setWork}
          onWritten={(id) => go("copy", { doc: id })}
          docId={docParam}
        />
      )}

      {client && step === "copy" && docParam && <CopyStep key={docParam} docId={docParam} onSend={() => go("send")} onRewrite={() => go("plan")} />}
      {client && step === "copy" && !docParam && <Empty text="No copy yet: plan the emails first." action="Plan the emails" onAction={() => go("plan")} />}

      {client && step === "send" && docParam && (
        <SendStep
          key={docParam}
          docId={docParam}
          onDone={() => saveWork(client.id, null)}
          onAnother={() => {
            saveWork(client.id, null);
            setWorkState(emptyWork());
            replaceParams({ step: null, doc: null, via: null });
          }}
          onBack={() => go("copy")}
        />
      )}
    </div>
  );
}

function Empty({ text, action, onAction }: { text: string; action: string; onAction: () => void }) {
  return (
    <div className="grid justify-items-start gap-3 rounded-[20px] border border-dashed border-line p-6">
      <p className="text-[14px] text-muted">{text}</p>
      <button type="button" onClick={onAction} className="min-h-11 rounded-full bg-brand px-5 text-[14px] font-medium text-white hover:bg-brand-hover">
        {action}
      </button>
    </div>
  );
}

// ─── The allotment, per pool ─────────────────────────────────────────────────

/** "Campaigns 3/3-5 used · 2 in progress · SMS 0/2 used", each pool coloured by where it stands (paced against the top of its range) */
function AllotmentLine({ a, empty = "No email allotment set" }: { a: EmailAllotment | undefined; empty?: string | null }) {
  if (a?.source === "strategy") return <>Strategy only, no deliverables</>;
  const pools = emailPools(a);
  if (!pools.length) return empty ? <>{empty}</> : null;
  return (
    <>
      {pools.map((p, i) => (
        <Fragment key={p.key}>
          {i > 0 && " · "}
          <span className={p.over ? "text-bad" : p.cap != null && p.used >= p.cap ? "text-ok" : undefined}>
            {p.label} {p.range == null ? `${p.used} asked` : `${p.used}/${p.range} used`}
            {p.over ? ` · ${p.over} over` : ""}
          </span>
          {p.progress > 0 && <span className="text-warn"> · {p.progress} in progress</span>}
          {p.done > 0 && <span> · {p.done} done</span>}
        </Fragment>
      ))}
    </>
  );
}

/** Where the cap comes from, in words */
const capSource = (a: EmailAllotment | undefined) =>
  a?.source === "sow" ? `From their SOW${a.label ? `: ${a.label}` : ""}.` : a?.source === "setup" ? `${a.label ?? "3-Month Setup"}.` : a?.source === "manual" ? "Set by hand for this month." : a?.label ? `${a.label} tier.` : "";

/** The client's allotment as bars: used (delivered and in motion) against the top of each range, with what this request adds */
function AllotmentBars({ a, adding }: { a: EmailAllotment | undefined; adding?: Units | null }) {
  const pools = emailPools(a);
  if (!pools.length)
    return (
      <p className="text-[12.5px] text-faint">
        No email allotment set yet. Pick their tier in Services on the client page (Team &amp; setup), or add their SOW on the Email tab.
      </p>
    );
  return (
    <div className="grid gap-3">
      {pools.map((p) => {
        const add = adding?.[p.key] ?? 0;
        const top = p.cap ?? 0;
        const total = Math.max(top, p.used + add, 1);
        const done = Math.max(0, p.used - p.progress);
        return (
          <div key={p.key} className="grid gap-1.5">
            <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
              <span className="text-fg">{p.label}</span>
              <span className="tabular text-muted">
                {p.used + add}
                {p.range != null ? `/${p.range}` : " asked"}
                {add ? <span className="text-brand-text"> (+{add} with this)</span> : null}
              </span>
            </div>
            <span className="relative flex h-2 overflow-hidden rounded-full bg-surface-2" aria-hidden>
              <span className="h-full bg-ok/80" style={{ width: `${(done / total) * 100}%` }} />
              <span className="h-full bg-warn/80" style={{ width: `${(p.progress / total) * 100}%` }} />
              <span className={`h-full ${p.cap != null && p.used + add > p.cap ? "bg-bad" : "bg-brand"}`} style={{ width: `${(add / total) * 100}%` }} />
            </span>
          </div>
        );
      })}
      <p className="text-[11.5px] text-faint">
        <span className="text-ok">Delivered</span> · <span className="text-warn">in progress</span> both count. {capSource(a)}
      </p>
    </div>
  );
}

// ─── Step 1: the client ──────────────────────────────────────────────────────

function ClientPicker({ clients, allotments, onPick }: { clients: ClientOption[]; allotments: Record<string, EmailAllotment>; onPick: (c: ClientOption) => void }) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const term = q.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!term) return [...clients].sort((a, b) => emailPace(allotments[a.id]).score - emailPace(allotments[b.id]).score || a.name.localeCompare(b.name));
    return clients
      .map((c) => {
        const n = c.name.toLowerCase();
        const i = n.indexOf(term);
        return i < 0 ? null : { c, rank: i === 0 ? 0 : /\s|[-&.]/.test(n[i - 1]) ? 1 : 2 };
      })
      .filter((x): x is { c: ClientOption; rank: number } => x !== null)
      .sort((a, b) => a.rank - b.rank || a.c.name.localeCompare(b.c.name))
      .map((x) => x.c);
  }, [clients, allotments, term]);
  const HEAD = { behind: "Behind pace", pace: "On pace", over: "Over their allotment", none: "No allotment set" } as const;
  return (
    <div className="grid gap-6">
      <div className="relative">
        <svg className="pointer-events-none absolute left-5 top-1/2 -translate-y-1/2 text-faint" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowRight") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, matches.length - 1));
            } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter" && matches[active]) {
              e.preventDefault();
              onPick(matches[active]);
            }
          }}
          placeholder={`Search ${clients.length} clients on email`}
          aria-label="Search clients"
          className="h-16 w-full rounded-[20px] border border-line bg-surface pl-14 pr-5 text-[17px] outline-none transition-colors placeholder:text-faint focus:border-brand/60"
        />
      </div>
      <section className="grid gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">{term ? `${matches.length} ${matches.length === 1 ? "match" : "matches"}` : "All clients"}</p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {matches.map((c, i) => {
            const g = term ? null : emailPace(allotments[c.id]).group;
            const head = g && (i === 0 || emailPace(allotments[matches[i - 1].id]).group !== g) ? HEAD[g] : null;
            const on = Boolean(term) && i === active;
            return (
              <Fragment key={c.id}>
                {head && <p className={`col-span-full mt-2 text-[11px] font-semibold uppercase tracking-[0.16em] ${g === "over" ? "text-bad" : g === "behind" ? "text-warn" : g === "pace" ? "text-ok" : "text-faint"}`}>{head}</p>}
                <button
                  type="button"
                  onClick={() => onPick(c)}
                  className={`group flex min-h-[64px] items-center gap-3 rounded-[16px] border px-3.5 py-3 text-left transition hover:-translate-y-px hover:border-faint hover:bg-surface-2 ${on ? "border-brand/60 bg-surface-2" : "border-line bg-surface"}`}
                >
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[11px] bg-surface-2 text-[12px] font-semibold text-fg group-hover:bg-brand group-hover:text-white">{initials(c.name)}</span>
                  <span className="grid min-w-0">
                    <span className="truncate text-[14.5px]">{c.name}</span>
                    <span className="truncate text-[11.5px] text-faint">
                      <AllotmentLine a={allotments[c.id]} empty={c.industry ?? "No email allotment set"} />
                    </span>
                  </span>
                </button>
              </Fragment>
            );
          })}
        </div>
        {term && !matches.length && <p className="px-1 text-sm text-faint">No email client by that name.</p>}
      </section>
    </div>
  );
}

// ─── Step 2: how to start ────────────────────────────────────────────────────

function StartStep({
  client,
  allotment,
  strategist,
  chat,
  initialIdea,
  onChat,
  onPick,
  onBlank,
  onDoc,
}: {
  client: ClientOption;
  allotment: EmailAllotment | undefined;
  strategist: string | null;
  chat: boolean;
  initialIdea: string | null;
  onChat: (on: boolean) => void;
  onPick: (s: Start) => void;
  onBlank: () => void;
  onDoc: (id: string) => void;
}) {
  const [data, setData] = useState<StartData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { start, live, activeRole } = useAgentCall();
  const picked = useRef(false);
  useEffect(() => {
    let on = true;
    void startFor(client.id).then((r) => {
      if (!on) return;
      if (!r.ok) return setError(r.error);
      setData(r.data);
      // Arriving with a suggestion (?idea=): straight to its plan
      const s = initialIdea ? r.data.ideas.find((x) => x.suggestionId === initialIdea) : null;
      if (s && !picked.current) {
        picked.current = true;
        onPick(s);
      }
    });
    return () => {
      on = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client.id]);

  const look = CALL_ROLES.email_strategist;
  const tint = tintOf(look.icon);
  const call = () => start({ roleKey: "email_strategist", label: look.label, tint, icon: (size) => <AgentGlyph icon={look.icon} tint={tint} size={size} />, context: { screen: "the new email request form", clientId: client.id, client: client.name } });
  const onCall = live && activeRole === "email_strategist";

  const groups = useMemo(() => {
    const ideas = data?.ideas ?? [];
    return (["client", "similar", "starter"] as const).map((k) => ({ key: k, items: ideas.filter((i) => i.source === k) })).filter((g) => g.items.length);
  }, [data]);

  return (
    <section className="grid gap-8">
      <div className="grid gap-5 lg:grid-cols-[1fr_320px] lg:items-start">
        <div className="grid gap-2">
          <p className="text-[12px] text-faint">{client.name}{client.industry ? ` · ${client.industry}` : ""}{strategist ? ` · Email Strategist: ${strategist}` : ""}</p>
          <h1 className="font-display text-[32px] leading-tight tracking-tight md:text-[42px]">How do you want to start?</h1>
          <p className="max-w-xl text-[14.5px] text-muted">Talk it through with the Email Strategist, call them, or fill it in. Either way the strategist plans it with you and the copywriter writes it before it goes to design.</p>
        </div>
        <div className="rounded-[20px] border border-line bg-surface p-4">
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">This cycle</p>
          <AllotmentBars a={allotment} />
          {(data?.scope?.notes || allotment?.notes) && (
            <p className="mt-3 rounded-[12px] bg-surface-2/70 px-3 py-2 text-[12px] leading-relaxed text-muted">
              <span className="text-fg">{data?.scope?.label ?? allotment?.label ?? "This month"}:</span> {data?.scope?.notes ?? allotment?.notes}
            </p>
          )}
        </div>
      </div>

      {chat ? (
        <EmailRequestChat clientId={client.id} clientName={client.name} seed={null} onCopy={onDoc} onBack={() => onChat(false)} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-3">
          <WayIn title="Talk it through" body="Chat with the Email Strategist: what it's for, ideas, then the copy." onClick={() => onChat(true)} icon="chat" primary />
          <WayIn title={onCall ? "Back to the call" : "Call the strategist"} body="Say it out loud. The copy lands here when it's written." onClick={call} icon="call" />
          <WayIn title="Fill it in myself" body="Type, count and what it's for. The strategist plans it from there." onClick={onBlank} icon="form" />
        </div>
      )}

      {error && <p className="rounded-[14px] bg-bad-soft px-4 py-3 text-[13.5px] text-bad">{error}</p>}

      {data && data.drafts.length > 0 && (
        <section className="grid gap-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">Copy waiting for review</p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {data.drafts.map((d) => (
              <button key={d.id} type="button" onClick={() => onDoc(d.id)} className="grid gap-1 rounded-[18px] border border-brand/30 bg-gradient-to-br from-brand/[0.07] to-transparent p-4 text-left transition hover:-translate-y-px hover:border-brand/60">
                <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-brand-text">{d.fromSow ? `Drafted from the SOW${d.month ? ` · ${monthName(d.month)}` : ""}` : "Started earlier"}</span>
                <span className="text-[15px] font-medium text-fg [overflow-wrap:anywhere]">{d.title}</span>
                <span className="text-[12px] text-faint">
                  {d.kind === "flow" ? `Flow · ${d.emails} messages` : `${d.emails} ${d.kind === "sms" ? "text" : "email"}${d.emails === 1 ? "" : "s"}`} · ready to review
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {!data && !error && (
        <div className="grid gap-2 sm:grid-cols-3" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <span key={i} className="h-28 animate-pulse rounded-[18px] bg-surface-2/60" />
          ))}
        </div>
      )}

      {groups.map((g) => (
        <section key={g.key} className="grid gap-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">{g.key === "similar" && data?.industry ? `Worked for similar ${data.industry} brands` : SOURCE[g.key]}</p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {g.items.map((s) => (
              <button key={s.key} type="button" onClick={() => onPick(s)} className="group grid content-start gap-1.5 rounded-[18px] border border-line bg-surface p-4 text-left transition hover:-translate-y-px hover:border-faint hover:bg-surface-2">
                <span className="flex items-center gap-2 text-[11px] text-faint">
                  <span className="rounded-full bg-surface-2 px-2 py-0.5 group-hover:bg-bg">{KIND[s.kind].label.replace(/s$/, "")}</span>
                  {s.sendOn && <span>Send {new Date(`${s.sendOn}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>}
                </span>
                <span className="text-[15px] font-medium leading-snug text-fg [overflow-wrap:anywhere]">{s.title}</span>
                <span className="line-clamp-3 text-[13px] leading-relaxed text-muted">{s.idea}</span>
                {s.why && <span className="text-[12px] text-ok">{s.why}</span>}
              </button>
            ))}
          </div>
        </section>
      ))}
    </section>
  );
}

function WayIn({ title, body, onClick, icon, primary = false }: { title: string; body: string; onClick: () => void; icon: "chat" | "call" | "form"; primary?: boolean }) {
  const path = icon === "chat" ? "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" : icon === "call" ? "M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" : "M4 5h16M4 12h16M4 19h10";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative grid min-h-[132px] content-between gap-4 overflow-hidden rounded-[22px] border p-5 text-left transition hover:-translate-y-0.5 ${primary ? "border-brand/40 bg-gradient-to-br from-brand/[0.12] to-surface hover:border-brand/70 hover:shadow-[0_16px_40px_-20px_rgba(200,16,46,0.7)]" : "border-line bg-surface hover:border-faint"}`}
    >
      <span className={`grid h-11 w-11 place-items-center rounded-[14px] ${primary ? "bg-brand text-white" : "bg-surface-2 text-fg group-hover:bg-brand group-hover:text-white"}`}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d={path} />
        </svg>
      </span>
      <span className="grid gap-1">
        <span className="font-heading text-[17px] text-fg">{title}</span>
        <span className="text-[13px] leading-snug text-muted">{body}</span>
      </span>
    </button>
  );
}

// ─── Step 3: the plan ────────────────────────────────────────────────────────

const chip = (on: boolean) => `min-h-11 rounded-full border px-4 text-[13.5px] transition md:min-h-10 ${on ? "border-fg bg-fg text-bg" : "border-line text-muted hover:border-faint hover:text-fg"}`;

function PlanStep({ client, allotment, work, setWork, onWritten, docId }: { client: ClientOption; allotment: EmailAllotment | undefined; work: Work; setWork: (p: Partial<Work>) => void; onWritten: (docId: string) => void; docId: string | null }) {
  const [busy, setBusy] = useState<null | "plan" | "write">(null);
  const [error, setError] = useState<string | null>(null);
  const k = KIND[work.kind];
  const flow = work.kind === "flow" || work.kind === "sms_flow";
  const fit = requestFit(allotment, work.kind, work.count);
  const months = [monthKey(0), monthKey(1), monthKey(2)];

  const plan = async () => {
    setBusy("plan");
    setError(null);
    const r = await planRequest({ clientId: client.id, kind: work.kind, count: work.count, idea: work.idea, month: flow ? null : work.month, priority: work.priority });
    setBusy(null);
    if (!r.ok) return setError(r.error);
    setWork({ plan: r.plan });
  };
  const write = async () => {
    if (!work.plan) return;
    setBusy("write");
    setError(null);
    const r = await writeCopy({ clientId: client.id, kind: work.kind, plan: work.plan, priority: work.priority, month: flow ? null : work.month, suggestionId: work.suggestionId, docId });
    setBusy(null);
    if (!r.ok) return setError(r.error);
    onWritten(r.docId);
  };
  const setItem = (i: number, patch: Partial<PlanItem>) => work.plan && setWork({ plan: { ...work.plan, items: work.plan.items.map((x, j) => (j === i ? { ...x, ...patch } : x)) } });

  if (busy === "write")
    return (
      <div className="mx-auto w-full max-w-2xl">
        <AiProgress label="email request copy" fallbackMs={90_000} title={`The copywriter is writing ${work.plan?.items.length ?? work.count} ${work.plan?.items.length === 1 ? k.one : k.many}`} steps={["Reading the plan and their voice", "Writing the subject lines", "Writing each email", "Design notes for the designer"]} />
      </div>
    );

  return (
    <section className="grid gap-8 lg:grid-cols-[1fr_320px] lg:items-start">
      <div className="grid gap-8">
        <div className="grid gap-2">
          <p className="text-[12px] text-faint">
            {client.name}
            {work.from ? ` · ${work.from}` : ""}
          </p>
          <h1 className="font-display text-[30px] leading-tight tracking-tight md:text-[38px]">What are we sending?</h1>
        </div>

        <div className="grid gap-3">
          <p className="text-sm font-medium">Type</p>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(KIND) as EmailKind[]).map((key) => (
              <button key={key} type="button" onClick={() => setWork({ kind: key, count: Math.min(work.count, KIND[key].max), plan: null })} className={chip(work.kind === key)}>
                {KIND[key].label}
              </button>
            ))}
          </div>
          <p className="text-[12px] text-faint">{flow ? "A flow counts as one flow in their allotment, however many messages it has." : "Up to 5 in one request: they go to Asana as one task, all the copy in one doc."}</p>
        </div>

        <div className="grid gap-2">
          <Stepper label={k.unit} value={work.count} min={1} max={k.max} onChange={(n) => setWork({ count: n, plan: null })} />
          <p className={`text-[12.5px] ${fit.tone === "warn" ? "text-warn" : fit.tone === "ok" ? "text-ok" : "text-faint"}`}>{fit.text}</p>
        </div>

        <div className="grid gap-2.5">
          <label htmlFor="email-idea" className="text-sm font-medium">
            What&rsquo;s it for?
          </label>
          <textarea
            id="email-idea"
            value={work.idea}
            onChange={(e) => setWork({ idea: e.target.value })}
            rows={4}
            placeholder={flow ? "Welcome series for new subscribers, or optimize the abandoned checkout flow…" : "The holiday sale: early access for VIPs, then the launch, then last call…"}
            className="w-full rounded-[14px] border border-line bg-surface px-4 py-3 text-[16px] leading-relaxed outline-none transition-colors placeholder:text-faint focus:border-brand-text/70 md:text-[15px]"
          />
          <p className="text-[12px] text-faint">Leave it empty and the strategist suggests the best ones for them right now.</p>
        </div>

        {!flow && (
          <div className="grid gap-3">
            <p className="text-sm font-medium">Which month?</p>
            <div className="flex flex-wrap gap-2">
              {months.map((m) => (
                <button key={m} type="button" onClick={() => setWork({ month: m })} className={chip(work.month === m)}>
                  {monthName(m)}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="grid gap-3">
          <p className="text-sm font-medium">Priority</p>
          <div className="flex flex-wrap gap-2">
            {PRIORITY.map((p) => (
              <button key={p.key} type="button" onClick={() => setWork({ priority: p.key })} className={chip(work.priority === p.key)}>
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {!work.plan && (
          <div className="grid gap-3">
            {busy === "plan" ? (
              <AiProgress size="sm" label="email request plan" fallbackMs={45_000} title="The Email Strategist is planning it" steps={["Reading their results and calendar", "Checking what worked", "Planning each email"]} />
            ) : (
              <button type="button" onClick={plan} className="inline-flex min-h-12 items-center justify-center gap-2 justify-self-start rounded-full bg-brand px-6 text-[15px] font-medium text-white shadow-[0_8px_30px_-8px_rgba(178,30,44,0.6)] transition hover:bg-brand-hover active:scale-[0.98] max-sm:w-full">
                <Spark size={13} /> Plan it with the strategist
              </button>
            )}
          </div>
        )}

        {work.plan && (
          <section aria-label="The plan" className="grid gap-4 rounded-[22px] border border-line bg-surface p-4 md:p-6">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-brand-text">The strategist&rsquo;s plan</p>
              <button type="button" onClick={plan} disabled={busy !== null} className="min-h-11 text-[13px] text-muted hover:text-fg disabled:opacity-50 md:min-h-0">
                {busy === "plan" ? "Planning again…" : "Plan again"}
              </button>
            </div>
            <input value={work.plan.title} onChange={(e) => setWork({ plan: { ...work.plan!, title: e.target.value } })} aria-label="Title" className="w-full bg-transparent font-heading text-[20px] text-fg outline-none" />
            <div className="grid gap-3 sm:grid-cols-2">
              <PlanField label="Goal" value={work.plan.goal} onChange={(v) => setWork({ plan: { ...work.plan!, goal: v } })} />
              <PlanField label="Audience" value={work.plan.audience} onChange={(v) => setWork({ plan: { ...work.plan!, audience: v } })} />
            </div>
            <ol className="grid gap-2">
              {work.plan.items.map((it, i) => (
                <li key={i} className="grid gap-2 rounded-[16px] border border-line bg-bg/40 p-3 md:grid-cols-[28px_1fr_1.6fr_140px_auto] md:items-start">
                  <span className="grid h-7 w-7 place-items-center rounded-full bg-surface-2 text-[12px] tabular text-muted">{i + 1}</span>
                  <input value={it.name} onChange={(e) => setItem(i, { name: e.target.value })} aria-label={`Email ${i + 1} name`} className="min-h-11 rounded-[10px] border border-transparent bg-transparent px-2 text-[14.5px] font-medium text-fg outline-none focus:border-line md:min-h-9" />
                  <textarea value={it.angle} onChange={(e) => setItem(i, { angle: e.target.value })} rows={2} aria-label={`Email ${i + 1} angle`} className="resize-none rounded-[10px] border border-transparent bg-transparent px-2 py-1.5 text-[14px] leading-snug text-muted outline-none focus:border-line md:text-[13.5px]" />
                  <input value={it.send} onChange={(e) => setItem(i, { send: e.target.value })} aria-label={`Email ${i + 1} send`} placeholder={flow ? "Timing" : "Send day"} className="min-h-11 rounded-[10px] border border-transparent bg-transparent px-2 text-[13px] text-muted outline-none focus:border-line md:min-h-9" />
                  {work.plan!.items.length > 1 && (
                    <button type="button" onClick={() => setWork({ plan: { ...work.plan!, items: work.plan!.items.filter((_, j) => j !== i) }, count: work.plan!.items.length - 1 })} aria-label={`Remove email ${i + 1}`} className="min-h-11 justify-self-end rounded-full px-2 text-[13px] text-faint hover:text-bad md:min-h-9">
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ol>
            {work.plan.items.length < k.max && (
              <button type="button" onClick={() => setWork({ plan: { ...work.plan!, items: [...work.plan!.items, { name: `${flow ? "Message" : "Email"} ${work.plan!.items.length + 1}`, angle: "", send: "", audience: "", offer: "" }] }, count: work.plan!.items.length + 1 })} className="min-h-11 justify-self-start rounded-full border border-dashed border-line px-4 text-[13px] text-muted hover:border-faint hover:text-fg md:min-h-9">
                Add {flow ? "a message" : "an email"}
              </button>
            )}
            <PlanField label="Notes for the copywriter" value={work.plan.notes} onChange={(v) => setWork({ plan: { ...work.plan!, notes: v } })} />
            <button type="button" onClick={write} disabled={busy !== null} className="inline-flex min-h-12 items-center justify-center gap-2 justify-self-start rounded-full bg-brand px-6 text-[15px] font-medium text-white shadow-[0_8px_30px_-8px_rgba(178,30,44,0.6)] transition hover:bg-brand-hover active:scale-[0.98] disabled:opacity-50 max-sm:w-full">
              <Spark size={13} /> {docId ? "Write the copy again" : "Write the copy"}
            </button>
          </section>
        )}

        {error && <p className="rounded-[14px] bg-bad-soft px-4 py-3 text-[13.5px] text-bad">{error}</p>}
      </div>

      <aside className="grid gap-4 lg:sticky lg:top-6">
        <div className="rounded-[20px] border border-line bg-surface p-4">
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">Their allotment</p>
          <AllotmentBars a={allotment} adding={unitsOfRequest(work.kind, work.count)} />
        </div>
        <div className="rounded-[20px] border border-line bg-surface p-4 text-[12.5px] leading-relaxed text-muted">
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">Already known</p>
          Their email platform, client ID, HQ folder, Figma board and website come from their account and the account sheet. You&rsquo;ll see every field before the request goes to Asana.
        </div>
      </aside>
    </section>
  );
}

function PlanField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="grid gap-1">
      <span className="text-[11.5px] text-faint">{label}</span>
      <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={2} className="resize-y rounded-[12px] border border-line bg-bg/40 px-3 py-2 text-[16px] leading-snug text-fg outline-none focus:border-faint md:text-[13.5px]" />
    </label>
  );
}

// ─── Step 4: the copy ────────────────────────────────────────────────────────

type Loaded = { doc: CopyDoc; changed: string[]; requests: { name: string; url: string }[] };

function useCopy(docId: string) {
  const [state, setState] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    void loadCopy(docId).then((r) => (r.ok ? setState({ doc: r.doc, changed: r.changed, requests: r.requests }) : setError(r.error)));
  }, [docId]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { state, error, reload };
}

function CopyStep({ docId, onSend, onRewrite }: { docId: string; onSend: () => void; onRewrite: () => void }) {
  const { state, error, reload } = useCopy(docId);
  if (error) return <p className="rounded-[14px] bg-bad-soft px-4 py-3 text-[13.5px] text-bad">{error}</p>;
  if (!state)
    return (
      <div className="grid gap-3" aria-busy="true">
        {[0, 1].map((i) => (
          <span key={i} className="h-40 animate-pulse rounded-[22px] bg-surface-2/60" />
        ))}
      </div>
    );
  const d = state.doc;
  return (
    <section className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="font-display text-[30px] leading-tight tracking-tight md:text-[38px]">Review the copy</h1>
          <p className="max-w-2xl text-[14px] text-muted">Tap any line to edit it or comment. Ask for a change at the bottom. The copywriter learns from your edits and comments, for this client or every client when it&rsquo;s about the craft.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={onRewrite} className="min-h-11 rounded-full border border-line px-4 text-[13.5px] text-muted hover:border-faint hover:text-fg md:min-h-10">
            Back to the plan
          </button>
          <button type="button" onClick={onSend} className="min-h-11 rounded-full bg-fg px-5 text-[13.5px] font-medium text-bg transition active:scale-[0.98] md:min-h-10">
            {d.status === "draft" ? "Looks good: send it" : "Continue to send"}
          </button>
        </div>
      </div>
      <CopyDocView key={`${d.version}-${d.status}-${d.comments.length}`} doc={d} changed={state.changed} me="" requests={state.requests} onReload={reload} onRequested={() => onSend()} embedded />
    </section>
  );
}

// ─── Step 5: send ────────────────────────────────────────────────────────────

function SendStep({ docId, onDone, onAnother, onBack }: { docId: string; onDone: () => void; onAnother: () => void; onBack: () => void }) {
  const { state, error: loadError, reload } = useCopy(docId);
  const [preview, setPreview] = useState<SendPreview | null>(null);
  const [busy, setBusy] = useState<null | "approve" | "request">(null);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ name: string; url: string }[] | null>(null);
  const [followerNote, setFollowerNote] = useState<string | null>(null);
  const status = state?.doc.status;
  useEffect(() => {
    void sendPreview(docId).then((r) => (r.ok ? setPreview(r.preview) : setError(r.error)));
  }, [docId, status]);

  const approve = async () => {
    setBusy("approve");
    setError(null);
    const r = await approveCopy(docId);
    setBusy(null);
    if (!r.ok) return setError(r.error);
    reload();
  };
  const request = async () => {
    setBusy("request");
    setError(null);
    const r = await requestCopy(docId, "asana");
    setBusy(null);
    if (!r.ok) return setError(r.error);
    setMade(r.tasks);
    setFollowerNote(r.followerMissing);
    onDone();
    reload();
  };

  const tasks = made ?? (state?.requests.length ? state.requests : state?.doc.asanaUrl ? [{ name: preview?.name ?? "The Asana request", url: state.doc.asanaUrl }] : []);
  const done = status === "requested" || tasks.length > 0;

  return (
    <section className="mx-auto grid w-full max-w-3xl gap-6">
      <div className="grid gap-1">
        <h1 className="font-display text-[30px] leading-tight tracking-tight md:text-[38px]">{done ? "It's in Asana" : "Send it to design"}</h1>
        <p className="text-[14px] text-muted">{done ? "One request on the Email Marketing board, all the copy in one doc in their HQ." : "One request on the Email Marketing board, in Email Requests, with every field filled. No assignee or due date: the strategists set those."}</p>
      </div>

      {(loadError || error) && <p className="rounded-[14px] bg-bad-soft px-4 py-3 text-[13.5px] text-bad">{loadError ?? error}</p>}

      {done && (
        <div className="grid gap-3 rounded-[22px] border border-ok/40 bg-ok-soft/40 p-5">
          {tasks.map((t) => (
            <a key={t.url} href={t.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-[14px] border border-line bg-surface px-4 py-3 text-[14px] text-fg transition-colors hover:border-faint [overflow-wrap:anywhere]">
              <span aria-hidden className="text-ok">↗</span>
              {t.name}
            </a>
          ))}
          {state?.doc.docUrl && (
            <a href={state.doc.docUrl} target="_blank" rel="noopener noreferrer" className="text-[13px] text-muted underline-offset-2 hover:text-fg hover:underline">
              Open the copy doc
            </a>
          )}
          {followerNote && <p className="text-[12.5px] text-muted">{followerNote}</p>}
          <button type="button" onClick={onAnother} className="mt-1 min-h-11 justify-self-start rounded-full bg-fg px-5 text-[13.5px] font-medium text-bg">
            Start another request
          </button>
        </div>
      )}

      {preview && (
        <div className="grid gap-4 rounded-[22px] border border-line bg-surface p-5 md:p-6">
          <div className="grid gap-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">
              {preview.project} › {preview.column} · {preview.counts}
            </p>
            <p className="font-heading text-[18px] text-fg [overflow-wrap:anywhere]">{preview.name}</p>
          </div>
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            {preview.fields
              .filter((f) => f.name !== "Purpose")
              .map((f) => (
                <div key={f.name} className="grid min-w-0 gap-0.5">
                  <dt className="text-[11.5px] text-faint">{f.name}</dt>
                  <dd className={`truncate text-[13.5px] ${f.value ? "text-fg" : "text-warn"}`} title={f.value}>
                    {f.value || "Not on the account sheet yet"}
                  </dd>
                </div>
              ))}
          </dl>
          {preview.fields.find((f) => f.name === "Purpose")?.value && (
            <div className="grid gap-0.5">
              <p className="text-[11.5px] text-faint">Purpose</p>
              <p className="whitespace-pre-line text-[13px] leading-relaxed text-muted [overflow-wrap:anywhere]">{preview.fields.find((f) => f.name === "Purpose")!.value}</p>
            </div>
          )}
          <div className="grid gap-1 rounded-[14px] bg-surface-2/60 px-4 py-3 text-[12.5px] text-muted">
            <span>Copy doc: {preview.folder}</span>
            <span>Following: {preview.follower ? `${preview.follower} (Email Strategist)` : "no Email Strategist on the client yet"}</span>
          </div>
          {!done && (
            <div className="flex flex-wrap items-center gap-2">
              {status === "draft" ? (
                <button type="button" onClick={approve} disabled={busy !== null} className="inline-flex min-h-12 items-center rounded-full bg-brand px-6 text-[14.5px] font-medium text-white transition hover:bg-brand-hover disabled:opacity-50">
                  {busy === "approve" ? "Saving to their HQ…" : "Approve the copy"}
                </button>
              ) : (
                <button type="button" onClick={request} disabled={busy !== null || !status} className="inline-flex min-h-12 items-center rounded-full bg-brand px-6 text-[14.5px] font-medium text-white transition hover:bg-brand-hover disabled:opacity-50">
                  {busy === "request" ? "Creating in Asana…" : "Create the Asana task"}
                </button>
              )}
              <button type="button" onClick={onBack} className="min-h-12 rounded-full px-4 text-[13.5px] text-muted hover:text-fg">
                Back to the copy
              </button>
              {status === "draft" && <span className="text-[12px] text-faint">Approving saves it as a Google Doc in their HQ, under Email Marketing. Then create the task.</span>}
            </div>
          )}
        </div>
      )}
      {!preview && !error && <span className="h-64 animate-pulse rounded-[22px] bg-surface-2/60" aria-busy="true" />}
    </section>
  );
}
