"use client";

import Link from "next/link";
import { useState } from "react";
import { ErrorButtons } from "../settings/error-buttons";
import { toast } from "@/components/toasts";
import type { TranscriptEntry } from "@/lib/chat-transcript";
import { REPORTER_STATUS, SCOPE_LABEL, SECTIONS, TYPES, isOpen, pathLabel, reporterStatus, sectionOf, typeLabel, type FeedbackStatus, type Scope, type Section } from "@/lib/feedback-logic";
import { pushParams, replaceParams, useParam } from "@/lib/url-state";
import { approveFeedback, approveFixMerge, askFixChanges, commentFeedback, planAsk, replyFeedback, setFeedbackAssignee, setFeedbackStatus, wontDoFeedback } from "./actions";

export type Report = {
  id: string;
  type: string;
  message: string;
  summary: string | null;
  pageUrl: string | null;
  route: string | null;
  createdAt: string;
  author: string;
  role: string;
  client: string | null;
  screenshot: string | null;
  viewport: string | null;
  userAgent: string | null;
  version: string | null;
  consoleErrors: string[];
  failedRequests: string[];
  /** Sent from a chat with "Report this" or "Ask for this": where, what went wrong, and the whole chat */
  chat: { label: string; mode: "error" | "cant"; summary: string | null; messages: number; transcriptUrl: string | null } | null;
};

export type Group = {
  id: string;
  title: string;
  summary: string | null;
  type: string;
  area: string;
  status: string;
  assigneeId: string | null;
  assignee: string | null;
  severity: string;
  blocksWork: boolean;
  reports: number;
  people: number;
  priority: number;
  lastReportedAt: string | null;
  fixedAt: string | null;
  error: { fingerprint: string; message: string; count: number; fixUrl: string | null; resolved: boolean } | null;
  items: Report[];
  scope: Scope;
  scopeReason: string | null;
  lane: string;
  plan: string | null;
  fixState: string | null;
  fixIssueUrl: string | null;
  fixPrUrl: string | null;
  fixCommitUrl: string | null;
  events: FeedbackEvent[];
  /** The fix passed every check and waits for approval */
  ready: boolean;
  pending?: boolean;
};

export type FeedbackEvent = { id: string; kind: string; body: string | null; link: string | null; shared: boolean; at: string; actor: string | null };

export type MineItem = {
  groupId: string | null;
  lane: string | null;
  scope: string | null;
  fixState: string | null;
  fixLink: string | null;
  events: FeedbackEvent[];
  id: string;
  type: string;
  message: string;
  route: string | null;
  createdAt: string;
  screenshot: string | null;
  status: string | null;
  title: string | null;
  others: number;
  fixedAt: string | null;
};

