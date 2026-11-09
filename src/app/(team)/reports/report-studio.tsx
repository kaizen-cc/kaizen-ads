"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { SlackConnect } from "@/components/slack-connect";
import { closeParams, pushParams, useParam } from "@/lib/url-state";
import { Layer } from "../clients/[slug]/layer";
import { PdfPreview, type PdfField } from "./pdf-preview";
import { RecapDeckButton } from "./recap-deck-button";
import { METRIC_KEYS, columnKeys, metricLabel, platformName, reportBasis, TABLE_DEFAULT, tileKeys, type MetricKey, type ReportLayout } from "@/lib/reports/format";
import type { ReportMetrics } from "@/lib/reports/metrics";
import type { ChatTurn, Qa, Sections } from "@/lib/reports/write";
import { approveBuiltMessage, approveMyPart, builtMessage, changePeriod, checkAgain, loadCampaignEvents, refreshSlackMessage, regenerate, reopenReport, reviseWithAi, saveLayout, saveReport, sendMyPartNow, sendReport, setReportCampaignExcluded, skipReport } from "./actions";
import { RegenerateButton, UndoRegenerate } from "./regenerate-button";
import { NextStepsAct } from "./next-steps-act";
import type { WriteStatus } from "@/lib/write-status-core";
import { buildReportEmail, channelsLabel, type Delivery } from "@/lib/reports/delivery-core";
import { DeliveryPicker, type DeliveryOptions } from "./delivery-picker";
import { PeriodPicker } from "./period-picker";
import { SendHistory, type HistoryItem } from "./send-history";

// One report, start to finish, in three steps: the report (a live preview of the document: click any line to change
// it, or ask the AI on the side and watch it change), then the Slack message (shown as it will look in the client's
// channel, with whoever it's from), then sent. A built report's parts are approved by each buyer; the person who built
// it approves the message, and a joint report goes out once, from the Kaizen app, with one PDF for everything.

export type StudioReport = {
  id: string;
  kind: "weekly" | "monthly" | "custom" | "built";
  platform: "meta" | "google";
  status: string;
  periodLabel: string;
  message: string;
  /** What the message was written from (reportBasis); a report edited since gets its message brought up to date */
  messageBasis: string | null;
  sections: Sections | null;
  metrics: ReportMetrics | null;
  extraMetrics: ReportMetrics[] | null;
  extras: string;
  /** The metrics the buyer chose (or this client's layout from the last report); null: the defaults */
  layout: ReportLayout | null;
  qa: Qa | null;
  chat: ChatTurn[];
  error: string | null;
  owner: string | null;
  /** Regenerated in the last day: when and by whom, and the draft it replaced can still be brought back */
  regen: { at: string; by: string | null } | null;
  /**
   * The report's dates, the one source of truth for every page: the preset they came from, today where the client is,
   * the pages not drawn for them yet (stale), a newer week to move a weekly to (behind), and why they can't change
   */
  period: { start: string; end: string; key: string | null; today: string; stale: string[]; behind: string | null; locked: string | null };
};
export type StudioBundle = {
  id: string;
  kind: "built" | "monthly";
  status: string;
  isBuilder: boolean;
  builder: string | null;
  message: string | null;
  messageApproved: boolean;
  parts: { id: string; platform: string; status: string; owner: string | null; isMe: boolean }[];
};

const PART_STATUS: Record<string, string> = { queued: "Queued", drafting: "Writing", draft: "To review", submitted: "Approved", posted: "Sent", failed: "Couldn't write", skipped: "Left out" };
const SUGGEST = ["Make it shorter", "Explain why results moved", "More on what's next", "Warmer tone"];
// Starters that reach past the numbers: the ad account, Motion, calls, Slack and earlier reports
const LOOKUPS = ["Follow last week's report format", "Compare with the week before", "Which ads did best, and why?", "What did the client say on the last call?", "Anything in Slack this week to mention?"];

/** Slack's formatting as it shows in the channel: *bold*, _italic_, links and bullets. */
function Mrkdwn({ text }: { text: string }) {
  const inline = (line: string, k: number) => {
    const out: React.ReactNode[] = [];
    const re = /\*([^*\n]+)\*|_([^_\n]+)_|<(https?:[^|>]+)\|([^>]+)>|(https?:\/\/[^\s]+)/g;
    let at = 0;
    let m: RegExpExecArray | null;
    let n = 0;
    while ((m = re.exec(line))) {
      if (m.index > at) out.push(line.slice(at, m.index));
      if (m[1]) out.push(<b key={`${k}-${n++}`}>{m[1]}</b>);
      else if (m[2]) out.push(<i key={`${k}-${n++}`}>{m[2]}</i>);
      else if (m[3]) out.push(<span key={`${k}-${n++}`} className="text-[#1d9bd1]">{m[4]}</span>);
      else if (m[5]) out.push(<span key={`${k}-${n++}`} className="text-[#1d9bd1]">{m[5]}</span>);
      at = m.index + m[0].length;
    }
    out.push(line.slice(at));
    return out;
  };
  return (
    <div className="grid gap-0.5 text-[15px] leading-[1.46] text-[#d1d2d3]">
      {text.split("\n").map((line, i) => (line.trim() ? <p key={i}>{inline(line, i)}</p> : <p key={i} className="h-2" />))}
    </div>
  );
}

