"use client";

import Link from "next/link";
import { useState } from "react";
import { ErrorButtons } from "../settings/error-buttons";
import { toast } from "@/components/toasts";
import { SCOPE_LABEL, STATUSES, TYPES, isOpen, pathLabel, typeLabel, type FeedbackStatus, type Scope } from "@/lib/feedback-logic";
import { pushParams, replaceParams, useParam } from "@/lib/url-state";
import { approveFeedback, commentFeedback, replyFeedback, setFeedbackAssignee, setFeedbackStatus, wontDoFeedback } from "./actions";

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
  pending?: boolean;
};

export type FeedbackEvent = { id: string; kind: string; body: string | null; link: string | null; shared: boolean; at: string; actor: string | null };

export type MineItem = {
  groupId: string | null;
  lane: string | null;
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
  auto_fix_started: "Sent to Claude to fix",
  build_started: "Sent to Claude to build",
  pr_opened: "Pull request",
  checks_failed: "Checks failed",
  protected: "Held for review",
  no_change: "Nothing to change",
  fix_error: "Couldn't start the fix",
  needs_review: "Needs review",
  approved: "Approved",
  comment: "Comment",
  reply: "Reply",
  wont_fix: "Won't do",
  fixed: "Fixed",
  status: "Status",
  assigned: "Assigned",
};

