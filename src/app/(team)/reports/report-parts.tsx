"use client";

import { AdImage } from "@/app/r/[token]/ad-image";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import type { Period, ReportMetrics } from "@/lib/reports/metrics";
import type { ChatTurn, Qa, Sections } from "@/lib/reports/write";
import { SlackConnect } from "@/components/slack-connect";
import { checkAgain, draftNow, redraft, reviseWithAi, saveReport, sendReport, skipReport } from "./actions";

// The report a buyer works on: what the QA flagged, the Slack message in their voice (edit it, or ask the AI to),
// what to add that isn't in the ad account (CRM sales, other channels), the numbers behind it, then send it as them.

export type BundlePart = { id: string; platform: string; status: string; owner: string | null };
type Report = {
  id: string;
  kind: "weekly" | "monthly" | "custom";
  platform: "meta" | "google";
  status: string;
  periodStart: string;
  periodEnd: string;
  message: string;
  sections: Sections | null;
  metrics: ReportMetrics | null;
  extras: string;
  qa: Qa | null;
  chat: ChatTurn[];
  error: string | null;
  postedAt: string | null;
  owner: string | null;
};

const money = (x: number | null | undefined) => (x == null ? "—" : `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const change = (now: number | null, before: number | null, lowerIsBetter = false) => {
  if (now == null || before == null || before === 0) return null;
  const p = Math.round(((now - before) / Math.abs(before)) * 100);
  const good = lowerIsBetter ? p < 0 : p > 0;
  return { text: `${p > 0 ? "+" : ""}${p}%`, tone: p === 0 ? "text-faint" : good ? "text-ok" : "text-bad" };
};

const SEV = {
  fix: { label: "Fix", chip: "bg-bad-soft text-bad", ring: "border-bad/40" },
  alert: { label: "Alert", chip: "bg-warn-soft text-warn", ring: "border-warn/40" },
  check: { label: "Check", chip: "bg-surface-2 text-muted", ring: "border-line" },
} as const;

function Tile({ label, now, before, fmt, lowerIsBetter }: { label: string; now: number | null; before: number | null; fmt: (x: number | null) => string; lowerIsBetter?: boolean }) {
  const c = change(now, before, lowerIsBetter);
  return (
    <div className="grid gap-0.5 rounded-[12px] bg-surface-2/60 px-3 py-2.5">
      <span className="text-[11px] text-faint">{label}</span>
      <span className="tabular text-lg leading-tight">{fmt(now)}</span>
      <span className="text-[11px] text-faint">
        {c ? <span className={c.tone}>{c.text}</span> : "—"} <span>vs {fmt(before)}</span>
      </span>
    </div>
  );
}

function Numbers({ m, reportId }: { m: ReportMetrics; reportId: string }) {
  const tiles = (a: Period, b: Period) => (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      <Tile label="Spend" now={a.spend} before={b.spend} fmt={money} />
      <Tile label={m.conversion} now={a.results} before={b.results} fmt={(x) => (x == null ? "—" : String(x))} />
      <Tile label={`Cost per ${m.conversion.toLowerCase().replace(/s$/, "")}`} now={a.costPerResult} before={b.costPerResult} fmt={money} lowerIsBetter />
      {a.revenue > 0 || b.revenue > 0 ? <Tile label="ROAS" now={a.roas} before={b.roas} fmt={(x) => (x == null ? "—" : `${x}x`)} /> : <Tile label="CTR" now={a.ctr} before={b.ctr} fmt={(x) => (x == null ? "—" : `${x}%`)} />}
      <Tile label="CPC" now={a.cpc} before={b.cpc} fmt={money} lowerIsBetter />
      <Tile label="CPM" now={a.cpm} before={b.cpm} fmt={money} lowerIsBetter />
    </div>
  );
  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-faint">
          {m.main.label} <span className="normal-case tracking-normal">vs {m.compare.label}</span>
        </p>
        {tiles(m.main, m.compare)}
      </div>
      {m.mtd && m.mtdCompare && (
        <div className="grid gap-2">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-faint">
            Month to date <span className="normal-case tracking-normal">vs {m.mtdCompare.label}</span>
          </p>
          {tiles(m.mtd, m.mtdCompare)}
        </div>
      )}
      {m.topAds.length > 0 && (
        <div className="grid gap-2">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-faint">Top ads</p>
          {m.topAds.map((a) => (
            <div key={a.id} className="flex items-center gap-3 rounded-[12px] border border-line p-2">
              <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded-[8px] bg-surface-2">
                <AdImage src={`/api/reports/${reportId}/ad/${a.id}`} />
              </span>
              <span className="grid min-w-0 gap-0.5">
                <span className="truncate text-sm">{a.name}</span>
                <span className="text-[11px] text-faint">
                  {a.results} at {money(a.costPerResult)} · {money(a.spend)} · CTR {a.ctr ?? "—"}%
                </span>
              </span>
              {a.link && (
                <a href={a.link} target="_blank" rel="noreferrer" className="ml-auto shrink-0 rounded-full border border-line px-2.5 py-1 text-[11px] text-muted hover:text-fg">
                  Preview ↗
                </a>
              )}
            </div>
          ))}
        </div>
      )}
      {m.campaigns.length > 0 && (
        <div className="grid gap-1.5">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-faint">Campaigns</p>
          {m.campaigns.slice(0, 6).map((c) => (
            <div key={c.name} className="flex items-baseline justify-between gap-3 text-xs">
              <span className="min-w-0 truncate text-muted">{c.name}</span>
              <span className="tabular shrink-0 text-faint">
                {money(c.spend)} · {c.results} · {money(c.costPerResult)}
                {c.roas ? ` · ${c.roas}x` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const lines = (xs: string[] | undefined) => (xs ?? []).join("\n");
const unlines = (s: string) =>
  s
    .split("\n")
    .map((x) => x.replace(/^[-•\s]+/, "").trim())
    .filter(Boolean);

export function ReportEditor({ report, client, canEdit, slackConnected, bundle, parts }: { report: Report; client: { name: string; slug: string; hasChannel: boolean }; canEdit: boolean; slackConnected: boolean; bundle: { status: string; link: string; sentAt: string | null } | null; parts: BundlePart[] }) {
  const router = useRouter();
  const [message, setMessage] = useState(report.message);
  const [extras, setExtras] = useState(report.extras);
  const [sections, setSections] = useState<Sections | null>(report.sections);
  const [qa, setQa] = useState<Qa | null>(report.qa);
  const [chat, setChat] = useState<ChatTurn[]>(report.chat);
  const [ask, setAsk] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [needsSlack, setNeedsSlack] = useState(false);
  const [pending, start] = useTransition();
  const [asking, setAsking] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const busy = report.status === "queued" || report.status === "drafting";
  const sent = report.status === "posted";
  const editable = canEdit && !sent && !busy;
  const chatEnd = useRef<HTMLDivElement>(null);

  // Take in a fresh draft when the server has one (after a redraft)
  const [seen, setSeen] = useState(`${report.status}:${report.message}`);
  if (`${report.status}:${report.message}` !== seen) {
    setSeen(`${report.status}:${report.message}`);
    setMessage(report.message);
    setSections(report.sections);
    setQa(report.qa);
  }
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(t);
  }, [busy, router]);
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: "nearest" });
  }, [chat]);

  const dirty = message !== report.message || extras !== report.extras || JSON.stringify(sections) !== JSON.stringify(report.sections);
  const save = () =>
    start(async () => {
      const r = await saveReport(report.id, { message, extras, ...(sections ? { sections } : {}) });
      setNote(r.ok ? { ok: true, text: "Saved" } : { ok: false, text: r.error });
      router.refresh();
    });
  const tweak = async (text: string) => {
    if (!text.trim() || asking) return;
    setAsking(true);
    setAsk("");
    if (dirty) await saveReport(report.id, { message, extras, ...(sections ? { sections } : {}) });
    const r = await reviseWithAi(report.id, text);
    setAsking(false);
    if (!r.ok) return setNote({ ok: false, text: r.error });
    setChat(r.chat);
    setMessage(r.message);
    setSections(r.sections);
    if (r.qa) setQa(r.qa);
    if (r.lesson) setNote({ ok: true, text: `Remembered for ${client.name}: ${r.lesson}` });
    router.refresh();
  };
  const send = () =>
    start(async () => {
      setConfirm(false);
      if (dirty) await saveReport(report.id, { message, extras, ...(sections ? { sections } : {}) });
      const r = await sendReport(report.id);
      if (!r.ok) {
        setNeedsSlack(Boolean((r as { needsConnect?: boolean }).needsConnect));
        return setNote({ ok: false, text: r.error });
      }
      setNote({ ok: true, text: r.note });
      router.refresh();
    });

  const flags = qa?.flags ?? [];
  const fixes = flags.filter((f) => f.severity === "fix").length;
  const title = `${client.name} · ${report.platform === "google" ? "Google" : "Meta"} · ${report.kind === "weekly" ? "Weekly report" : report.kind === "custom" ? "Recap" : "Monthly recap"}`;

  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="grid gap-1">
          <h1 className="font-heading text-[28px] leading-tight">{title}</h1>
          <p className="text-sm text-muted">
            {report.metrics?.main.label ?? `${report.periodStart} – ${report.periodEnd}`}
            {report.owner ? ` · ${report.owner}` : ""}
            {sent && report.postedAt ? ` · sent ${new Date(report.postedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {report.metrics && (
            <a href={`/api/reports/${report.id}/pdf`} target="_blank" rel="noreferrer" className="h-9 rounded-full border border-line px-4 text-sm leading-9 text-muted hover:text-fg">
              See the PDF ↗
            </a>
          )}
          {editable && (
            <button type="button" disabled={pending} onClick={() => start(async () => void (await redraft(report.id), router.refresh()))} className="h-9 rounded-full border border-line px-4 text-sm text-muted hover:text-fg">
              Write it again
            </button>
          )}
          {editable && report.kind !== "monthly" && (
            <button type="button" disabled={pending} onClick={() => start(async () => void (await skipReport(report.id), router.refresh()))} className="h-9 px-2 text-sm text-faint hover:text-fg">
              {report.kind === "custom" ? "Not needed" : "Skip this week"}
            </button>
          )}
        </div>
      </header>

      {busy && (
        <div className="flex items-center gap-3 rounded-[16px] border border-line bg-surface px-5 py-4 text-sm text-muted">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-brand border-t-transparent" />
          Reading the account, the work done and how you write, then checking every number…
        </div>
      )}
      {report.status === "failed" && <p className="rounded-[14px] border border-bad/40 bg-bad-soft/40 px-4 py-3 text-sm text-bad">{report.error ?? "Couldn't write it."} Try Write it again.</p>}

      {!busy && (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="grid min-w-0 gap-5">
            {/* The QA, first: what to fix or check before it goes out */}
            {qa && (
              <section className={`grid gap-3 rounded-[16px] border p-4 ${qa.verdict === "fix" ? "border-bad/40 bg-bad-soft/20" : qa.verdict === "check" ? "border-warn/40 bg-warn-soft/20" : "border-ok/30 bg-ok-soft/20"}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">
                    {qa.verdict === "clean" ? "QA: every number checks out" : qa.verdict === "fix" ? `QA: ${fixes} thing${fixes === 1 ? "" : "s"} to fix before it goes out` : "QA: a few things to look at"}
                  </p>
                  {editable && (
                    <button type="button" disabled={pending} onClick={() => start(async () => {
                      if (dirty) await saveReport(report.id, { message, extras, ...(sections ? { sections } : {}) });
                      const r = await checkAgain(report.id);
                      if (r.ok) setQa(r.qa);
                    })} className="rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-fg">
                      {pending ? "Checking…" : "Check again"}
                    </button>
                  )}
                </div>
                {flags.length > 0 && (
                  <ul className="grid gap-2">
                    {flags.map((f, i) => (
                      <li key={i} className={`grid gap-1 rounded-[12px] border bg-surface px-3 py-2.5 ${SEV[f.severity].ring}`}>
                        <span className="flex flex-wrap items-center gap-2 text-sm">
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${SEV[f.severity].chip}`}>{SEV[f.severity].label}</span>
                          {f.issue}
                        </span>
                        {f.where && <span className="text-[11px] text-faint">In: {f.where}</span>}
                        {f.suggestion && (
                          <span className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                            {f.suggestion}
                            {editable && f.severity !== "alert" && (
                              <button type="button" onClick={() => tweak(`Fix this: ${f.issue} ${f.suggestion}`)} className="rounded-full border border-line px-2.5 py-0.5 text-[11px] text-muted hover:text-fg">
                                Fix it for me
                              </button>
                            )}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            <section className="grid gap-2">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="font-heading text-lg">{report.kind !== "monthly" ? "The Slack message" : "Your note with the recap"}</h2>
                <span className="text-[11px] text-faint">In your voice, from your recaps in client channels</span>
              </div>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                disabled={!editable}
                rows={Math.min(30, Math.max(12, message.split("\n").length + 2))}
                className="w-full resize-y rounded-[14px] border border-line bg-surface px-4 py-3 font-mono text-[13px] leading-relaxed outline-none focus:border-faint"
              />
              <p className="text-[11px] text-faint">Slack formatting: *bold*, • bullets. {report.kind !== "monthly" ? "The PDF goes with it." : "The link to the live recap and the PDF are added when it goes out."}</p>
            </section>

            {sections && (
              <details className="group rounded-[16px] border border-line bg-surface" open={report.kind === "monthly"}>
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm">
                  <span>
                    {report.kind !== "monthly" ? "The PDF's write-up" : "The recap's write-up"} <span className="text-faint">· what we did, what we&apos;re doing, what&apos;s next</span>
                  </span>
                  <span className="text-faint transition-transform group-open:rotate-90">›</span>
                </summary>
                <div className="grid gap-3 border-t border-line px-4 py-4">
                  <label className="grid gap-1 text-[11px] text-faint">
                    Headline
                    <input value={sections.headline} disabled={!editable} onChange={(e) => setSections({ ...sections, headline: e.target.value })} className="h-9 rounded-[10px] border border-line bg-bg px-3 text-sm text-fg" />
                  </label>
                  <label className="grid gap-1 text-[11px] text-faint">
                    Summary
                    <textarea value={sections.summary} disabled={!editable} onChange={(e) => setSections({ ...sections, summary: e.target.value })} rows={3} className="rounded-[10px] border border-line bg-bg px-3 py-2 text-sm text-fg" />
                  </label>
                  {(["did", "doing", "next"] as const).map((k) => (
                    <label key={k} className="grid gap-1 text-[11px] text-faint">
                      {k === "did" ? "What we did" : k === "doing" ? "What we're doing now, and why" : "What's next"} (one per line)
                      <textarea value={lines(sections[k])} disabled={!editable} onChange={(e) => setSections({ ...sections, [k]: unlines(e.target.value) })} rows={Math.max(3, sections[k].length + 1)} className="rounded-[10px] border border-line bg-bg px-3 py-2 text-sm text-fg" />
                    </label>
                  ))}
                </div>
              </details>
            )}

            <section className="grid gap-2 rounded-[16px] border border-line bg-surface p-4">
              <p className="text-sm">Anything to add that isn&apos;t in the ad account?</p>
              <p className="text-[11px] text-faint">Sales from the CRM (who, how much, which ad they came from), other channels like TikTok, lead quality, context from the client.</p>
              <textarea value={extras} disabled={!editable} onChange={(e) => setExtras(e.target.value)} rows={3} placeholder="e.g. 2 sales from Go HighLevel: Julia D. $3,280 and Abby L. $3,520, both from the Schedule | Wedding DJ campaign" className="rounded-[10px] border border-line bg-bg px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-faint" />
              {editable && extras.trim() && extras !== report.extras && (
                <button type="button" disabled={asking} onClick={() => tweak(`Work in what I added (outside the ad account): ${extras}`)} className="justify-self-start rounded-full bg-fg px-4 py-1.5 text-xs text-bg disabled:opacity-60">
                  Work it into the report
                </button>
              )}
            </section>

            {editable && dirty && (
              <div className="flex items-center gap-3">
                <button type="button" disabled={pending} onClick={save} className="h-9 rounded-full border border-line px-4 text-sm text-muted hover:text-fg">
                  Save my edits
                </button>
                <span className="text-[11px] text-faint">Then Check again so the QA reads your version.</span>
              </div>
            )}

            {/* Sending */}
            <section className="grid gap-3 rounded-[16px] border border-line bg-surface p-4">
              {report.kind === "monthly" && parts.length > 1 && (
                <div className="flex flex-wrap gap-2 text-xs">
                  {parts.map((p) => (
                    <span key={p.id} className={`rounded-full px-2.5 py-1 ${p.status === "submitted" || p.status === "posted" ? "bg-ok-soft text-ok" : "bg-surface-2 text-muted"}`}>
                      {p.platform === "google" ? "Google" : "Meta"}
                      {p.owner ? ` · ${p.owner}` : ""}: {p.status === "submitted" || p.status === "posted" ? "submitted" : "not yet"}
                    </span>
                  ))}
                </div>
              )}
              {bundle?.status === "sent" && (
                <p className="text-sm text-ok">
                  The recap went to the client.{" "}
                  <a href={bundle.link} target="_blank" rel="noreferrer" className="underline">
                    Open the live recap ↗
                  </a>
                </p>
              )}
              {sent ? (
                report.kind !== "monthly" && <p className="text-sm text-ok">Posted to the client&apos;s channel.</p>
              ) : !canEdit ? (
                <p className="text-sm text-faint">The account&apos;s buyer sends this one.</p>
              ) : !client.hasChannel ? (
                <p className="text-sm text-warn">
                  {client.name} has no Slack channel set.{" "}
                  <Link href={`/clients/${client.slug}`} className="underline">
                    Add it on the client page
                  </Link>
                  .
                </p>
              ) : !slackConnected || needsSlack ? (
                <div className="flex flex-wrap items-center gap-3">
                  <p className="text-sm text-muted">Connect your Slack once so it posts as you.</p>
                  <SlackConnect connected={false} next={`/reports/${report.id}`} />
                </div>
              ) : confirm ? (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span>{report.kind !== "monthly" ? `Post this to ${client.name}'s channel as you, with the PDF?` : "Submit your part? It goes to the client once every buyer on the account has submitted."}</span>
                  <button type="button" disabled={pending} onClick={send} className="h-9 rounded-full bg-brand px-4 text-sm font-medium text-white">
                    {pending ? "Sending…" : "Yes, send it"}
                  </button>
                  <button type="button" onClick={() => setConfirm(false)} className="h-9 px-2 text-sm text-faint">
                    Not yet
                  </button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <button type="button" disabled={pending || busy} onClick={() => setConfirm(true)} className="h-10 rounded-full bg-brand px-5 text-sm font-medium text-white shadow-[0_10px_30px_-12px_rgba(200,16,46,0.9)] disabled:opacity-60">
                    {report.kind !== "monthly" ? "Post to Slack as me" : report.status === "submitted" ? "Submitted" : "Submit my part"}
                  </button>
                  {fixes > 0 && <span className="text-xs text-bad">The QA still has {fixes} thing{fixes === 1 ? "" : "s"} to fix.</span>}
                </div>
              )}
              {note && <p className={`text-xs ${note.ok ? "text-ok" : "text-bad"}`}>{note.text}</p>}
            </section>
          </div>

          <aside className="grid content-start gap-5">
            {report.metrics && (
              <section className="grid gap-3 rounded-[16px] border border-line bg-surface p-4">
                <h2 className="font-heading text-[15px]">The numbers</h2>
                <Numbers m={report.metrics} reportId={report.id} />
              </section>
            )}
            {editable && (
              <section className="grid gap-3 rounded-[16px] border border-line bg-surface p-4">
                <h2 className="font-heading text-[15px]">Ask the AI to tweak it</h2>
                <div className="grid max-h-72 gap-2 overflow-y-auto">
                  {chat.length === 0 && <p className="text-xs text-faint">&ldquo;Add lead quality&rdquo;, &ldquo;shorter, they skim&rdquo;, &ldquo;lead with the sales&rdquo;. What this client always wants is remembered for next time.</p>}
                  {chat.map((t, i) => (
                    <p key={i} className={`whitespace-pre-wrap rounded-[12px] px-3 py-2 text-[13px] ${t.role === "user" ? "justify-self-end bg-fg text-bg" : "bg-surface-2 text-fg"}`}>
                      {t.text}
                    </p>
                  ))}
                  {asking && <p className="animate-pulse text-xs text-faint">Rewriting and checking it again…</p>}
                  <div ref={chatEnd} />
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void tweak(ask);
                  }}
                  className="flex gap-2"
                >
                  <input value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="What should change?" className="h-9 min-w-0 flex-1 rounded-full border border-line bg-bg px-3 text-sm outline-none focus:border-faint" />
                  <button type="submit" disabled={!ask.trim() || asking} className="h-9 rounded-full bg-fg px-4 text-sm text-bg disabled:opacity-40">
                    Ask
                  </button>
                </form>
              </section>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

/** Draft a report for one of my accounts right now. */
export function DraftNow({ accounts }: { accounts: { id: string; label: string }[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState(accounts[0]?.id ?? "");
  const go = (kind: "weekly" | "monthly") =>
    start(async () => {
      const r = await draftNow(pick, kind);
      if (!r.ok) return setError(r.error);
      router.push(`/reports/${r.id}`);
    });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select value={pick} onChange={(e) => setPick(e.target.value)} className="h-9 rounded-full border border-line bg-bg px-3 text-sm">
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.label}
          </option>
        ))}
      </select>
      <button type="button" disabled={pending || !pick} onClick={() => go("weekly")} className="h-9 rounded-full bg-fg px-4 text-sm text-bg disabled:opacity-60">
        Weekly report
      </button>
      <button type="button" disabled={pending || !pick} onClick={() => go("monthly")} className="h-9 rounded-full border border-line px-4 text-sm text-muted hover:text-fg disabled:opacity-60">
        Last month&apos;s recap
      </button>
      {error && <span className="text-xs text-bad">{error}</span>}
    </div>
  );
}