/** The message as it will look in the client's Slack channel: who it's from, the text, the PDF. */
function SlackPreview({ from, text, file }: { from: { name: string; image: string | null; app: boolean }; text: string; file: string }) {
  const now = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return (
    <div className="overflow-hidden rounded-[12px] border border-ink/10 bg-[#1a1d21] font-[Lato,ui-sans-serif,system-ui]">
      <div className="flex items-center gap-2 border-b border-ink/[0.06] px-4 py-2.5 text-[13px] text-[#d1d2d3]">
        <span className="font-bold"># {file.split(" - ")[0].toLowerCase().replace(/[^a-z0-9]+/g, "-")}</span>
        <span className="text-[#ababad]">· how it&apos;ll look in their channel</span>
      </div>
      <div className="flex gap-2.5 px-4 py-4">
        {from.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={from.image} alt="" className="h-9 w-9 shrink-0 rounded-[6px] object-cover" />
        ) : (
          <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-[6px] text-[13px] font-bold text-white ${from.app ? "bg-[#c8102e]" : "bg-[#4a4d52]"}`}>{from.app ? "K" : from.name.slice(0, 1).toUpperCase()}</span>
        )}
        <div className="grid min-w-0 flex-1 gap-1">
          <p className="flex items-center gap-1.5 text-[15px]">
            <b className="text-fg">{from.name}</b>
            {from.app && <span className="rounded-[3px] bg-ink/10 px-1 text-[10px] font-semibold text-[#ababad]">APP</span>}
            <span className="text-[12px] text-[#ababad]">{now}</span>
          </p>
          <Mrkdwn text={text || "(empty)"} />
          <div className="mt-2 flex max-w-[360px] items-center gap-3 rounded-[8px] border border-ink/10 bg-[#222529] px-3 py-2.5">
            <span className="grid h-10 w-9 shrink-0 place-items-center rounded-[4px] bg-[#e01e5a] text-[10px] font-bold text-white">PDF</span>
            <span className="grid min-w-0">
              <span className="truncate text-[14px] font-bold text-fg">{file}</span>
              <span className="text-[12px] text-[#ababad]">PDF</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The email as the client will get it: the subject, who it's to, the short note, the key numbers and the PDF */
function EmailPreview({ mail, to, file }: { mail: ReturnType<typeof buildReportEmail>; to: string[]; file: string }) {
  return (
    <div className="grid gap-2">
      <p className="text-[13px] text-muted">The email, from the agency&rsquo;s address with replies to you. It&rsquo;s written from the report, so it always matches it.</p>
      <div className="overflow-hidden rounded-[14px] border border-line bg-surface">
        <div className="grid gap-1 border-b border-line px-4 py-3 text-[13px]">
          <p className="truncate">
            <span className="text-faint">To </span>
            {to.length ? to.join(", ") : <span className="text-warn">nobody picked yet</span>}
          </p>
          <p className="font-medium leading-snug">{mail.subject}</p>
        </div>
        <div className="grid gap-3 px-4 py-4 text-[14px] leading-relaxed">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-brand-text">{mail.kicker}</p>
          <p className="font-heading text-[19px] leading-tight">{mail.title}</p>
          <p>{mail.hello}</p>
          {mail.lines.map((l, i) => (
            <p key={i} className="text-muted">
              {l}
            </p>
          ))}
          {mail.bullets.length > 0 && (
            <ul className="grid gap-1">
              {mail.bullets.map((b, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-brand-text">•</span>
                  <span>{b}</span>
                </li>
              ))}
            </ul>
          )}
          {mail.cta && <span className="w-fit rounded-[6px] bg-brand px-4 py-2.5 text-[13px] font-medium text-white">{mail.cta.label}</span>}
          <p className="text-[12.5px] text-faint">{mail.note}</p>
          <div className="flex max-w-[360px] items-center gap-3 rounded-[10px] border border-line bg-surface-2 px-3 py-2.5">
            <span className="grid h-10 w-9 shrink-0 place-items-center rounded-[4px] bg-[#e01e5a] text-[10px] font-bold text-white">PDF</span>
            <span className="min-w-0 truncate text-[13px] font-medium">{file}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function PanelButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-line text-[15px] text-muted transition-colors hover:border-faint hover:text-fg md:h-9 md:w-9">
      {children}
    </button>
  );
}

export function ReportStudio({
  report,
  client,
  bundle,
  slack,
  act = null,
  delivery = null,
  history = [],
}: {
  report: StudioReport;
  client: { name: string; slug: string; hasChannel: boolean };
  bundle: StudioBundle | null;
  slack: { connected: boolean; name: string | null; image: string | null; me: string };
  /** Acting on the report's next steps: whether changes can be written to its account, and who can switch them on */
  act?: { write: WriteStatus | null; canSwitch: boolean } | null;
  /** Where it can go (Slack, email to the client's contacts) and how this client got their last one */
  delivery?: DeliveryOptions | null;
  /** Every time this report went to the client */
  history?: HistoryItem[];
}) {
  const router = useRouter();
  const built = report.kind === "built";
  const joint = built && (bundle?.parts.length ?? 0) > 1;
  const busy = report.status === "queued" || report.status === "drafting";
  const sent = report.status === "posted" || bundle?.status === "sent";
  const mineDone = report.status === "submitted";
  const [sections, setSectionsState] = useState<Sections | null>(report.sections);
  const [extras, setExtrasState] = useState(report.extras);
  const [message, setMessage] = useState(built ? (bundle?.message ?? "") : report.message);
  const [qa, setQa] = useState<Qa | null>(report.qa);
  const [chat, setChat] = useState<ChatTurn[]>(report.chat);
  const [ask, setAsk] = useState("");
  const [asking, setAsking] = useState(false);
  const [rail, setRail] = useState<"ai" | "checks">("ai");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const [editMsg, setEditMsg] = useState(false);
  // The message follows the report: edited by hand since it was written, it's brought up to date on the message step
  const [basis, setBasis] = useState(report.messageBasis);
  const [failedBasis, setFailedBasis] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ key: "did" | "doing" | "next" | "extras"; text: string } | null>(null);
  // The metrics the buyer chose: saved on the report and as this client's layout for the next one
  const [layout, setLayoutState] = useState<ReportLayout | null>(report.layout);
  const [addingMetric, setAddingMetric] = useState<"tiles" | "table" | "columns" | "campaign" | null>(null);
  // Campaigns excluded from the KPI here (a client-run campaign): gone from the page at once, with an undo, and out of
  // the numbers once the report is regenerated. `excluding`: the one waiting on its confirm. `restored`: counted again.
  const [excluding, setExcluding] = useState<string | null>(null);
  const [gone, setGone] = useState<{ id: string | null; name: string }[]>([]);
  const [restored, setRestored] = useState<string[]>([]);
  const excludeCampaign = (c: { id: string | null; name: string }, on: boolean) => {
    setExcluding(null);
    const before = gone;
    const was = restored;
    setGone(on ? [...gone.filter((x) => x.name !== c.name), c] : gone.filter((x) => x.name !== c.name));
    if (!on) setRestored([...new Set([...restored, c.name])]);
    start(async () => {
      const r = await setReportCampaignExcluded(report.id, c, on);
      if (!r.ok) {
        setGone(before);
        setRestored(was);
        return setNote({ ok: false, text: r.error });
      }
      setNote(on ? null : { ok: true, text: `${c.name} counts again in ${client.name}'s KPI, audits and reports. Regenerate to bring it back into this report.` });
    });
  };
  const regenerateNow = () =>
    start(async () => {
      const r = await regenerate(report.id);
      if (!r.ok) return setNote({ ok: false, text: r.error });
      setGone([]);
      router.refresh();
    });
  const setLayout = (next: ReportLayout) => {
    setLayoutState(next);
    start(async () => {
      const r = await saveLayout(report.id, next);
      if (!r.ok) setNote({ ok: false, text: r.error });
      else setNote({ ok: true, text: `Saved as ${client.name}'s layout: their next report starts this way.` });
    });
  };
  const initial: "report" | "message" | "done" = sent ? "done" : built && mineDone && bundle?.isBuilder ? "message" : "report";
  // The step is in the address (?step=), so back from the Slack message returns to the report. Once it's sent, it's
  // sent: every entry shows that.
  const [sentHere, setSentHere] = useState(false);
  const asked = useParam("step");
  const step: "report" | "message" | "done" = sent || sentHere ? "done" : asked === "report" || asked === "message" ? asked : initial;
  const setStep = (to: "report" | "message" | "done") => (to === "done" ? setSentHere(true) : pushParams({ step: to === initial ? null : to }));
  const chatEnd = useRef<HTMLDivElement>(null);
  const bigEnd = useRef<HTMLDivElement>(null);
  // The side panel: normal, maximized (a big panel over the page, the report still in view) or minimized (a bar at the
  // bottom, the report full width). In the address (?chat=max|min), so back returns to how it was.
  const view = useParam("chat");
  const maxed = view === "max";
  const minned = view === "min";

  // A fresh draft from the server (after a redraft or the first write) replaces what's shown
  const [seen, setSeen] = useState(`${report.status}:${JSON.stringify(report.sections)}`);
  if (`${report.status}:${JSON.stringify(report.sections)}` !== seen) {
    setSeen(`${report.status}:${JSON.stringify(report.sections)}`);
    setSectionsState(report.sections);
    setQa(report.qa);
    if (!built) setMessage(report.message);
  }
  useEffect(() => {
    if (!busy && !(bundle && bundle.parts.some((p) => p.status === "drafting" || p.status === "queued"))) return;
    const t = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(t);
  }, [busy, bundle, router]);
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: "nearest" });
    bigEnd.current?.scrollIntoView({ block: "nearest" });
  }, [chat, asking, maxed]);
  useEffect(() => {
    if (!maxed) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && closeParams("chat");
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [maxed]);
  // The message step of a built report: the combined (or single) message, written from the approved parts
  useEffect(() => {
    if (step !== "message" || !built || !bundle || message) return;
    let live = true;
    void builtMessage(bundle.id).then((r) => live && r.ok && setMessage(r.message));
    return () => {
      live = false;
    };
  }, [step, built, bundle, message]);
  const nowBasis = sections ? reportBasis(sections, extras) : null;
  const syncing = step === "message" && !built && !sent && !!message.trim() && nowBasis != null && nowBasis !== basis && nowBasis !== failedBasis;
  useEffect(() => {
    if (!syncing || !nowBasis) return;
    let live = true;
    void refreshSlackMessage(report.id).then((r) => {
      if (!live) return;
      if (!r.ok) setFailedBasis(nowBasis);
      else {
        setMessage(r.message);
        setBasis(r.basis);
        setNote({ ok: true, text: "The Slack message now matches the changes you made to the report." });
      }
    });
    return () => {
      live = false;
    };
  }, [syncing, nowBasis, report.id]);

  const editable = !sent && !busy && !(built && mineDone) && report.status !== "submitted";
  const setSections = (s: Sections) => {
    setSectionsState(s);
    start(async () => {
      const r = await saveReport(report.id, { sections: s });
      if (!r.ok) setNote({ ok: false, text: r.error });
    });
  };
  const setExtras = (v: string) => {
    setExtrasState(v);
    start(async () => {
      await saveReport(report.id, { extras: v });
    });
  };
  const tweak = async (text: string) => {
    if (!text.trim() || asking) return;
    setAsking(true);
    setAsk("");
    setNote(null);
    const r = await reviseWithAi(report.id, text);
    setAsking(false);
    if (!r.ok) {
      setNote({ ok: false, text: r.error });
      // The dates asked for already have a report on this account: open that one
      if ("openId" in r && r.openId && confirm(`${r.error} Open it?`)) router.push(`/reports/${r.openId}`);
      return;
    }
    setChat(r.chat);
    // New dates: the whole report is being redrawn (every page), so the page follows it
    if (r.redrawing) return router.refresh();
    setSectionsState(r.sections);
    if (!built) setMessage(r.message);
    if (r.qa) setQa(r.qa);
    if (r.lesson) setNote({ ok: true, text: `Remembered for this client: ${r.lesson}` });
  };

  const approve = () =>
    start(async () => {
      setNote(null);
      if (built) {
        const r = await approveMyPart(report.id);
        if (!r.ok) return setNote({ ok: false, text: r.error });
        if (bundle?.isBuilder) setStep("message");
        else setNote({ ok: true, text: `Approved. ${bundle?.builder ?? "Whoever built it"} sends it with the rest, as one report.` });
        router.refresh();
        return;
      }
      if (report.kind === "monthly") {
        const r = await sendReport(report.id);
        setNote(r.ok ? { ok: true, text: r.note } : { ok: false, text: r.error });
        router.refresh();
        return;
      }
      setStep("message");
    });

  // Where it goes: Slack, email or both (the client's last choice to start with)
  const [route, setRoute] = useState<Delivery>(delivery?.initial ?? { channels: ["slack"], recipients: [] });
  const [emailNote, setEmailNote] = useState("");
  const viaSlack = route.channels.includes("slack");
  const viaEmail = route.channels.includes("email");
  const [sentNote, setSentNote] = useState<string | null>(null);
  const send = () =>
    start(async () => {
      setNote(null);
      if (built && bundle) {
        const r = await approveBuiltMessage(bundle.id, message, route);
        if (!r.ok) return setNote({ ok: false, text: r.error });
        if (r.sent) setStep("done");
        else setNote({ ok: true, text: `Approved. It goes out the moment ${r.waitingOn.join(" and ")} approve${r.waitingOn.length === 1 ? "s" : ""} their part: one report, by ${channelsLabel(route.channels).toLowerCase()}.` });
        router.refresh();
        return;
      }
      await saveReport(report.id, { message });
      const r = await sendReport(report.id, route, emailNote);
      if (!r.ok) return setNote({ ok: false, text: r.error });
      setSentNote(r.note);
      setStep("done");
      router.refresh();
    });
  const stale = report.period.stale.length > 0 && !sent && !busy;

  const from = joint ? { name: "Kaizen", image: null, app: true } : { name: slack.name || slack.me, image: slack.image, app: false };
  const fileName = `${client.name} - ${built ? "Report" : `${platformName(report.platform).replace(" Ads", "")} report`} - ${report.periodLabel}.pdf`;
  const waitingParts = bundle?.parts.filter((p) => p.status !== "submitted" && p.status !== "posted") ?? [];
  const STEPS = [
    { key: "report", label: built && joint ? "Your part" : "Report" },
    ...(report.kind === "monthly" || (built && !bundle?.isBuilder) ? [] : [{ key: "message", label: "Send" }]),
    { key: "done", label: "Sent" },
  ];

  return (
    <div className="grid gap-5">
      {/* Where it is: the steps, and a built report's parts */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ol className="flex items-center gap-1.5 text-sm">
          {STEPS.map((s, i) => {
            const at = STEPS.findIndex((x) => x.key === step);
            const on = s.key === step;
            return (
              <li key={s.key} className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={i > at || sent}
                  onClick={() => setStep(s.key as typeof step)}
                  className={`flex h-9 items-center gap-2 rounded-full px-3.5 transition-colors ${on ? "bg-fg text-bg" : i < at ? "text-fg hover:bg-surface-2" : "text-faint"}`}
                >
                  <span className={`grid h-5 w-5 place-items-center rounded-full text-[11px] font-semibold ${on ? "bg-bg text-fg" : i < at ? "bg-ok text-white" : "border border-line"}`}>{i < at ? "✓" : i + 1}</span>
                  {s.label}
                </button>
                {i < STEPS.length - 1 && <span className="h-px w-4 bg-line" />}
              </li>
            );
          })}
        </ol>
        <div className="flex flex-wrap items-center gap-1.5">
          {bundle && bundle.parts.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {bundle.parts.map((p) => (
                <a
                  key={p.id}
                  href={`/reports/${p.id}`}
                  className={`flex h-11 items-center gap-2 rounded-full border px-3.5 text-xs md:h-8 md:px-3 ${p.isMe ? "border-fg/40" : "border-line"} ${p.status === "submitted" || p.status === "posted" ? "text-ok" : "text-muted"}`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${p.status === "submitted" || p.status === "posted" ? "bg-ok" : p.status === "drafting" ? "animate-pulse bg-faint" : "bg-warn"}`} />
                  {platformName(p.platform as "meta" | "google").replace(" Ads", "")} · {p.isMe ? "you" : (p.owner ?? "buyer")} · {PART_STATUS[p.status] ?? p.status}
                </a>
              ))}
            </div>
          )}
          {/* Regenerate: the freshest numbers and the latest report logic, from scratch (a sent one stays as it went) */}
          {!busy && <RegenerateButton kind="one" variant="header" id={report.id} label={`${client.name}'s report`} sent={sent} approved={report.status === "submitted"} />}
        </div>
      </div>

      {/* The report's dates: one dropdown, every page follows them */}
      {report.kind !== "monthly" && !sent && (
        <PeriodPicker reportId={report.id} start={report.period.start} end={report.period.end} periodKey={report.period.key} today={report.period.today} locked={busy ? "It's being written right now." : report.period.locked} />
      )}
      {report.period.behind && !busy && !sent && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[14px] border border-warn/40 bg-warn-soft/40 px-4 py-3">
          <p className="min-w-0 flex-1 basis-64 text-[13px] leading-snug text-fg">
            This report covers {report.periodLabel}. Last week was <b>{report.period.behind}</b>.
          </p>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await changePeriod(report.id, "lastWeek");
                if (!r.ok) {
                  setNote({ ok: false, text: r.error });
                  if (r.openId && confirm(`${r.error} Open it?`)) router.push(`/reports/${r.openId}`);
                  return;
                }
                router.refresh();
              })
            }
            className="h-11 shrink-0 rounded-full bg-fg px-4 text-[13px] font-medium text-bg disabled:opacity-50 md:h-9"
          >
            Move it to last week
          </button>
        </div>
      )}
      {stale && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[14px] border border-bad/40 bg-bad-soft/40 px-4 py-3">
          <p className="min-w-0 flex-1 basis-64 text-[13px] leading-snug text-fg">
            Not every page is for {report.periodLabel} yet ({report.period.stale.join(", ")}). Redraw it with fresh numbers before it goes out.
          </p>
          <button type="button" disabled={pending} onClick={regenerateNow} className="h-11 shrink-0 rounded-full bg-fg px-4 text-[13px] font-medium text-bg disabled:opacity-50 md:h-9">
            Redraw every page
          </button>
        </div>
      )}
      {note && <p className={`rounded-[12px] px-4 py-3 text-sm ${note.ok ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad"}`}>{note.text}</p>}
      {gone.length > 0 && !busy && (
        <div className="grid gap-2">
          {gone.map((g) => (
            <div key={g.name} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[14px] border border-line bg-surface px-4 py-3">
              <p className="min-w-0 flex-1 basis-64 text-[13px] leading-snug text-muted">
                <span className="font-medium text-fg">{g.name}</span> is excluded from {client.name}&rsquo;s KPI, audits and reports. Regenerate to redraw this report&rsquo;s numbers without it.
              </p>
              <div className="flex shrink-0 gap-1.5">
                {!sent && (
                  <button type="button" disabled={pending} onClick={regenerateNow} className="h-11 rounded-full bg-fg px-4 text-[13px] font-medium text-bg disabled:opacity-50 md:h-9">
                    Regenerate now
                  </button>
                )}
                <button type="button" disabled={pending} onClick={() => excludeCampaign(g, false)} className="h-11 rounded-full border border-line px-4 text-[13px] text-muted hover:text-fg disabled:opacity-50 md:h-9">
                  Undo
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {report.regen && !busy && !sent && <UndoRegenerate key={report.regen.at} id={report.id} at={report.regen.at} by={report.regen.by} />}

      {step === "report" && (
        <div className={`grid items-start gap-5 ${minned ? "pb-20" : "lg:grid-cols-[minmax(0,1fr)_420px]"}`}>
          <div className="grid min-w-0 gap-3">
            {busy || !sections ? (
              <div className="grid place-items-center gap-3 rounded-[14px] border border-line bg-surface px-6 py-20 text-center">
                {report.status === "failed" ? (
                  <>
                    <p className="font-heading text-lg">The AI couldn&apos;t write it</p>
                    <p className="max-w-md text-sm text-muted">{report.error ?? "Try again."}</p>
                    <button type="button" disabled={pending} onClick={() => start(async () => void (await regenerate(report.id), router.refresh()))} className="h-11 rounded-brand bg-fg px-4 text-sm text-bg disabled:opacity-60 md:h-10">
                      {pending ? "Starting…" : "Write it again"}
                    </button>
                  </>
                ) : (
                  <>
                    <span className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-2">
                      <span className="block h-full w-1/2 animate-[ai-sweep_1.4s_ease-in-out_infinite] rounded-full bg-brand" />
                    </span>
                    <p className="font-heading text-lg">Writing the report…</p>
                    <p className="max-w-md text-sm text-muted">Reading the numbers, the work behind them and how you write. It checks itself before it shows here, usually within a minute.</p>
                  </>
                )}
              </div>
            ) : (
              (() => {
                // Every line the buyer writes, to click and change on the PDF itself
                const LISTS = [["did", "What we did"], ["doing", "What we're doing"], ["next", "What's next"]] as const;
                const fields: PdfField[] = [
                  { id: "headline", label: "Headline", value: sections.headline },
                  { id: "summary", label: "Summary", value: sections.summary },
                  ...LISTS.flatMap(([k, label]) => sections[k].map((v, i) => ({ id: `${k}.${i}`, label, value: v, removable: true }))),
                  { id: "extras", label: "Also (sales from their CRM, other channels…)", value: extras, removable: true },
                  // Each trend chart's words (the chart itself is drawn from the ad account)
                  ...(sections.stories ?? []).flatMap((st, i) => [
                    { id: `story-${i}-title`, label: "Chart title", value: st.title },
                    { id: `story-${i}-see`, label: "What we see", value: st.see },
                    { id: `story-${i}-why`, label: "Why", value: st.why },
                    { id: `story-${i}-next`, label: "What's next", value: st.next },
                  ]),
                ];
                const save = (id: string, v: string | null) => {
                  if (id === "extras") return setExtras(v ?? "");
                  if (id === "headline" || id === "summary") return setSections({ ...sections, [id]: v ?? "" });
                  const story = id.match(/^story-(\d+)-(title|see|why|next)$/);
                  if (story) return setSections({ ...sections, stories: (sections.stories ?? []).map((st, i) => (i === Number(story[1]) ? { ...st, [story[2]]: v ?? "" } : st)) });
                  const [k, n] = id.split(".") as ["did" | "doing" | "next", string];
                  setSections({ ...sections, [k]: v ? sections[k].map((y, j) => (j === Number(n) ? v : y)) : sections[k].filter((_, j) => j !== Number(n)) });
                };
                // The metrics on the page now, as the PDF draws them
                const goneNames = new Set(gone.map((g) => g.name));
                const m = report.metrics && goneNames.size ? { ...report.metrics, campaigns: report.metrics.campaigns.filter((c) => !goneNames.has(c.name)) } : report.metrics;
                const monthlyTiles = report.kind === "monthly";
                const tiles = m ? tileKeys(m, layout, monthlyTiles) : [];
                const table = layout?.table?.length ? layout.table : TABLE_DEFAULT;
                const columns = m ? columnKeys(m, layout) : [];
                const hasTable = report.kind !== "weekly";
                const limit = report.kind === "weekly" ? 6 : 8;
                const hide = layout?.campaigns?.hide ?? [];
                const add = layout?.campaigns?.add ?? [];
                const shownCampaigns = m ? m.campaigns.filter((c) => !hide.includes(c.name)).slice(0, limit).map((c) => c.name) : [];
                const offPage = m ? m.campaigns.filter((c) => !shownCampaigns.includes(c.name) && !add.includes(c.name)) : [];
                const list = { tiles, table, columns };
                // Excluded here: off the page right away (the numbers follow on regenerate)
                const shownLayout: ReportLayout | null = goneNames.size ? { ...layout, campaigns: { ...(layout?.campaigns ?? {}), hide: [...new Set([...hide, ...goneNames])] } } : layout;
                const swap = (where: "tiles" | "table" | "columns", i: number, k: MetricKey | null) => {
                  const now = [...list[where]];
                  if (k) now[i] = k;
                  else now.splice(i, 1);
                  setLayout({ ...layout, [where]: now });
                };
                const picker = (where: "tiles" | "table" | "columns", current: MetricKey | null, choose: (k: MetricKey) => void) =>
                  m && (
                    <div className="grid gap-1">
                      {METRIC_KEYS.filter((k) => k === current || !list[where].includes(k)).map((k) => (
                        <button key={k} type="button" onClick={() => choose(k)} className={`flex h-10 items-center justify-between rounded-[10px] px-3 text-left text-[13.5px] hover:bg-surface-2 ${k === current ? "bg-surface-2 text-fg" : "text-muted"}`}>
                          {metricLabel(m, k)}
                          {k === current && <span className="text-[11px] text-faint">Now</span>}
                        </button>
                      ))}
                    </div>
                  );
                const hotMenu = (target: string, close: () => void) => {
                  const [platform, kind, ...rest] = target.split("/");
                  if (!m) return null;
                  if (platform !== report.platform) return <p className="text-[13px] text-muted">This part is the other buyer&rsquo;s: they change it from their report.</p>;
                  const title = (t: string) => <p className="px-1 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-faint">{t}</p>;
                  if (kind === "tile" || kind === "row" || kind === "col") {
                    const where = kind === "tile" ? "tiles" : kind === "row" ? "table" : "columns";
                    const i = Number(rest[0]);
                    const current = list[where][i] ?? null;
                    return (
                      <>
                        {title(kind === "tile" ? "Show in this tile" : kind === "row" ? "Show in this row" : "Show in this column")}
                        {picker(where, current, (k) => {
                          swap(where, i, k);
                          close();
                        })}
                        {list[where].length > 1 && (
                          <button type="button" onClick={() => (swap(where, i, null), close())} className="h-10 rounded-[10px] px-3 text-left text-[13px] text-bad hover:bg-bad-soft/40">
                            Remove this {kind === "tile" ? "tile" : kind === "row" ? "row" : "column"}
                          </button>
                        )}
                      </>
                    );
                  }
                  // A trend chart: taken out, or redrawn by the AI with a different metric or range
                  if (kind === "story") {
                    const i = Number(rest[0]);
                    const st = sections.stories?.[i];
                    return (
                      <>
                        {title("Trend chart")}
                        <p className="px-1 text-[13.5px] leading-snug">{st?.title}</p>
                        <p className="px-1 text-[12px] text-muted">Its numbers come from the ad account. To chart something else, ask the AI (e.g. &ldquo;make it the last 8 weeks&rdquo;).</p>
                        <button
                          type="button"
                          onClick={() => {
                            setSections({ ...sections, stories: (sections.stories ?? []).filter((_, j) => j !== i) });
                            close();
                          }}
                          className="h-10 rounded-[10px] px-3 text-left text-[13px] text-bad hover:bg-bad-soft/40"
                        >
                          Remove this chart
                        </button>
                      </>
                    );
                  }
                  // A campaign line
                  const name = decodeURIComponent(rest.join("/") || kind);
                  const c = m.campaigns.find((x) => x.name === name);
                  return (
                    <>
                      {title("Campaign")}
                      <p className="px-1 text-[13.5px] leading-snug">{name}</p>
                      {c?.result && <p className="px-1 text-[12px] text-muted">{layout?.campaigns?.results?.[name] ? "Counting" : "Optimized for"} {c.result.toLowerCase()}{layout?.campaigns?.results?.[name] ? " (picked for this report)" : ": its results count that, as on the KPI board"}.</p>}
                      {title("Its result")}
                      {c?.events ? (
                        <div className="grid max-h-56 gap-1 overflow-y-auto">
                          <button
                            type="button"
                            onClick={() => {
                              const results = { ...(layout?.campaigns?.results ?? {}) };
                              delete results[name];
                              setLayout({ ...layout, campaigns: { hide, add, results } });
                              close();
                            }}
                            className={`flex h-10 items-center justify-between rounded-[10px] px-3 text-left text-[13px] hover:bg-surface-2 ${!layout?.campaigns?.results?.[name] ? "bg-surface-2 text-fg" : "text-muted"}`}
                          >
                            What it&rsquo;s optimized for
                            {!layout?.campaigns?.results?.[name] && <span className="text-[11px] text-faint">Now</span>}
                          </button>
                          {c.events.map((e) => (
                            <button
                              key={e.type}
                              type="button"
                              onClick={() => {
                                setLayout({ ...layout, campaigns: { hide, add, results: { ...(layout?.campaigns?.results ?? {}), [name]: e.type } } });
                                close();
                              }}
                              className={`flex min-h-10 items-center justify-between gap-3 rounded-[10px] px-3 text-left text-[13px] hover:bg-surface-2 ${layout?.campaigns?.results?.[name] === e.type ? "bg-surface-2 text-fg" : "text-muted"}`}
                            >
                              <span className="min-w-0 truncate">{e.label}</span>
                              <span className="tabular shrink-0 text-[12px] text-faint">{e.count.toLocaleString("en-US")}</span>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() =>
                            start(async () => {
                              const r = await loadCampaignEvents(report.id);
                              if (!r.ok) setNote({ ok: false, text: r.error });
                              router.refresh();
                            })
                          }
                          className="h-10 rounded-[10px] px-3 text-left text-[13px] text-brand-text hover:bg-surface-2"
                        >
                          {pending ? "Reading its conversions…" : "Pick its result (read what it counted)"}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          setLayout({ ...layout, campaigns: { hide: [...new Set([...hide, name])], add: add.filter((x) => x !== name) } });
                          close();
                        }}
                        className="h-10 rounded-[10px] px-3 text-left text-[13px] text-bad hover:bg-bad-soft/40"
                      >
                        Take it out of the report
                      </button>
                      {excluding === name ? (
                        <div className="grid gap-2 rounded-[12px] border border-warn/40 bg-warn-soft px-3 py-2.5">
                          <p className="text-[12.5px] leading-snug text-fg">
                            Leave &ldquo;{name}&rdquo; out everywhere? It stops counting in {client.name}&rsquo;s KPI, audits and every report, like a campaign the client runs themselves. You can undo it.
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            <button
                              type="button"
                              onClick={() => {
                                excludeCampaign({ id: c?.id ?? null, name }, true);
                                close();
                              }}
                              className="h-10 rounded-full bg-fg px-4 text-[13px] font-medium text-bg md:h-9"
                            >
                              Exclude it
                            </button>
                            <button type="button" onClick={() => setExcluding(null)} className="h-10 rounded-full px-3 text-[13px] text-muted hover:text-fg md:h-9">
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button type="button" onClick={() => setExcluding(name)} className="min-h-10 rounded-[10px] px-3 py-2 text-left text-[13px] leading-snug text-muted hover:bg-surface-2 hover:text-fg">
                          Exclude this campaign from reports and audits
                          <span className="block text-[11.5px] text-faint">For a campaign the client runs themselves</span>
                        </button>
                      )}
                    </>
                  );
                };
                return (
                  <div className="grid gap-3">
                    {editable && m && (
                      <div className="grid gap-2 rounded-[14px] border border-line bg-surface p-3">
                        <div className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
                          <span className="mr-1 text-faint">Metrics:</span>
                          <button type="button" disabled={asking} onClick={() => void tweak("Add a trend chart of the cost per result by week for the last 5 weeks, with what we see, why and what's next")} className="h-9 rounded-full border border-line px-3 text-muted hover:text-fg disabled:opacity-40 max-md:h-10">
                            + Trend chart
                          </button>
                          {([["tiles", "+ Tile"], ...(hasTable ? [["table", "+ Key metric row"]] : []), ["columns", "+ Campaign column"], ["campaign", "+ Campaign"]] as ["tiles" | "table" | "columns" | "campaign", string][]).map(([k, label]) => (
                            <button key={k} type="button" onClick={() => setAddingMetric(addingMetric === k ? null : k)} className={`h-9 rounded-full border px-3 max-md:h-10 ${addingMetric === k ? "border-fg text-fg" : "border-line text-muted hover:text-fg"}`}>
                              {label}
                            </button>
                          ))}
                          {layout && (
                            <button type="button" onClick={() => setLayout({})} className="h-9 rounded-full px-3 text-faint hover:text-fg max-md:h-10">
                              Back to the default
                            </button>
                          )}
                        </div>
                        {addingMetric && addingMetric !== "campaign" && (
                          <div className="flex flex-wrap gap-1.5">
                            {METRIC_KEYS.filter((k) => !list[addingMetric].includes(k)).map((k) => (
                              <button
                                key={k}
                                type="button"
                                onClick={() => {
                                  setLayout({ ...layout, [addingMetric]: [...list[addingMetric], k].slice(0, addingMetric === "tiles" ? 6 : 10) });
                                  setAddingMetric(null);
                                }}
                                className="h-9 rounded-full bg-surface-2 px-3 text-[12.5px] hover:text-fg max-md:h-10"
                              >
                                {metricLabel(m, k)}
                              </button>
                            ))}
                          </div>
                        )}
                        {addingMetric === "campaign" &&
                          (offPage.length ? (
                            <div className="grid max-h-56 gap-1 overflow-y-auto">
                              {offPage.map((c) => (
                                <button
                                  key={c.name}
                                  type="button"
                                  onClick={() => {
                                    setLayout({ ...layout, campaigns: { hide: hide.filter((x) => x !== c.name), add: [...add, c.name] } });
                                    setAddingMetric(null);
                                  }}
                                  className="flex min-h-10 items-center justify-between gap-3 rounded-[10px] px-3 text-left text-[13px] hover:bg-surface-2"
                                >
                                  <span className="min-w-0 truncate">{c.name}</span>
                                  <span className="tabular shrink-0 text-[12px] text-faint">
                                    ${Math.round(c.spend).toLocaleString("en-US")} · {c.results} {c.result?.toLowerCase() ?? "results"}
                                  </span>
                                </button>
                              ))}
                            </div>
                          ) : (
                            <p className="text-[12.5px] text-faint">Every campaign that spent in the period is already in the report.</p>
                          ))}
                        {(() => {
                          // Campaigns this report's numbers leave out, with the ones excluded by hand one tap from counting again
                          const out = (report.metrics?.leftOut ?? []).filter((c) => !restored.includes(c.name) && !goneNames.has(c.name));
                          if (!out.length) return null;
                          return (
                            <div className="flex flex-wrap items-center gap-1.5 border-t border-line pt-2 text-[12.5px]">
                              <span className="mr-1 text-faint">Not in this report:</span>
                              {out.map((c) => (
                                <span key={c.id} className="inline-flex min-h-9 max-w-full items-center gap-2 rounded-full bg-surface-2 py-1 pl-3 pr-1 max-md:min-h-10">
                                  <span className="min-w-0 truncate text-muted" title={c.why === "match" ? "Outside the KPI's campaign match" : "Excluded from the KPI"}>
                                    {c.name} <span className="tabular text-faint">· ${Math.round(c.spend).toLocaleString("en-US")}</span>
                                  </span>
                                  {c.why === "excluded" ? (
                                    <button type="button" disabled={pending} onClick={() => excludeCampaign({ id: c.id, name: c.name }, false)} className="h-7 shrink-0 rounded-full px-2.5 text-[12px] text-brand-text hover:bg-surface disabled:opacity-50 max-md:h-8">
                                      Count it again
                                    </button>
                                  ) : (
                                    <span className="pr-2 text-[11.5px] text-faint">outside the match</span>
                                  )}
                                </span>
                              ))}
                            </div>
                          );
                        })()}
                        <div className="flex flex-wrap items-center gap-1.5 border-t border-line pt-2 text-[12.5px]">
                          <span className="mr-1 text-faint">Add:</span>
                          {[...LISTS, ["extras", extras.trim() ? "To the note" : "A note (CRM sales, other channels)"] as const].map(([k, label]) => (
                            <button key={k} type="button" onClick={() => setAdding({ key: k, text: "" })} className={`h-9 rounded-full border px-3 max-md:h-10 ${adding?.key === k ? "border-fg text-fg" : "border-line text-muted hover:text-fg"}`}>
                              + {label}
                            </button>
                          ))}
                        </div>
                        {adding && (
                          <form
                            onSubmit={(e) => {
                              e.preventDefault();
                              const t = adding.text.trim();
                              if (!t) return;
                              if (adding.key === "extras") setExtras(extras.trim() ? `${extras.trim()}
${t}` : t);
                              else setSections({ ...sections, [adding.key]: [...sections[adding.key], t] });
                              setAdding(null);
                            }}
                            className="flex flex-wrap gap-2"
                          >
                            <textarea autoFocus value={adding.text} onChange={(e) => setAdding({ ...adding, text: e.target.value })} rows={2} placeholder="Write it as it should read in the report" className="min-w-0 flex-1 resize-none rounded-[10px] border border-line bg-bg px-3 py-2 text-sm outline-none [field-sizing:content] focus:border-brand-text/60" />
                            <div className="flex items-end gap-1.5">
                              <button type="button" onClick={() => setAdding(null)} className="h-10 rounded-full px-3 text-[13px] text-muted hover:text-fg">Cancel</button>
                              <button type="submit" disabled={!adding.text.trim()} className="h-10 rounded-full bg-fg px-4 text-[13px] text-bg disabled:opacity-40">Add</button>
                            </div>
                          </form>
                        )}
                      </div>
                    )}
                    <PdfPreview
                      source={`/api/reports/${report.id}/preview${joint ? "?whole=1" : ""}`}
                      baseKey={`${report.status}:${JSON.stringify(report.metrics ?? null).length}`}
                      patch={(input) => ({ ...input, parts: input.parts.map((p) => (p.platform === report.platform ? { ...p, sections: sections ?? p.sections, extras, layout: shownLayout } : p)) })}
                      patchKey={JSON.stringify({ sections, extras, layout: shownLayout })}
                      fields={fields}
                      editable={editable}
                      onSave={(id, v) => save(id, v)}
                      onRemove={(id) => save(id, null)}
                      hotMenu={hotMenu}
                    />
                  </div>
                );
              })()
            )}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-faint">
              {editable && <span>This is the PDF the client gets. Click any line you wrote to change it; the pages update once it saves.</span>}
              <a href={`/api/reports/${report.id}/pdf${joint ? "?whole=1" : ""}`} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center md:min-h-0 hover:text-fg">
                {joint ? "Preview the whole report (PDF) ↗" : "Preview the PDF ↗"}
              </a>
              {report.kind === "monthly" && <RecapDeckButton reportId={report.id} />}
              {!sent && !built && report.kind !== "monthly" && (
                <button type="button" onClick={() => start(async () => void (await skipReport(report.id), router.push("/reports")))} className="hover:text-fg">
                  Skip this one
                </button>
              )}
            </div>
            {act && sections && !busy && <NextStepsAct reportId={report.id} platform={report.platform} steps={[...sections.next, ...(sections.stories ?? []).map((st) => st.next)]} write={act.write} canSwitch={act.canSwitch} />}
          </div>

          {/* The side: ask the AI for a change (the document updates), or the QA's checks */}
          {(() => {
            const tabs = (
              <div className="flex items-center gap-1.5">
                <div className="flex flex-1 gap-1 rounded-full bg-surface-2 p-1 text-sm">
                  {(["ai", "checks"] as const).map((k) => (
                    <button key={k} type="button" onClick={() => setRail(k)} className={`h-9 flex-1 rounded-full px-3 transition-colors ${rail === k ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
                      {k === "ai" ? "Ask the AI" : `Checks${qa?.flags.length ? ` · ${qa.flags.length}` : ""}`}
                    </button>
                  ))}
                </div>
                <PanelButton label={minned ? "Restore the panel" : "Minimize"} onClick={() => (minned ? closeParams("chat") : pushParams({ chat: "min" }))}>
                  {minned ? "▴" : "–"}
                </PanelButton>
                <PanelButton label={maxed ? "Restore the panel" : "Maximize"} onClick={() => (maxed ? closeParams("chat") : pushParams({ chat: "max" }))}>
                  {maxed ? "⤡" : "⤢"}
                </PanelButton>
              </div>
            );
            const thread = (big: boolean) => (
              <div className={`grid content-start gap-2.5 overflow-y-auto pr-1 ${big ? "min-h-0 flex-1" : "max-h-[52vh] min-h-[180px]"}`}>
                {!chat.length && (
                  <div className={`grid gap-2.5 leading-relaxed text-faint ${big ? "text-sm" : "text-xs"}`}>
                    <p>Say what to change and watch the report update. It can look things up as it goes: live numbers from the ad account, Motion, the client&apos;s calls, Slack, email and Drive, and earlier reports.</p>
                    {editable && (
                      <div className="flex flex-wrap gap-1.5">
                        {LOOKUPS.map((x) => (
                          <button key={x} type="button" onClick={() => tweak(x)} disabled={asking} className="rounded-full border border-brand/30 bg-brand/[0.06] px-2.5 py-1 text-[11.5px] text-fg hover:border-brand/60 disabled:opacity-40 max-md:min-h-9">
                            {x}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {chat.map((t, i) => (
                  <div key={i} className={`grid max-w-[88%] gap-1.5 ${t.role === "user" ? "justify-self-end" : ""}`}>
                    <p className={`whitespace-pre-wrap rounded-[14px] px-3.5 py-2.5 leading-relaxed ${big ? "text-[15px]" : "text-[13.5px]"} ${t.role === "user" ? "bg-fg text-bg" : "bg-surface-2 text-fg"}`}>{t.text}</p>
                    {/* Where it looked, so the buyer knows where a number came from */}
                    {t.pulled?.length ? (
                      <div className="flex flex-wrap gap-1">
                        {t.pulled.map((x, k) => (
                          <span key={k} className="rounded-full border border-line px-2 py-0.5 text-[10.5px] text-faint">
                            ↳ {x}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
                {asking && <p className="flex items-center gap-2 text-xs text-faint"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" /> Looking things up and changing it…</p>}
                <div ref={big ? bigEnd : chatEnd} />
              </div>
            );
            const composer = (big: boolean) =>
              editable && (
                <div className="grid gap-2.5">
                  <div className="flex flex-wrap gap-1.5">
                    {SUGGEST.map((x) => (
                      <button key={x} type="button" onClick={() => tweak(x)} disabled={asking} className="rounded-full border border-line px-2.5 py-1 text-[11.5px] text-muted hover:text-fg disabled:opacity-40 max-md:min-h-9">
                        {x}
                      </button>
                    ))}
                  </div>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void tweak(ask);
                    }}
                    className="grid gap-2 rounded-[14px] border border-line bg-bg p-2 focus-within:border-brand-text/60"
                  >
                    {/* Room to write: Enter sends, Shift+Enter starts a new line */}
                    <textarea
                      value={ask}
                      onChange={(e) => setAsk(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          void tweak(ask);
                        }
                      }}
                      rows={big ? 4 : 3}
                      placeholder="e.g. pull last month's top 3 ads from Motion, or add what they said on Tuesday's call"
                      className={`w-full resize-none bg-transparent px-1.5 py-1 leading-relaxed outline-none ${big ? "text-[15px]" : "text-sm"} [field-sizing:content] ${big ? "max-h-[30vh] min-h-[104px]" : "max-h-[22vh] min-h-[72px]"}`}
                    />
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] text-faint max-md:hidden">Enter to send · Shift+Enter for a new line</span>
                      <button type="submit" disabled={!ask.trim() || asking} className="ml-auto h-9 shrink-0 rounded-full bg-fg px-4 text-sm text-bg disabled:opacity-40 max-md:h-11">
                        Change
                      </button>
                    </div>
                  </form>
                </div>
              );
            const checks = (
              <div className="grid content-start gap-2 overflow-y-auto">
                {!qa ? (
                  <p className="text-xs text-faint">Not checked yet.</p>
                ) : qa.flags.length === 0 ? (
                  <p className="text-sm text-ok">The QA found nothing to fix: every number matches the data.</p>
                ) : (
                  qa.flags.map((f, i) => (
                    <div key={i} className={`grid gap-1 rounded-[10px] border px-3 py-2 text-[12.5px] ${f.severity === "fix" ? "border-bad/40 bg-bad-soft/40" : f.severity === "alert" ? "border-warn/40 bg-warn-soft/40" : "border-line"}`}>
                      <span className={`text-[10px] font-semibold uppercase tracking-[0.1em] ${f.severity === "fix" ? "text-bad" : f.severity === "alert" ? "text-warn" : "text-muted"}`}>{f.severity === "fix" ? "Fix" : f.severity === "alert" ? "Heads up" : "Check"}</span>
                      <span>{f.issue}</span>
                      <span className="text-muted">{f.suggestion}</span>
                    </div>
                  ))
                )}
                {editable && (
                  <button type="button" onClick={() => start(async () => { const r = await checkAgain(report.id); if (r.ok) setQa(r.qa); })} className="h-9 justify-self-start rounded-full border border-line px-3 text-xs text-muted hover:text-fg">
                    {pending ? "Checking…" : "Check again"}
                  </button>
                )}
              </div>
            );
            const approveBlock = !sent && sections && !busy && (
              <div className="grid gap-2 border-t border-line pt-3">
                {mineDone ? (
                  <p className="text-sm text-ok">
                    ✓ Your part is approved.{" "}
                    {bundle?.isBuilder ? (
                      <button type="button" onClick={() => setStep("message")} className="underline">
                        On to the message →
                      </button>
                    ) : built ? (
                      `${bundle?.builder ?? "Whoever built it"} sends it as one report.`
                    ) : (
                      `It goes to the client when ${bundle?.parts.filter((p) => !p.isMe && !["submitted", "posted", "skipped"].includes(p.status)).map((p) => `${p.owner ?? "the other buyer"} (${p.platform === "google" ? "Google" : "Meta"})`).join(" and ") || "the other part"} is approved too.`
                    )}{" "}
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() =>
                        start(async () => {
                          const r = await reopenReport(report.id);
                          if (!r.ok) setNote({ ok: false, text: r.error });
                          else {
                            setStep("report");
                            router.refresh();
                          }
                        })
                      }
                      className="text-muted underline hover:text-fg"
                    >
                      Back to editing
                    </button>
                    {/* Don't wait on the other buyer: this part goes now, theirs follows on its own */}
                    {!built && report.kind === "monthly" && bundle?.parts.some((p) => !p.isMe && !["submitted", "posted", "skipped"].includes(p.status)) && (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => {
                          if (!confirm("Send your part to the client now, without waiting on the other buyer? Their part goes out on its own when they approve it.")) return;
                          start(async () => {
                            const r = await sendMyPartNow(report.id);
                            setNote(r.ok ? { ok: true, text: r.note } : { ok: false, text: r.error });
                            router.refresh();
                          });
                        }}
                        className="mt-2 block h-10 rounded-full border border-line px-4 text-[13px] text-fg hover:border-faint disabled:opacity-50"
                      >
                        Send my part now →
                      </button>
                    )}
                  </p>
                ) : (
                  <button type="button" disabled={pending || stale} title={stale ? "Redraw every page for the report's dates first" : undefined} onClick={approve} className="h-11 rounded-brand bg-brand px-4 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-50 max-md:h-12">
                    {pending ? "One moment…" : report.kind === "monthly" ? "Approve and submit my part" : built ? (bundle?.isBuilder ? "Approve report →" : "Approve my part") : "Approve report →"}
                  </button>
                )}
                {qa?.verdict === "fix" && !mineDone && <p className="text-[11.5px] text-bad">The QA found something to fix: worth a look in Checks first.</p>}
              </div>
            );

            // Minimized: a bar along the bottom, so the report has the whole width
            if (minned)
              return (
                <Layer>
                  <div className="fixed inset-x-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-40 px-4 md:bottom-5 md:left-auto md:right-6 md:w-[460px] md:px-0">
                    <div className="grid gap-3 rounded-[18px] border border-line bg-surface/95 p-3 shadow-[0_18px_50px_-20px_rgba(0,0,0,0.6)] backdrop-blur-xl">
                      {tabs}
                      {approveBlock}
                    </div>
                  </div>
                </Layer>
              );
            return (
              <>
                <aside className="grid gap-3 rounded-[16px] border border-line bg-surface p-4 lg:sticky lg:top-20">
                  {tabs}
                  {maxed ? <p className="text-xs text-faint">Open in the big panel.</p> : rail === "ai" ? <div className="grid gap-3">{thread(false)}{composer(false)}</div> : checks}
                  {approveBlock}
                </aside>
                {/* Maximized: a big panel over the right of the page; the report stays in view on wide screens */}
                {maxed && (
                  <Layer>
                    <div className="fixed inset-0 z-50 flex justify-end">
                      <button type="button" aria-label="Restore the panel" onClick={() => closeParams("chat")} className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" />
                      <div className="relative flex h-full w-full flex-col gap-4 border-l border-line bg-surface p-4 pt-[calc(1rem+env(safe-area-inset-top))] shadow-[0_0_80px_-20px_rgba(0,0,0,0.7)] md:w-[min(760px,92vw)] md:p-6">
                        {tabs}
                        {rail === "ai" ? (
                          <>
                            {thread(true)}
                            {composer(true)}
                          </>
                        ) : (
                          <div className="min-h-0 flex-1 overflow-y-auto">{checks}</div>
                        )}
                        {approveBlock}
                      </div>
                    </div>
                  </Layer>
                )}
              </>
            );
          })()}
        </div>
      )}

      {step === "message" && (
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="grid min-w-0 gap-3">
            {!message && built ? (
              <p className="rounded-[12px] border border-line bg-surface px-4 py-10 text-center text-sm text-muted">{joint ? "Putting each buyer's message together into one…" : "Writing the message…"}</p>
            ) : syncing ? (
              <p className="flex items-center justify-center gap-2 rounded-[12px] border border-line bg-surface px-4 py-10 text-center text-sm text-muted">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" /> Updating the message to match your changes to the report…
              </p>
            ) : (
              <>
                {viaSlack && (
                  <>
                    {/* What posts in Slack, and that it can be changed here before it goes */}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-[13px] text-muted">This is exactly what posts in the client&rsquo;s Slack channel, with the PDF. Change anything before you send.</p>
                      <button type="button" onClick={() => setEditMsg((x) => !x)} className={`h-10 rounded-full px-4 text-[13px] ${editMsg ? "bg-fg text-bg" : "border border-brand/60 text-brand-text hover:bg-brand/10"}`}>
                        {editMsg ? "✓ Done editing" : "✎ Edit the message"}
                      </button>
                    </div>
                    {editMsg ? (
                      <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={16} autoFocus className="w-full rounded-[12px] border border-brand/50 bg-surface px-4 py-3 font-mono text-[13px] leading-relaxed outline-none focus:border-brand-text/60" />
                    ) : (
                      <button type="button" onClick={() => setEditMsg(true)} className="block w-full cursor-text rounded-[12px] text-left ring-brand/40 transition-shadow hover:ring-2" aria-label="Edit the message">
                        <SlackPreview from={from} text={message} file={fileName} />
                      </button>
                    )}
                  </>
                )}
                {viaEmail && <EmailPreview mail={buildReportEmail({ client: client.name, kind: report.kind, periodLabel: report.periodLabel, parts: [{ platform: report.platform, metrics: report.metrics, sections }], from: { name: slack.me, email: null }, first: route.recipients[0]?.name?.split(" ")[0] ?? null, note: emailNote })} to={route.recipients.map((r) => r.email)} file={fileName} />}
              </>
            )}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-faint">
              {built && joint && !bundle?.messageApproved && (
                <button type="button" onClick={() => start(async () => { const r = await builtMessage(bundle!.id, true); if (r.ok) setMessage(r.message); })} className="hover:text-fg">
                  Put it together again from the parts
                </button>
              )}
              {viaSlack && <span>*bold* · _italic_ · • bullets, as Slack shows them</span>}
              {/* Approved by mistake, or one more change: back to the report (nothing has gone out) */}
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const r = await reopenReport(report.id);
                    if (!r.ok) return setNote({ ok: false, text: r.error });
                    setStep("report");
                    router.refresh();
                  })
                }
                className="ml-auto text-muted hover:text-fg"
              >
                ← Back to editing the report
              </button>
            </div>
          </div>
          <aside className="grid gap-3 rounded-[16px] border border-line bg-surface p-4 lg:sticky lg:top-20">
            <p className="text-sm font-medium">{joint ? "One report, from Kaizen" : "From you"}</p>
            <p className="text-xs leading-relaxed text-muted">
              {joint
                ? "Every service in one PDF (the whole account first, then each service): in Slack one message from the Kaizen app, by email one email from the agency."
                : "In Slack, posted in their channel as you. By email, from the agency's address with replies to you. The PDF goes with both."}
            </p>
            <DeliveryPicker value={route} onChange={setRoute} options={delivery ?? { contacts: [], initial: route, slackChannel: client.hasChannel, emailReady: true }} disabled={pending || Boolean(bundle?.messageApproved && !sent)} />
            {viaEmail && (
              <label className="grid gap-1.5">
                <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">A line for the email (optional)</span>
                <textarea value={emailNote} onChange={(e) => setEmailNote(e.target.value)} rows={2} maxLength={600} placeholder="e.g. Happy to walk through it on Thursday's call." className="resize-none rounded-[12px] border border-line bg-bg px-3 py-2 text-sm outline-none [field-sizing:content] focus:border-brand-text/60" />
              </label>
            )}
            {viaSlack && !joint && !slack.connected && (
              <div className="grid gap-2 rounded-[10px] border border-warn/40 bg-warn-soft/40 px-3 py-3">
                <p className="text-xs text-warn">Connect your Slack so it goes out as you, with your name and photo.</p>
                <SlackConnect connected={false} />
              </div>
            )}
            {built && waitingParts.length > 0 && (
              <p className="rounded-[10px] bg-surface-2 px-3 py-2 text-xs text-muted">
                Waiting on {waitingParts.map((p) => `${p.owner ?? "the other buyer"} (${platformName(p.platform as "meta" | "google").replace(" Ads", "")})`).join(" and ")}. Approve the message now and it goes out the moment they approve theirs.
              </p>
            )}
            {bundle?.messageApproved && !sent ? (
              <p className="text-sm text-ok">✓ Approved. It goes out as soon as every part is in.</p>
            ) : (
              <button
                type="button"
                disabled={pending || stale || (viaSlack && (!message.trim() || !client.hasChannel || (!joint && !slack.connected))) || (viaEmail && (!route.recipients.length || delivery?.emailReady === false))}
                onClick={send}
                className="h-11 rounded-brand bg-brand px-4 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-40 max-md:h-12"
              >
                {pending ? "Sending…" : built && waitingParts.length ? "Approve the message" : `Approve and send by ${channelsLabel(route.channels).toLowerCase()}`}
              </button>
            )}
          </aside>
        </div>
      )}

      {step === "done" && (
        <div className="grid gap-5">
          <div className="relative isolate grid place-items-center gap-3 overflow-hidden rounded-[20px] border border-line bg-surface px-6 py-12 text-center">
            <span aria-hidden className="pointer-events-none absolute -top-24 left-1/2 -z-10 h-48 w-80 -translate-x-1/2 rounded-full bg-[rgba(52,195,143,0.18)] blur-[70px]" />
            <span className="grid h-12 w-12 place-items-center rounded-full bg-ok-soft text-xl text-ok">✓</span>
            <p className="font-heading text-xl">Sent to {client.name}</p>
            <p className="max-w-md text-sm text-muted">{sentNote ?? (history[0] ? `${report.periodLabel}, by ${channelsLabel(history[0].channels).toLowerCase()}${history[0].to.length ? ` to ${history[0].to.join(", ")}` : ""}.` : `${report.periodLabel}, with the PDF.`)}</p>
            <a href={history[0] ? `/api/reports/sends/${history[0].id}/pdf` : `/api/reports/${report.id}/pdf${joint ? "?whole=1" : ""}`} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center text-sm text-muted underline-offset-4 hover:text-fg hover:underline">
              Open the PDF that went ↗
            </a>
          </div>
          {/* Every time it went, to review, send again or carry on next week */}
          <section className="grid gap-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-heading text-[19px]">Sent</h3>
              <Link href="/reports?view=sent" className="inline-flex min-h-11 items-center text-xs text-faint hover:text-fg md:min-h-0">
                Every report sent →
              </Link>
            </div>
            <SendHistory items={history} showClient={false} empty={<p className="rounded-[14px] border border-line bg-surface px-4 py-6 text-center text-sm text-muted">It went out before sends were kept here. Open the PDF above to review it.</p>} />
          </section>
          {report.metrics && sections && (
            <section className="grid gap-3">
              <h3 className="font-heading text-[19px]">The report</h3>
              <PdfPreview source={`/api/reports/${report.id}/preview${joint ? "?whole=1" : ""}`} baseKey={`sent:${report.id}`} patch={(input) => input} patchKey="sent" fields={[]} editable={false} onSave={() => {}} onRemove={() => {}} />
            </section>
          )}
        </div>
      )}
    </div>
  );
}