const ago = (iso: string | null) => {
  if (!iso) return "";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

const PATH_TONE: Record<ReturnType<typeof pathLabel>["tone"], string> = {
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  brand: "bg-brand-soft text-brand-text",
  muted: "bg-surface-2 text-muted",
};

const EVENT_LABEL: Record<string, string> = {
  triaged: "Read and sized",
  repeat: "Reported again",
  reopened: "Reopened",
  queued: "Auto-fix queued",
  auto_fix_started: "Building the fix",
  build_started: "Building (waits for approval)",
  pr_opened: "Pull request",
  checks_failed: "Checks failed",
  protected: "Held for review",
  no_change: "Nothing to change",
  fix_error: "Couldn't start the fix",
  needs_review: "With the owner",
  fix_ready: "Fix ready to approve",
  merge_approved: "Approved to merge",
  changes_asked: "Changes asked",
  planned: "Planned",
  approved: "Build now",
  comment: "Comment",
  reply: "Reply",
  wont_fix: "Won't do",
  fixed: "Live",
  status: "Status",
  assigned: "Assigned",
};

function PathPill({ g }: { g: { status: string; lane: string; scope: string; fixState: string | null; pending?: boolean; ready?: boolean } }) {
  const p = pathLabel(g);
  return <Pill tone={PATH_TONE[p.tone]}>{p.label}</Pill>;
}

/** What happened to it, in order. */
function Activity({ events }: { events: FeedbackEvent[] }) {
  if (!events.length) return null;
  return (
    <div className="grid gap-2">
      <p className="text-[11px] uppercase tracking-[0.14em] text-faint">Activity</p>
      <ol className="grid gap-2 border-l border-line pl-4">
        {events.map((e) => (
          <li key={e.id} className="relative text-[13px] leading-relaxed">
            <span className={`absolute -left-[21px] top-[7px] h-2 w-2 rounded-full ${e.kind === "fixed" ? "bg-ok" : e.kind === "checks_failed" || e.kind === "fix_error" ? "bg-bad" : e.kind === "needs_review" ? "bg-warn" : "bg-faint"}`} />
            <span className="font-medium">{EVENT_LABEL[e.kind] ?? e.kind}</span>
            <span className="text-faint">
              {" "}
              · {ago(e.at)}
              {e.actor ? ` · ${e.actor}` : ""}
            </span>
            {e.body && <span className="block whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">{e.body}</span>}
            {e.link && (
              <a href={e.link} target="_blank" rel="noreferrer" className="inline-flex min-h-8 items-center text-[12px] text-brand-text hover:underline">
                {/\/commit\//.test(e.link) ? "The commit" : /\/pull\//.test(e.link) ? "The pull request" : "On GitHub"}
              </a>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The whole chat behind a report from a chat, read when opened, in a scrollable panel. */
function TranscriptPanel({ chat }: { chat: NonNullable<Report["chat"]> }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<TranscriptEntry[] | null>(null);
  const [state, setState] = useState<Record<string, unknown> | null>(null);
  const [failed, setFailed] = useState(false);
  const load = async () => {
    setOpen((o) => !o);
    if (entries || !chat.transcriptUrl) return;
    try {
      const t = (await (await fetch(chat.transcriptUrl)).json()) as { entries: TranscriptEntry[]; state: Record<string, unknown> | null };
      setEntries(t.entries ?? []);
      setState(t.state ?? null);
    } catch {
      setFailed(true);
    }
  };
  return (
    <div className="grid gap-2">
      {chat.summary && (
        <p className="text-[13px] leading-relaxed text-muted">
          <span className="text-faint">What went wrong: </span>
          {chat.summary}
        </p>
      )}
      {chat.transcriptUrl && (
        <button type="button" onClick={() => void load()} aria-expanded={open} className="inline-flex min-h-11 w-fit items-center text-[12.5px] text-brand-text hover:underline md:min-h-8">
          {open ? "Hide the chat" : `Read the whole chat${chat.messages ? ` (${chat.messages} messages)` : ""}`}
        </button>
      )}
      {open && (
        <div className="max-h-[420px] overflow-y-auto overscroll-contain rounded-[12px] border border-line bg-bg p-3">
          {failed ? (
            <p className="text-[13px] text-bad">The transcript couldn&apos;t be read. Refresh to try again.</p>
          ) : !entries ? (
            <p className="text-[13px] text-faint">Reading the chat...</p>
          ) : (
            <ol className="grid gap-2.5">
              {state && (
                <li>
                  <details className="text-[12px] text-muted">
                    <summary className="min-h-8 cursor-pointer">What surrounded the chat</summary>
                    <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] leading-relaxed [overflow-wrap:anywhere]">{JSON.stringify(state, null, 2)}</pre>
                  </details>
                </li>
              )}
              {entries.map((e, i) => (
                <li key={i} className={`grid gap-1 ${e.role === "user" ? "justify-items-end" : ""}`}>
                  <span className="text-[11px] text-faint">
                    {e.role === "user" ? (e.name ?? "Person") : e.role === "tool" ? `Tool · ${e.name ?? ""}${e.ok === false ? " · failed" : ""}` : (e.name ?? "AI")}
                    {e.at ? ` · ${new Date(e.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}
                  </span>
                  {e.text && (
                    <p
                      className={`max-w-[92%] whitespace-pre-wrap rounded-[12px] px-3 py-2 leading-relaxed [overflow-wrap:anywhere] ${
                        e.role === "user" ? "bg-ink/[0.06] text-[13px] text-fg" : e.role === "tool" ? `font-mono text-[11px] ${e.ok === false ? "bg-bad-soft/40 text-bad" : "bg-surface-2 text-muted"}` : "bg-surface-2/60 text-[13px] text-fg"
                      }`}
                    >
                      {e.text}
                    </p>
                  )}
                  {e.error && (
                    <p className="max-w-[92%] rounded-[12px] bg-bad-soft/40 px-3 py-2 text-[12.5px] text-bad [overflow-wrap:anywhere]">
                      {e.error.code ? `${e.error.code}: ` : ""}
                      {e.error.text}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

/** Who asked, in their words (newest first), with their screenshot, the page, and the chat behind it. */
function InTheirWords({ g }: { g: Group }) {
  return (
    <div className="grid gap-2">
      <p className="text-[11px] uppercase tracking-[0.14em] text-faint">In their words</p>
      <ul className="grid gap-2">
        {[...g.items]
          .sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt))
          .slice(0, 4)
          .map((r) => (
            <li key={r.id} className="grid gap-2.5 rounded-[12px] border border-line bg-bg/60 p-3">
              <div className="flex min-w-0 flex-col gap-2.5 md:flex-row">
                <div className="grid min-w-0 flex-1 gap-1">
                  <p className="text-[12px] text-faint">
                    {r.author}
                    {r.role ? ` (${r.role})` : ""} · {ago(r.createdAt)}
                    {r.client ? ` · ${r.client}` : ""}
                    {r.chat ? ` · from ${r.chat.label}` : ""}
                  </p>
                  <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-fg [overflow-wrap:anywhere]">{r.message}</p>
                  {r.pageUrl && (
                    <a href={r.pageUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-8 w-fit max-w-full items-center truncate text-[12px] text-muted underline-offset-2 hover:text-fg hover:underline">
                      On {r.route ?? r.pageUrl}
                    </a>
                  )}
                </div>
                {r.screenshot && (
                  <a href={r.screenshot} target="_blank" rel="noreferrer" className="block shrink-0 overflow-hidden rounded-[10px] border border-line md:w-36">
                    {/* eslint-disable-next-line @next/next/no-img-element -- a signed, private screenshot */}
                    <img src={r.screenshot} alt="Their screenshot" className="max-h-40 w-full object-cover object-top" />
                  </a>
                )}
              </div>
              {r.chat && <TranscriptPanel chat={r.chat} />}
            </li>
          ))}
      </ul>
      {g.items.length > 4 && (
        <button type="button" onClick={() => pushParams({ g: g.id })} className="min-h-11 w-fit text-[12.5px] text-muted underline-offset-2 hover:text-fg hover:underline md:min-h-8">
          All {g.items.length} reports
        </button>
      )}
    </div>
  );
}

type Patch = Partial<Pick<Group, "status" | "lane" | "fixState">>;

/** The card's head: what kind, where, how often, the title and the summary. */
function CardHead({ g, why }: { g: Group; why: string | null }) {
  const people = [...new Map(g.items.map((r) => [r.author, r.role])).entries()];
  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <PathPill g={g} />
        <span className="text-[12.5px] text-muted">
          {g.area} · {g.reports} {g.reports === 1 ? "report" : "reports"} from {g.people} {g.people === 1 ? "person" : "people"} · {ago(g.lastReportedAt)}
        </span>
      </div>
      <button type="button" onClick={() => pushParams({ g: g.id })} className="min-h-11 text-left font-heading text-[17px] leading-snug hover:underline md:min-h-0">
        {g.title}
      </button>
      {g.summary && <p className="text-sm leading-relaxed text-muted">{g.summary}</p>}
      {why && <p className="text-[12.5px] text-faint">{why}</p>}
      {people.length > 0 && <p className="text-[12.5px] text-faint">From {people.map(([name, role]) => (role ? `${name} (${role})` : name)).join(", ")}</p>}
    </div>
  );
}

const primary = "min-h-11 rounded-full bg-brand px-5 text-[13.5px] font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-50 md:min-h-9";
const secondary = "min-h-11 rounded-full border border-line px-5 text-[13.5px] text-fg hover:border-faint/60 disabled:opacity-50 md:min-h-9";
const quiet = "min-h-11 rounded-full px-4 text-[13.5px] text-muted hover:text-fg disabled:opacity-50 md:min-h-9";

/**
 * A fix that waits on the owner: built on a pull request (it touches a safety rail), or something the pipeline
 * couldn't finish. Approve and merge has the workflow check it again and merge it; Ask for changes has Claude build it
 * again with the note. A stuck one can be sent again, or closed.
 */
function ApprovalCard({ g, onDone }: { g: Group; onDone: (patch: Patch) => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const built = g.lane === "build" && Boolean(g.fixPrUrl);
  const why = [...g.events].reverse().find((e) => e.kind === "fix_ready" || e.kind === "needs_review")?.body ?? g.scopeReason;
  const run = async (kind: "merge" | "changes" | "again" | "wont") => {
    if ((kind === "changes" || kind === "wont") && !note.trim()) {
      toast({ tone: "warn", title: kind === "changes" ? "Say what to change first" : "Say why, so the people who reported it understand" });
      return;
    }
    setBusy(kind);
    if (kind === "wont") onDone({ status: "wont_fix" });
    if (kind === "again" || kind === "changes") onDone({ lane: "build", fixState: "working" });
    const r = kind === "merge" ? await approveFixMerge(g.id) : kind === "changes" ? await askFixChanges(g.id, note) : kind === "again" ? await approveFeedback(g.id, note) : await wontDoFeedback(g.id, note);
    setBusy(null);
    if ("error" in r) {
      onDone({ status: g.status, lane: g.lane, fixState: g.fixState });
      toast({ tone: "bad", title: r.error });
      return;
    }
    setNote("");
    toast({
      tone: "ok",
      title: kind === "merge" ? "Approved" : kind === "changes" ? "Sent back to Claude" : kind === "again" ? "Sent to Claude again" : "Marked won't do",
      body: kind === "merge" ? "Every check runs once more, then it merges and goes live. The people who reported it hear." : kind === "wont" ? "The people who reported it were told why." : "A new pull request comes back here for your approval.",
    });
  };
  return (
    <li className="grid gap-4 rounded-[18px] border border-warn/35 bg-surface p-4 md:p-5">
      <CardHead g={g} why={why ? `Why it needs you: ${why}` : null} />
      {(g.fixPrUrl || g.fixIssueUrl) && (
        <p className="flex flex-wrap gap-x-4 text-[12.5px]">
          {g.fixPrUrl && (
            <a href={g.fixPrUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center text-brand-text hover:underline md:min-h-8">
              The pull request
            </a>
          )}
          {g.fixIssueUrl && (
            <a href={g.fixIssueUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center text-muted hover:text-fg hover:underline md:min-h-8">
              The issue
            </a>
          )}
        </p>
      )}
      <InTheirWords g={g} />
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder={built ? "What to change, if you ask for changes" : "A note for Claude, or why not"}
        className="w-full resize-none rounded-[12px] border border-line bg-bg px-3.5 py-2.5 text-[15px] outline-none placeholder:text-faint focus:border-brand-text/70 md:text-sm"
      />
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {built ? (
          <>
            <button type="button" disabled={Boolean(busy)} onClick={() => void run("merge")} className={primary}>
              {busy === "merge" ? "Approving..." : "Approve and merge"}
            </button>
            <button type="button" disabled={Boolean(busy)} onClick={() => void run("changes")} className={secondary}>
              {busy === "changes" ? "Sending..." : "Ask for changes"}
            </button>
          </>
        ) : (
          <button type="button" disabled={Boolean(busy)} onClick={() => void run("again")} className={primary}>
            {busy === "again" ? "Sending..." : "Send to Claude again"}
          </button>
        )}
        <button type="button" disabled={Boolean(busy)} onClick={() => void run("wont")} className={quiet}>
          Won&apos;t do
        </button>
      </div>
    </li>
  );
}

/**
 * An Ask: a feature request or a note from the team. Nothing is built until the owner says so. Build now has Claude
 * open a pull request (it waits for approval); Plan it puts it on the roadmap; Ask for more goes to the people who
 * asked; Won't do tells them why.
 */
function AskCard({ g, onDone }: { g: Group; onDone: (patch: Patch) => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (kind: "build" | "plan" | "more" | "wont") => {
    if ((kind === "more" || kind === "wont") && !note.trim()) {
      toast({ tone: "warn", title: kind === "more" ? "Write the question first" : "Say why, so the people who asked understand" });
      return;
    }
    setBusy(kind);
    if (kind === "build") onDone({ lane: "build", status: "planned", fixState: "working" });
    if (kind === "plan") onDone({ status: "planned" });
    if (kind === "wont") onDone({ status: "wont_fix" });
    const r = kind === "build" ? await approveFeedback(g.id, note) : kind === "plan" ? await planAsk(g.id) : kind === "more" ? await commentFeedback(g.id, note) : await wontDoFeedback(g.id, note);
    setBusy(null);
    if ("error" in r) {
      onDone({ lane: g.lane, status: g.status, fixState: g.fixState });
      toast({ tone: "bad", title: r.error });
      return;
    }
    setNote("");
    toast({
      tone: "ok",
      title: kind === "build" ? "Building it" : kind === "plan" ? "Planned" : kind === "more" ? "Asked" : "Marked won't do",
      body:
        kind === "build"
          ? "Claude is opening a pull request from the plan. It comes back here for your approval."
          : kind === "plan"
            ? "It's on the roadmap under Requested by the team, and the people who asked were told."
            : kind === "more"
              ? "notified" in r && r.notified
                ? `${r.notified} ${r.notified === 1 ? "person" : "people"} will see it.`
                : "Saved on the item."
              : "The people who asked were told why.",
    });
  };
  return (
    <li className="grid gap-4 rounded-[18px] border border-line bg-surface p-4 md:p-5">
      <CardHead g={g} why={g.scopeReason} />
      <InTheirWords g={g} />
      {g.plan && (
        <div className="rounded-[12px] bg-surface-2/70 p-3.5">
          <p className="text-[11px] uppercase tracking-[0.14em] text-faint">Proposed plan</p>
          <p className="mt-1 whitespace-pre-wrap text-[13.5px] leading-relaxed">{g.plan}</p>
        </div>
      )}
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder="A note for Claude, a question for the people who asked, or why not"
        className="w-full resize-none rounded-[12px] border border-line bg-bg px-3.5 py-2.5 text-[15px] outline-none placeholder:text-faint focus:border-brand-text/70 md:text-sm"
      />
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <button type="button" disabled={Boolean(busy)} onClick={() => void run("build")} className={primary}>
          {busy === "build" ? "Starting..." : "Build now"}
        </button>
        {g.status !== "planned" && (
          <button type="button" disabled={Boolean(busy)} onClick={() => void run("plan")} className={secondary}>
            {busy === "plan" ? "Planning..." : "Plan it"}
          </button>
        )}
        <button type="button" disabled={Boolean(busy)} onClick={() => void run("more")} className={secondary}>
          {busy === "more" ? "Sending..." : "Ask for more"}
        </button>
        <button type="button" disabled={Boolean(busy)} onClick={() => void run("wont")} className={quiet}>
          Won&apos;t do
        </button>
      </div>
    </li>
  );
}

const select =
  "h-11 min-w-0 rounded-full border border-line bg-bg pl-3.5 pr-8 text-[13px] text-fg outline-none transition-colors hover:border-faint/60 focus:border-brand-text/70 md:h-9";

function Pill({ children, tone }: { children: React.ReactNode; tone: string }) {
  return <span className={`inline-flex h-6 items-center whitespace-nowrap rounded-full px-2.5 text-[11.5px] font-medium ${tone}`}>{children}</span>;
}

export function FeedbackView({ isExec, groups, mine, staff, monthAgo }: { isExec: boolean; groups: Group[]; mine: MineItem[]; staff: { id: string; name: string }[]; monthAgo: string }) {
  const param = useParam("tab");
  const tab = isExec && param !== "mine" ? "all" : "mine";
  return (
    <div className="mx-auto grid max-w-4xl gap-7">
      <header className="grid gap-1.5">
        <p className="text-xs uppercase tracking-[0.18em] text-faint">Feedback</p>
        <h1 className="font-display text-3xl tracking-tight md:text-4xl">{tab === "all" ? "What the team runs into" : "My feedback"}</h1>
        <p className="max-w-xl text-sm text-muted">
          {tab === "all"
            ? "Every bug and ask from the bubble and from Report this in the chats, repeats grouped together. Bugs are fixed right away; you approve the fixes that touch the safety rails and decide on the asks."
            : "What you've reported, from the bubble or a chat, and where each one stands: received, building, fix ready, live, or with the owner. You'll hear at each step."}
        </p>
      </header>

      {isExec && (
        <div className="grid w-full grid-cols-2 gap-1 rounded-full bg-surface-2 p-1 sm:w-80" role="tablist">
          {(
            [
              ["all", "Everyone's"],
              ["mine", "Mine"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => pushParams({ tab: key === "all" ? null : key, g: null })}
              className={`min-h-11 rounded-full text-[13.5px] transition-colors md:min-h-9 ${tab === key ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg"}`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {tab === "all" ? <Everyone groups={groups} staff={staff} monthAgo={monthAgo} /> : <Mine items={mine} />}
    </div>
  );
}

function Everyone({ groups, staff, monthAgo }: { groups: Group[]; staff: { id: string; name: string }[]; monthAgo: string }) {
  const param = useParam("section") as Section | null;
  const type = useParam("type");
  const area = useParam("area");
  const opened = useParam("g");
  // Saved on change: shown at once, put back if the save fails
  const [local, setLocal] = useState<Record<string, Patch & Partial<Pick<Group, "assigneeId">>>>({});
  const view = groups.map((g) => ({ ...g, ...local[g.id] }));
  const by = (s: Section) => view.filter((g) => sectionOf(g) === s);
  const counts = Object.fromEntries(SECTIONS.map((s) => [s.key, by(s.key).length])) as Record<Section, number>;
  // Lands where the owner is needed first
  const section: Section = param && SECTIONS.some((s) => s.key === param) ? param : counts.approval ? "approval" : counts.asks ? "asks" : "fixing";
  const meta = SECTIONS.find((s) => s.key === section)!;
  const patch = (id: string) => (p: Patch) => setLocal((l) => ({ ...l, [id]: { ...l[id], ...p } }));

  const recent = view.flatMap((g) => g.items).filter((r) => r.createdAt > monthAgo);
  const live30 = view.filter((g) => g.fixedAt && g.fixedAt > monthAgo).length;

  const save = async (g: Group, p: Partial<Pick<Group, "status" | "assigneeId">>) => {
    const before = local[g.id];
    setLocal((l) => ({ ...l, [g.id]: { ...l[g.id], ...p } }));
    const r = p.status !== undefined ? await setFeedbackStatus(g.id, p.status as FeedbackStatus) : await setFeedbackAssignee(g.id, p.assigneeId ?? null);
    if ("error" in r) {
      setLocal((l) => ({ ...l, [g.id]: before ?? {} }));
      toast({ tone: "bad", title: r.error });
      return;
    }
    if (p.status === "fixed") {
      const n = "notified" in r ? (r.notified ?? 0) : 0;
      toast({ tone: "ok", title: `Fixed: ${g.title}`, body: n ? `${n} ${n === 1 ? "person who reported it was" : "people who reported it were"} told.` : "Nobody else reported it, so there was no one to tell." });
    }
  };

  const list = by(section)
    .filter((g) => (!type || g.type === type) && (!area || g.area === area || g.pending))
    .sort((a, b) => (section === "done" ? (b.fixedAt ?? b.lastReportedAt ?? "").localeCompare(a.fixedAt ?? a.lastReportedAt ?? "") : 0));
  const areas = [...new Set(by(section).filter((g) => !g.pending).map((g) => g.area))].sort();

  return (
    <div className="grid gap-5">
      <div className="grid grid-cols-3 gap-2 md:gap-3">
        {(
          [
            [counts.fixing, "fixing now"],
            [recent.length, "reports in 30 days"],
            [live30, "live in 30 days"],
          ] as const
        ).map(([n, label]) => (
          <div key={label} className="rounded-[14px] border border-line bg-surface px-3.5 py-3 md:px-5 md:py-4">
            <p className="font-display text-2xl tracking-tight md:text-3xl">{n}</p>
            <p className="text-[12px] text-muted">{label}</p>
          </div>
        ))}
      </div>

      <nav aria-label="Sections" className="grid grid-cols-2 gap-1 rounded-[18px] bg-surface-2 p-1 md:flex md:rounded-full">
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            type="button"
            aria-current={section === s.key ? "page" : undefined}
            onClick={() => pushParams({ section: s.key, g: null, type: null, area: null })}
            className={`flex min-h-11 items-center justify-center gap-2 rounded-[14px] px-3 text-[13.5px] transition-colors md:min-h-9 md:flex-1 md:rounded-full ${section === s.key ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg"}`}
          >
            {s.label}
            {counts[s.key] > 0 && (
              <span className={`inline-grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-[11px] font-medium ${s.key === "approval" ? "bg-warn-soft text-warn" : s.key === "asks" ? "bg-brand-soft text-brand-text" : "bg-ink/[0.06] text-muted"}`}>
                {counts[s.key]}
              </span>
            )}
          </button>
        ))}
      </nav>
      <p className="-mt-2 text-[13px] text-muted">{meta.about}</p>

      {(section === "fixing" || section === "done") && by(section).length > 3 && (
        <div className="flex flex-wrap gap-2">
          <select aria-label="Type" value={type ?? ""} onChange={(e) => pushParams({ type: e.target.value || null })} className={select}>
            <option value="">Every type</option>
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <select aria-label="Area" value={area ?? ""} onChange={(e) => pushParams({ area: e.target.value || null })} className={select}>
            <option value="">Every area</option>
            {areas.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
      )}

      {list.length === 0 ? (
        <div className="grid justify-items-center gap-1 rounded-[18px] border border-dashed border-line px-6 py-14 text-center">
          <p className="font-heading text-[17px]">{section === "approval" ? "Nothing waiting on you" : section === "asks" ? "No asks right now" : section === "fixing" ? "Nothing in the pipeline" : "Nothing done yet"}</p>
          <p className="max-w-sm text-sm text-muted">
            {section === "fixing" ? "When someone reports a bug, from the bubble or right under a chat message, it starts here." : section === "approval" ? "Fixes that touch the safety rails come here once every check has passed." : section === "asks" ? "Feature requests and notes from the team land here." : "Live fixes and decisions show here."}
          </p>
        </div>
      ) : section === "approval" ? (
        <ul className="grid gap-3">
          {list.map((g) => (
            <ApprovalCard key={g.id} g={g} onDone={patch(g.id)} />
          ))}
        </ul>
      ) : section === "asks" ? (
        <ul className="grid gap-3">
          {list.map((g) => (
            <AskCard key={g.id} g={g} onDone={patch(g.id)} />
          ))}
        </ul>
      ) : (
        <ol className="grid gap-2.5">
          {list.map((g) => {
            const expanded = opened === g.id;
            return (
              <li key={g.id} className={`rounded-[16px] border bg-surface transition-colors ${expanded ? "border-faint/50" : "border-line"}`}>
                <div className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:gap-4 md:px-5">
                  <button type="button" onClick={() => (expanded ? replaceParams({ g: null }) : pushParams({ g: g.id }))} aria-expanded={expanded} className="flex min-h-11 min-w-0 flex-1 items-start gap-3 text-left">
                    <span className="grid min-w-0 gap-1">
                      <span className="text-[15px] font-medium leading-snug [overflow-wrap:anywhere]">{g.title}</span>
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted">
                        <span>{typeLabel(g.type)}</span>
                        <span className="text-faint">·</span>
                        <span>{g.area}</span>
                        <span className="text-faint">·</span>
                        <span className={g.reports > 1 ? "font-medium text-fg" : ""}>
                          {g.reports} {g.reports === 1 ? "report" : "reports"}
                          {g.people > 1 ? ` from ${g.people} people` : ""}
                        </span>
                        <span className="text-faint">·</span>
                        <span>{ago(section === "done" ? (g.fixedAt ?? g.lastReportedAt) : g.lastReportedAt)}</span>
                        {g.severity === "high" && <Pill tone="bg-bad-soft text-bad">High</Pill>}
                        {g.blocksWork && <Pill tone="bg-bad-soft text-bad">Blocks work</Pill>}
                      </span>
                    </span>
                  </button>
                  <div className="flex items-center gap-2 md:shrink-0">
                    <PathPill g={g} />
                    {(g.fixPrUrl || g.fixCommitUrl) && (
                      <a href={g.fixCommitUrl ?? g.fixPrUrl!} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center px-2 text-[12.5px] text-brand-text hover:underline md:min-h-8">
                        {g.fixCommitUrl ? "Commit" : "PR"}
                      </a>
                    )}
                  </div>
                </div>

                {expanded && (
                  <div className="grid gap-4 border-t border-line px-4 pb-5 pt-4 md:px-5">
                    {g.summary && <p className="text-sm leading-relaxed text-muted">{g.summary}</p>}
                    {!g.pending && (
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <select aria-label="Assignee" value={g.assigneeId ?? ""} onChange={(e) => void save(g, { assigneeId: e.target.value || null })} className={`${select} w-full sm:w-56`}>
                          <option value="">Nobody on it</option>
                          {staff.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                            </option>
                          ))}
                        </select>
                        {g.status !== "fixed" ? (
                          <button type="button" onClick={() => void save(g, { status: "fixed" })} className={secondary}>
                            Mark live
                          </button>
                        ) : (
                          g.fixedAt && <span className="text-[13px] text-ok">Live {ago(g.fixedAt)}, everyone who reported it was told</span>
                        )}
                      </div>
                    )}
                    {g.error && (
                      <div className="grid gap-2 rounded-[12px] border border-line bg-bg p-3 md:flex md:items-center md:justify-between">
                        <div className="min-w-0">
                          <p className="text-[12px] uppercase tracking-[0.14em] text-faint">The error monitor saw this</p>
                          <p className="mt-0.5 font-mono text-[12px] text-muted [overflow-wrap:anywhere]">
                            {g.error.message} · {g.error.count}× {g.error.resolved ? "· marked fixed" : ""}
                          </p>
                        </div>
                        {!g.error.resolved && <ErrorButtons fingerprint={g.error.fingerprint} fixing={Boolean(g.error.fixUrl)} />}
                      </div>
                    )}
                    {!g.pending && (
                      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-muted">
                        <span>
                          {SCOPE_LABEL[g.scope]}
                          {g.scopeReason ? `: ${g.scopeReason}` : ""}
                        </span>
                        {g.fixIssueUrl && (
                          <a href={g.fixIssueUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-8 items-center text-brand-text hover:underline">
                            GitHub issue
                          </a>
                        )}
                      </p>
                    )}
                    <ul className="grid gap-3">
                      {g.items.map((r) => (
                        <ReportCard key={r.id} r={r} />
                      ))}
                    </ul>
                    <Activity events={g.events} />
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function ReportCard({ r }: { r: Report }) {
  const [more, setMore] = useState(false);
  const browser = r.userAgent?.match(/(Edg|Chrome|Firefox|Safari)\/[\d.]+/)?.[0]?.replace("Edg", "Edge") ?? null;
  const device = r.userAgent ? (/iPhone|iPad/.test(r.userAgent) ? "iOS" : /Android/.test(r.userAgent) ? "Android" : /Mac OS/.test(r.userAgent) ? "Mac" : /Windows/.test(r.userAgent) ? "Windows" : "") : "";
  const path = r.route ?? (r.pageUrl ? new URL(r.pageUrl).pathname : null);
  return (
    <li className="grid gap-3 rounded-[12px] bg-surface-2/60 p-3.5 md:flex md:items-start md:gap-4">
      <div className="grid min-w-0 flex-1 gap-1.5">
        <p className="text-[12.5px] text-muted">
          <span className="font-medium text-fg">{r.author}</span>
          {r.role && ` · ${r.role}`} · {ago(r.createdAt)}
          {r.type && ` · ${typeLabel(r.type)}`}
        </p>
        <p className="whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]">{r.message}</p>
        <p className="flex flex-wrap gap-x-2 text-[12px] text-faint">
          {path && (
            <Link href={path} className="inline-flex min-h-8 items-center text-brand-text hover:underline [overflow-wrap:anywhere]">
              {path.length > 60 ? `${path.slice(0, 57)}...` : path}
            </Link>
          )}
          {r.client && <span className="inline-flex min-h-8 items-center">· {r.client}</span>}
          {(r.viewport || browser) && (
            <span className="inline-flex min-h-8 items-center">
              · {[r.viewport, device, browser].filter(Boolean).join(" · ")}
            </span>
          )}
          {r.version && <span className="inline-flex min-h-8 items-center">· v{r.version.slice(0, 7)}</span>}
        </p>
        {(r.consoleErrors.length > 0 || r.failedRequests.length > 0) && (
          <div>
            <button type="button" onClick={() => setMore((m) => !m)} aria-expanded={more} className="min-h-9 text-[12px] text-muted hover:text-fg">
              {more ? "Hide" : "Show"} {r.consoleErrors.length + r.failedRequests.length} recent errors and failed requests
            </button>
            {more && (
              <ul className="mt-1 grid gap-1 rounded-[10px] bg-bg p-2.5 font-mono text-[11px] leading-relaxed text-muted [overflow-wrap:anywhere]">
                {r.consoleErrors.map((e, i) => (
                  <li key={`e${i}`}>{e}</li>
                ))}
                {r.failedRequests.map((e, i) => (
                  <li key={`r${i}`}>{e}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      {r.screenshot && (
        <a href={r.screenshot} target="_blank" rel="noreferrer" className="block shrink-0 overflow-hidden rounded-[10px] border border-line md:w-40">
          {/* eslint-disable-next-line @next/next/no-img-element -- a signed, private screenshot */}
          <img src={r.screenshot} alt="Screenshot they sent" className="aspect-[16/10] w-full object-cover object-top" />
        </a>
      )}
    </li>
  );
}

/** Answer the team's question about something you reported. */
function Reply({ groupId }: { groupId: string }) {
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setSent(true);
    setText("");
    const r = await replyFeedback(groupId, body);
    if ("error" in r) {
      setSent(false);
      setText(body);
      toast({ tone: "bad", title: r.error });
    }
  };
  if (sent) return <p className="text-[12.5px] text-ok">Reply sent to the team.</p>;
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={1} placeholder="Reply to the team" className="min-h-11 w-full flex-1 resize-none rounded-[12px] border border-line bg-bg px-3.5 py-2.5 text-[15px] outline-none placeholder:text-faint focus:border-brand-text/70 md:text-sm" />
      <button type="button" onClick={() => void send()} disabled={!text.trim()} className="min-h-11 rounded-full border border-line px-5 text-[13.5px] text-fg hover:border-faint/60 disabled:opacity-50">
        Reply
      </button>
    </div>
  );
}

function Mine({ items }: { items: MineItem[] }) {
  if (!items.length)
    return (
      <div className="grid justify-items-center gap-1 rounded-[18px] border border-dashed border-line px-6 py-14 text-center">
        <p className="font-heading text-[17px]">Nothing sent yet</p>
        <p className="max-w-sm text-sm text-muted">Spot a bug, have an idea, or get stuck? Use the bubble in the corner of any page (or Ctrl+Shift+F). It takes a few seconds.</p>
      </div>
    );
  return (
    <ul className="grid gap-2.5">
      {items.map((m) => {
        const status = m.status ?? "received";
        return (
          <li key={m.id} className={`grid gap-2 rounded-[16px] border bg-surface p-4 md:px-5 ${status === "fixed" ? "border-ok/40" : "border-line"}`}>
            <div className="flex items-start justify-between gap-3">
              <p className="text-[12.5px] text-muted">
                {typeLabel(m.type)} · {ago(m.createdAt)}
                {m.route && <span className="text-faint"> · {m.route.split("?")[0]}</span>}
              </p>
              {(() => {
                const st = REPORTER_STATUS[reporterStatus(m.groupId ? { status: m.status ?? "new", lane: m.lane ?? "review", scope: m.scope ?? "small_bug", fixState: m.fixState, groupId: m.groupId } : null)];
                return <Pill tone={PATH_TONE[st.tone]}>{st.label}</Pill>;
              })()}
            </div>
            <p className="line-clamp-4 whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]">{m.message}</p>
            {(m.others > 0 || (status === "fixed" && m.fixedAt)) && (
              <p className="text-[12.5px] text-faint">
                {status === "fixed" && m.fixedAt ? `Live ${ago(m.fixedAt)}. Thanks for flagging it.` : ""}
                {m.others > 0 && `${status === "fixed" ? " " : ""}${m.others} ${m.others === 1 ? "other person" : "other people"} reported this too.`}
              </p>
            )}
            {m.screenshot && (
              <a href={m.screenshot} target="_blank" rel="noreferrer" className="block w-32 overflow-hidden rounded-[10px] border border-line">
                {/* eslint-disable-next-line @next/next/no-img-element -- a signed, private screenshot */}
                <img src={m.screenshot} alt="Your screenshot" className="aspect-[16/10] w-full object-cover object-top" />
              </a>
            )}
            {m.fixLink && (
              <a href={m.fixLink} target="_blank" rel="noreferrer" className="inline-flex min-h-8 items-center text-[12.5px] text-brand-text hover:underline">
                See the fix
              </a>
            )}
            {m.events.length > 0 && <Activity events={m.events} />}
            {m.groupId && m.events.some((e) => e.kind === "comment") && isOpen(status) && <Reply groupId={m.groupId} />}
          </li>
        );
      })}
    </ul>
  );
}