function PathPill({ g }: { g: { status: string; lane: string; fixState: string | null; pending?: boolean } }) {
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

/**
 * A big issue or a feature request, waiting on an exec: what it is, who asked and how often, the proposed plan, and
 * the three ways forward. Approve sends it to Claude as a planned change (a pull request to review, never merged by
 * itself); a comment goes to the people who asked; won't do tells them why.
 */
function ReviewCard({ g, onDone }: { g: Group; onDone: (patch: Partial<Pick<Group, "status" | "lane">>) => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const people = [...new Map(g.items.map((r) => [r.author, r.role])).entries()];
  const run = async (kind: "approve" | "comment" | "wont") => {
    if (kind !== "approve" && !note.trim()) {
      toast({ tone: "warn", title: kind === "comment" ? "Write the comment first" : "Say why, so the people who asked understand" });
      return;
    }
    setBusy(kind);
    // Shown at once; put back if it fails
    if (kind === "approve") onDone({ lane: "build", status: "planned" });
    if (kind === "wont") onDone({ status: "wont_fix" });
    const r = kind === "approve" ? await approveFeedback(g.id, note) : kind === "comment" ? await commentFeedback(g.id, note) : await wontDoFeedback(g.id, note);
    setBusy(null);
    if ("error" in r) {
      if (kind !== "comment") onDone({ lane: g.lane, status: g.status });
      toast({ tone: "bad", title: r.error });
      return;
    }
    setNote("");
    if (kind === "approve") toast({ tone: "ok", title: "Approved to build", body: "Claude is opening a pull request from the plan. It waits for review before it merges." });
    else if (kind === "comment") toast({ tone: "ok", title: "Sent", body: "notified" in r && r.notified ? `${r.notified} ${r.notified === 1 ? "person" : "people"} will see it.` : "Saved on the item." });
    else toast({ tone: "ok", title: "Marked won't do", body: "The people who asked were told why." });
  };
  return (
    <li className="grid gap-4 rounded-[18px] border border-warn/35 bg-surface p-4 md:p-5">
      <div className="grid gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={g.scope === "feature" ? "bg-brand-soft text-brand-text" : "bg-bad-soft text-bad"}>{SCOPE_LABEL[g.scope]}</Pill>
          <span className="text-[12.5px] text-muted">
            {g.area} · {g.reports} {g.reports === 1 ? "report" : "reports"} from {g.people} {g.people === 1 ? "person" : "people"} · {ago(g.lastReportedAt)}
          </span>
        </div>
        <button type="button" onClick={() => pushParams({ g: g.id })} className="min-h-11 text-left font-heading text-[17px] leading-snug hover:underline md:min-h-0">
          {g.title}
        </button>
        {g.summary && <p className="text-sm leading-relaxed text-muted">{g.summary}</p>}
        {g.scopeReason && <p className="text-[12.5px] text-faint">Why it needs you: {g.scopeReason}</p>}
        <p className="text-[12.5px] text-faint">Asked by {people.map(([name, role]) => (role ? `${name} (${role})` : name)).join(", ")}</p>
      </div>
      {/* What each person actually wrote, in their words (newest first), with their screenshot and the page */}
      <div className="grid gap-2">
        <p className="text-[11px] uppercase tracking-[0.14em] text-faint">In their words</p>
        <ul className="grid gap-2">
          {[...g.items]
            .sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt))
            .slice(0, 5)
            .map((r) => (
              <li key={r.id} className="flex min-w-0 flex-col gap-2.5 rounded-[12px] border border-line bg-bg/60 p-3 md:flex-row">
                <div className="grid min-w-0 flex-1 gap-1">
                  <p className="text-[12px] text-faint">
                    {r.author}
                    {r.role ? ` (${r.role})` : ""} · {ago(r.createdAt)}
                    {r.client ? ` · ${r.client}` : ""}
                  </p>
                  <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-fg [overflow-wrap:anywhere]">&ldquo;{r.message}&rdquo;</p>
                  {r.pageUrl && (
                    <a href={r.pageUrl} target="_blank" rel="noreferrer" className="w-fit truncate text-[12px] text-muted underline-offset-2 hover:text-fg hover:underline">
                      On {r.route ?? r.pageUrl} ↗
                    </a>
                  )}
                </div>
                {r.screenshot && (
                  <a href={r.screenshot} target="_blank" rel="noreferrer" className="block shrink-0 overflow-hidden rounded-[10px] border border-line md:w-36">
                    {/* eslint-disable-next-line @next/next/no-img-element -- a signed, private screenshot */}
                    <img src={r.screenshot} alt="Their screenshot" className="max-h-40 w-full object-cover object-top" />
                  </a>
                )}
              </li>
            ))}
        </ul>
        {g.items.length > 5 && (
          <button type="button" onClick={() => pushParams({ g: g.id })} className="min-h-11 w-fit text-[12.5px] text-muted underline-offset-2 hover:text-fg hover:underline md:min-h-0">
            All {g.items.length} reports
          </button>
        )}
      </div>
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
        placeholder="A note for Claude when approving, a question for the people who asked, or why not"
        className="w-full resize-none rounded-[12px] border border-line bg-bg px-3.5 py-2.5 text-[15px] outline-none placeholder:text-faint focus:border-brand-text/70 md:text-sm"
      />
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <button type="button" disabled={Boolean(busy)} onClick={() => void run("approve")} className="min-h-11 rounded-full bg-brand px-5 text-[13.5px] font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-50 md:min-h-9">
          {busy === "approve" ? "Approving..." : "Approve to build"}
        </button>
        <button type="button" disabled={Boolean(busy)} onClick={() => void run("comment")} className="min-h-11 rounded-full border border-line px-5 text-[13.5px] text-fg hover:border-faint/60 disabled:opacity-50 md:min-h-9">
          {busy === "comment" ? "Sending..." : "Comment / ask for more"}
        </button>
        <button type="button" disabled={Boolean(busy)} onClick={() => void run("wont")} className="min-h-11 rounded-full px-4 text-[13.5px] text-muted hover:text-fg disabled:opacity-50 md:min-h-9">
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
        <h1 className="font-display text-3xl tracking-tight md:text-4xl">{tab === "all" ? "What the team keeps running into" : "My feedback"}</h1>
        <p className="max-w-xl text-sm text-muted">
          {tab === "all"
            ? "Every bug, idea and confusing moment sent from the bubble, with repeats grouped together. What more people hit, more often, sits at the top."
            : "What you've sent from the feedback bubble and where each one stands. You'll get a notification when something you reported is fixed."}
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
  const type = useParam("type");
  const area = useParam("area");
  const status = useParam("status") ?? "open";
  const opened = useParam("g");
  // Saved on change: shown at once, put back if the save fails
  const [local, setLocal] = useState<Record<string, Partial<Pick<Group, "status" | "assigneeId" | "lane">>>>({});
  const view = groups.map((g) => ({ ...g, ...local[g.id] }));

  const areas = [...new Set(groups.filter((g) => !g.pending).map((g) => g.area))].sort();
  const shown = view.filter(
    (g) =>
      (!type || g.type === type) &&
      (!area || g.area === area || g.pending) &&
      (status === "all" ? true : status === "open" ? isOpen(g.status) : g.status === status),
  );
  const open = view.filter((g) => !g.pending && isOpen(g.status));
  const recent = view.flatMap((g) => g.items).filter((r) => r.createdAt > monthAgo);
  const fixed30 = view.filter((g) => g.fixedAt && g.fixedAt > monthAgo).length;

  const save = async (g: Group, patch: Partial<Pick<Group, "status" | "assigneeId">>) => {
    const before = local[g.id];
    setLocal((l) => ({ ...l, [g.id]: { ...l[g.id], ...patch } }));
    const r = patch.status !== undefined ? await setFeedbackStatus(g.id, patch.status as FeedbackStatus) : await setFeedbackAssignee(g.id, patch.assigneeId ?? null);
    if ("error" in r) {
      setLocal((l) => ({ ...l, [g.id]: before ?? {} }));
      toast({ tone: "bad", title: r.error });
      return;
    }
    if (patch.status === "fixed") {
      const n = "notified" in r ? (r.notified ?? 0) : 0;
      toast({ tone: "ok", title: `Fixed: ${g.title}`, body: n ? `${n} ${n === 1 ? "person who reported it was" : "people who reported it were"} told.` : "Nobody else reported it, so there was no one to tell." });
    }
  };

  const review = view.filter((g) => !g.pending && g.lane === "review" && isOpen(g.status));

  return (
    <div className="grid gap-5">
      {review.length > 0 && (
        <section className="grid gap-3">
          <div>
            <h2 className="font-heading text-[19px]">Needs your review</h2>
            <p className="text-[13px] text-muted">Feature requests and issues too big to fix automatically. Small bugs are already being fixed on their own.</p>
          </div>
          <ul className="grid gap-3">
            {review.map((g) => (
              <ReviewCard key={g.id} g={g} onDone={(patch) => setLocal((l) => ({ ...l, [g.id]: { ...l[g.id], ...patch } }))} />
            ))}
          </ul>
        </section>
      )}

      <div className="grid grid-cols-3 gap-2 md:gap-3">
        {[
          [open.length, "open"],
          [recent.length, "reports in 30 days"],
          [fixed30, "fixed in 30 days"],
        ].map(([n, label]) => (
          <div key={label} className="rounded-[14px] border border-line bg-surface px-3.5 py-3 md:px-5 md:py-4">
            <p className="font-display text-2xl tracking-tight md:text-3xl">{n}</p>
            <p className="text-[12px] text-muted">{label}</p>
          </div>
        ))}
      </div>

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
        <select aria-label="Status" value={status} onChange={(e) => pushParams({ status: e.target.value === "open" ? null : e.target.value })} className={select}>
          <option value="open">Open</option>
          {STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
          <option value="all">Everything</option>
        </select>
      </div>

      {shown.length === 0 ? (
        <div className="grid justify-items-center gap-1 rounded-[18px] border border-dashed border-line px-6 py-14 text-center">
          <p className="font-heading text-[17px]">{groups.length ? "Nothing matches" : "No feedback yet"}</p>
          <p className="max-w-sm text-sm text-muted">{groups.length ? "Try another filter." : "When someone uses the bubble in the corner, it shows up here, grouped with anything like it."}</p>
        </div>
      ) : (
        <ol className="grid gap-2.5">
          {shown.map((g, i) => {
            const expanded = opened === g.id;
            return (
              <li key={g.id} className={`rounded-[16px] border bg-surface transition-colors ${expanded ? "border-faint/50" : "border-line"}`}>
                <div className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:gap-4 md:px-5">
                  <button type="button" onClick={() => (expanded ? replaceParams({ g: null }) : pushParams({ g: g.id }))} aria-expanded={expanded} className="flex min-h-11 min-w-0 flex-1 items-start gap-3 text-left">
                    <span className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-[12px] font-medium ${g.pending ? "bg-surface-2 text-faint" : i < 3 && isOpen(g.status) ? "bg-brand-soft text-brand-text" : "bg-surface-2 text-muted"}`}>
                      {g.pending ? "·" : i + 1}
                    </span>
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
                        <span>{ago(g.lastReportedAt)}</span>
                        {g.severity === "high" && <Pill tone="bg-bad-soft text-bad">High</Pill>}
                        {g.blocksWork && <Pill tone="bg-bad-soft text-bad">Blocks work</Pill>}
                        {g.assignee && <span className="text-faint">· {g.assignee}</span>}
                      </span>
                    </span>
                  </button>
                  <div className="flex items-center gap-2 md:shrink-0">
                    <PathPill g={g} />
                    {!g.pending && (
                      <select aria-label="Status" value={g.status} onChange={(e) => void save(g, { status: e.target.value })} className={`${select} min-w-0 flex-1 md:w-36 md:flex-none`}>
                        {STATUSES.map((s) => (
                          <option key={s.value} value={s.value}>
                            {s.label}
                          </option>
                        ))}
                      </select>
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
                        {g.status !== "fixed" && (
                          <button
                            type="button"
                            onClick={() => void save(g, { status: "fixed" })}
                            className="min-h-11 rounded-full bg-brand px-5 text-[13.5px] font-medium text-white transition-colors hover:bg-brand-hover md:min-h-9"
                          >
                            Mark fixed
                          </button>
                        )}
                        {g.status === "fixed" && g.fixedAt && <span className="text-[13px] text-ok">Fixed {ago(g.fixedAt)}, everyone who reported it was told</span>}
                      </div>
                    )}
                    {g.error && (
                      <div className="grid gap-2 rounded-[12px] border border-line bg-bg p-3 md:flex md:items-center md:justify-between">
                        <div className="min-w-0">
                          <p className="text-[12px] uppercase tracking-[0.14em] text-faint">The error monitor saw this</p>
                          <p className="mt-0.5 font-mono text-[12px] text-muted [overflow-wrap:anywhere]">
                            {g.error.message} · {g.error.count}× {g.error.resolved ? "· marked fixed" : ""}
                          </p>
                          {g.error.fixUrl && (
                            <a href={g.error.fixUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center text-[12px] text-brand-text hover:underline md:min-h-0">
                              Claude&apos;s fix
                            </a>
                          )}
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
                        {g.fixCommitUrl && (
                          <a href={g.fixCommitUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-8 items-center text-brand-text hover:underline">
                            The commit
                          </a>
                        )}
                        {g.fixPrUrl && (
                          <a href={g.fixPrUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-8 items-center text-brand-text hover:underline">
                            Pull request
                          </a>
                        )}
                        {g.fixIssueUrl && !g.fixPrUrl && (
                          <a href={g.fixIssueUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-8 items-center text-brand-text hover:underline">
                            GitHub issue
                          </a>
                        )}
                      </p>
                    )}
                    {g.plan && g.lane !== "review" && <p className="whitespace-pre-wrap rounded-[12px] bg-surface-2/60 p-3 text-[13px] leading-relaxed text-muted">{g.plan}</p>}
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
              {m.status ? (
                // To the person who sent it, waiting on an exec reads as received, not as a task of theirs
                (() => {
                  const p = pathLabel({ status: m.status, lane: m.lane ?? "review", fixState: m.fixState });
                  return <Pill tone={PATH_TONE[p.tone]}>{p.label === "Needs your review" ? "With the team" : p.label}</Pill>;
                })()
              ) : (
                <Pill tone={PATH_TONE.muted}>Received</Pill>
              )}
            </div>
            <p className="line-clamp-4 whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]">{m.message}</p>
            {(m.others > 0 || (status === "fixed" && m.fixedAt)) && (
              <p className="text-[12.5px] text-faint">
                {status === "fixed" && m.fixedAt ? `Fixed ${ago(m.fixedAt)}. Thanks for flagging it.` : ""}
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
