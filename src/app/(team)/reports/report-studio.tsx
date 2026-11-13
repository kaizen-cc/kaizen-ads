"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { SlackConnect } from "@/components/slack-connect";
import { closeParams, pushParams, useParam } from "@/lib/url-state";
import { Layer } from "../clients/[slug]/layer";
import { PdfPreview, type PdfField, type PdfMaker } from "./pdf-preview";
import { EmailFrame } from "./email-frame";
import { scoreColumns, supportKeys, takeawaysFor, weeklyTileKeys, type Takeaway } from "@/lib/reports/weekly-core";
import { RecapDeckButton } from "./recap-deck-button";
import { metricKeysFor, clockTime, metricLabel, platformName, reportBasis, type MetricKey, type ReportLayout } from "@/lib/reports/format";
import type { ReportMetrics } from "@/lib/reports/metrics";
import { jointMessage, jointNote, type JointInfo, type JointNote } from "@/lib/reports/joint-core";
import type { ChatTurn, Qa, Sections } from "@/lib/reports/write";
import { ManualResults, type ManualEntered } from "./manual-results";
import { reportFileName, type DriveSave } from "@/lib/reports/drive-save-core";
import { approveBuiltMessage, approveMyPart, builtMessage, changePeriod, checkAgain, loadCampaignEvents, refreshSlackMessage, regenerate, reopenReport, reviseWithAi, saveLayout, saveManualResults, saveReport, saveToDrive, sendMyPartNow, sendReport, setReportCampaignExcluded } from "./actions";
import { RegenerateButton, UndoRegenerate } from "./regenerate-button";
import { NextStepsAct } from "./next-steps-act";
import type { WriteStatus } from "@/lib/write-status-core";
import { channelsLabel, channelsPhrase, type Delivery } from "@/lib/reports/delivery-core";
import { forClient } from "@/lib/reports/white-label";
import { DeliveryPicker, type DeliveryOptions } from "./delivery-picker";
import { PeriodPicker } from "./period-picker";
import { SkipButton, SkipHistory, SkippedBanner } from "./skip-report";
import type { LogEntry } from "@/lib/reports/skip-log";
import { SendHistory, type HistoryItem } from "./send-history";
import { ReportThis } from "@/components/report-this";
import { messageKey } from "@/lib/chat-report";
import { channelsFor, defaultSendOption, furthestStep, initialStep, previewFormat, previewFormatsFor, resolveStep, sendOptions, stepsFor, type PreviewFormat, type SendOption, type StudioStep } from "@/lib/reports/studio-steps";

// One report, start to finish, in three steps and then sent: review the report (the PDF the client gets, with the AI
// beside it), the message that carries it (Slack, with the write-up), then how it goes out (Slack, email, and Drive for
// a month's report). Each step is in the address (?step=), so back returns to the one before. A built report's parts are
// approved by each buyer; the person who built it writes the message and sends it. A TikTok part riding on the Meta
// report is reviewed on its own page and goes out inside the Meta one: one review, one message, one send.

export type StudioReport = {
  id: string;
  kind: "weekly" | "monthly" | "custom" | "built";
  platform: "meta" | "google" | "tiktok";
  /** Meta + TikTok in one report (weekly or monthly): the Meta report this TikTok part goes with, or the TikTok part riding on this one */
  joint?: JointInfo | null;
  status: string;
  periodLabel: string;
  message: string;
  /** What the message was written from (reportBasis); a report edited since gets its message brought up to date */
  messageBasis: string | null;
  sections: Sections | null;
  metrics: ReportMetrics | null;
  extraMetrics: ReportMetrics[] | null;
  extras: string;
  /** Results the team entered from the client's CRM for the report's period (kept across regenerates) */
  manual: ManualEntered | null;
  /** What happened to it: skipped (and why), brought back; and whether a skipped one can still come back */
  skip?: { log: LogEntry[]; canBringBack: boolean };
  /** Where it was last saved in the client's Drive (and when), if it was */
  driveSave?: DriveSave | null;
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
const STEP_LABEL: Record<StudioStep, string> = { report: "Report", message: "Message", send: "Send", done: "Sent" };
const shortName = (p: string) => platformName(p as "meta" | "google" | "tiktok").replace(" Ads", "");

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
  const now = clockTime(new Date());
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
            {/* The clock can tick over between the server drawing the page and the browser picking it up */}
            <span suppressHydrationWarning className="text-[12px] text-[#ababad]">{now}</span>
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

function PanelButton({ label, onClick, className = "", children }: { label: string; onClick: () => void; className?: string; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className={`grid h-11 w-11 shrink-0 place-items-center rounded-full border border-line text-[15px] text-muted transition-colors hover:border-faint hover:text-fg md:h-9 md:w-9 ${className}`}>
      {children}
    </button>
  );
}

/** Meta + TikTok in one report, said plainly: "Goes out with the Meta report, sent by …" or "Includes TikTok" */
function JointBanner({ note, compact = false }: { note: JointNote; compact?: boolean }) {
  const tone = note.tone === "warn" ? "border-warn/40 bg-warn-soft/40" : note.tone === "ok" ? "border-ok/30 bg-ok-soft/40" : "border-line bg-surface";
  return (
    <div className={`grid gap-1 rounded-[14px] border ${tone} ${compact ? "px-3 py-2.5" : "px-4 py-3"}`}>
      <p className={`flex flex-wrap items-center gap-2 font-medium ${compact ? "text-[13px]" : "text-sm"}`}>
        <span className="rounded-full bg-fg px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-bg">Meta + TikTok</span>
        {note.title}
      </p>
      <p className="text-xs leading-relaxed text-muted">{note.detail}</p>
      {note.link && (
        <a href={note.link.href} className="inline-flex min-h-11 items-center justify-self-start text-xs text-fg underline-offset-4 hover:underline md:min-h-0">
          {note.link.label}
        </a>
      )}
    </div>
  );
}

const ICONS: Record<SendOption, React.ReactNode> = {
  slack: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M5.04 15.17a2.53 2.53 0 1 1-2.52-2.52h2.52zm1.27 0a2.53 2.53 0 0 1 5.05 0v6.31a2.53 2.53 0 1 1-5.05 0zM8.83 5.04a2.53 2.53 0 1 1 2.53-2.52v2.52zm0 1.27a2.53 2.53 0 0 1 0 5.05H2.52a2.53 2.53 0 0 1 0-5.05zM18.96 8.83a2.53 2.53 0 1 1 2.52 2.53h-2.52zm-1.27 0a2.53 2.53 0 0 1-5.05 0V2.52a2.53 2.53 0 0 1 5.05 0zM15.17 18.96a2.53 2.53 0 1 1-2.53 2.52v-2.52zm0-1.27a2.53 2.53 0 0 1 0-5.05h6.31a2.53 2.53 0 0 1 0 5.05z" />
    </svg>
  ),
  email: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </svg>
  ),
  drive: (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
      <path d="M8.5 3.5h7l6 10.5-3.5 6h-12L2.5 14z" />
      <path d="M8.5 3.5 15 14.5H2.5M15.5 3.5 9 14.5l-3 5.5M21.5 14H9" />
    </svg>
  ),
};

/** One way it goes out, as a large radio card (exactly one is picked), with a "Last used" tag when this buyer used it last time */
function OptionCard({ option, title, detail, on, last, disabled, onPick, children }: { option: SendOption; title: string; detail: React.ReactNode; on: boolean; last: boolean; disabled?: boolean; onPick: () => void; children?: React.ReactNode }) {
  return (
    <div className={`grid content-start gap-3 rounded-[18px] border p-4 transition-all ${on ? "border-brand/60 bg-brand/[0.06] shadow-[0_18px_40px_-28px_rgba(200,16,46,0.9)]" : "border-line bg-surface"} ${disabled ? "opacity-60" : ""}`}>
      <button type="button" role="radio" aria-checked={on} disabled={disabled} onClick={onPick} className="grid min-h-[92px] grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 text-left disabled:cursor-not-allowed">
        <span className={`grid h-11 w-11 place-items-center rounded-[14px] ${on ? "bg-brand text-white" : "bg-surface-2 text-muted"}`}>{ICONS[option]}</span>
        <span className="grid min-w-0 gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-[15px] font-medium text-fg">{title}</span>
            {last && <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10.5px] font-medium text-muted">Last used</span>}
          </span>
          <span className="text-[12.5px] leading-snug text-muted">{detail}</span>
        </span>
        <span className={`mt-1 grid h-6 w-6 place-items-center rounded-full text-[12px] ${on ? "bg-brand text-white" : "border border-line"}`}>{on ? "✓" : ""}</span>
      </button>
      {children}
    </div>
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
  lastUsed = [],
}: {
  report: StudioReport;
  /** whiteLabel: the client's reports go out generic (no Kaizen anywhere), shown that way here */
  client: { name: string; slug: string; hasChannel: boolean; whiteLabel?: boolean };
  bundle: StudioBundle | null;
  slack: { connected: boolean; name: string | null; image: string | null; me: string };
  /** Acting on the report's next steps: whether changes can be written to its account, and who can switch them on */
  act?: { write: WriteStatus | null; canSwitch: boolean } | null;
  /** Where it can go (Slack, email to the client's contacts) and how this client got their last one */
  delivery?: DeliveryOptions | null;
  /** Every time this report went to the client */
  history?: HistoryItem[];
  /** How this buyer sent their last report for this client and platform (and Drive, when last month's was saved there) */
  lastUsed?: SendOption[];
}) {
  const router = useRouter();
  const built = report.kind === "built";
  const monthly = report.kind === "monthly";
  const joint = built && (bundle?.parts.length ?? 0) > 1;
  const busy = report.status === "queued" || report.status === "drafting";
  // A built report goes out whole; a recap part can still follow on its own after the others went (sent alone)
  const sent = report.status === "posted" || (built && bundle?.status === "sent");
  const skipped = report.status === "skipped";
  const mineDone = report.status === "submitted";
  const isBuilder = Boolean(bundle?.isBuilder);
  // A TikTok part riding on the Meta report is reviewed here but never sent on its own; a Meta report says it includes TikTok
  const jn = jointNote(report.joint);
  const rider = Boolean(report.joint?.goesWith);
  const riders = (report.joint?.riders ?? []).filter((x) => x.status !== "skipped");
  const ridersWriting = riders.some((x) => ["queued", "drafting", "failed"].includes(x.status));
  const [sections, setSectionsState] = useState<Sections | null>(report.sections);
  const [extras, setExtrasState] = useState(report.extras);
  const [message, setMessage] = useState(built ? (bundle?.message ?? "") : report.message);
  // The TikTok part's own message, which goes out under the Meta one (one post): changed here, saved on its part
  const [riderMsgs, setRiderMsgs] = useState<Record<string, string>>(() => Object.fromEntries(riders.map((x) => [x.id, x.message ?? ""])));
  // The PDF on screen, ready to download (handed over by the preview once it has the report)
  const pdfMaker = useRef<PdfMaker | null>(null);
  const [downloading, setDownloading] = useState(false);
  // Saved to the client's Drive (with the write-up as a last section): where, and when
  const [driveSave, setDriveSave] = useState<DriveSave | null>(report.driveSave ?? null);
  const [savingDrive, setSavingDrive] = useState(false);
  const [driveError, setDriveError] = useState<{ text: string; href?: string } | null>(null);
  const [qa, setQa] = useState<Qa | null>(report.qa);
  const [chat, setChat] = useState<ChatTurn[]>(report.chat);
  const [ask, setAsk] = useState("");
  const [asking, setAsking] = useState(false);
  // The AI chat's last request failed: its error, so it can be reported from the chat
  const [chatError, setChatError] = useState<string | null>(null);
  const [rail, setRail] = useState<"ai" | "checks">("ai");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const [editMsg, setEditMsg] = useState(false);
  // The quiet extras (preview the PDF, the recap deck, skip): a small menu, kept mounted so its sheets survive it closing
  const [more, setMore] = useState(false);
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

  // The steps, in the address (?step=), so back returns to the one before. Once it's sent, it's sent: every entry shows that.
  const shape = { kind: report.kind, rider, built, isBuilder, mineDone, messageApproved: Boolean(bundle?.messageApproved) };
  const [sentHere, setSentHere] = useState(false);
  const asked = useParam("step");
  // The message step's format (Slack, email, PDF), in the address too: back returns to the one before
  const formats = previewFormatsFor({ kind: report.kind, start: report.period.start, end: report.period.end });
  const format: PreviewFormat = previewFormat(useParam("fmt"), lastUsed, formats);
  const steps = stepsFor(shape);
  const initial = initialStep({ ...shape, sent: false });
  const furthest = furthestStep({ ...shape, sent: false });
  const step: StudioStep = sent || sentHere ? "done" : resolveStep(asked, { ...shape, sent: false });
  const setStep = (to: StudioStep) => (to === "done" ? setSentHere(true) : pushParams({ step: to === initial ? null : to }));
  // The editing tools (metrics, lines, CRM results), out of the way until asked for; in the address so back closes them
  const toolsOpen = useParam("tools") === "1";
  const chatEnd = useRef<HTMLDivElement>(null);
  const bigEnd = useRef<HTMLDivElement>(null);
  // The AI panel: beside the report on wide screens, normal, maximized (a big panel; a bottom sheet on phones) or minimized
  // (a bar at the bottom, the report full width). In the address (?chat=max|min), so back returns to how it was.
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
    if (!busy && !ridersWriting && !(bundle && bundle.parts.some((p) => p.status === "drafting" || p.status === "queued"))) return;
    const t = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(t);
  }, [busy, ridersWriting, bundle, router]);
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
  // A built report's message: the combined (or single) message, written from the approved parts
  useEffect(() => {
    if ((step !== "message" && step !== "send") || !built || !bundle || message) return;
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
        setNote({ ok: true, text: "The message now matches the changes you made to the report." });
      }
    });
    return () => {
      live = false;
    };
  }, [syncing, nowBasis, report.id]);

  const editable = !sent && !busy && !skipped && !(built && mineDone) && report.status !== "submitted";
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
    setChatError(null);
    const r = await reviseWithAi(report.id, text);
    setAsking(false);
    if (!r.ok) {
      setNote({ ok: false, text: r.error });
      if (!("openId" in r && r.openId)) setChatError(r.error);
      // The dates asked for already have a report on this account: open that one
      if ("openId" in r && r.openId && confirm(`${r.error} Open it?`)) router.push(`/reports/${r.openId}`);
      return;
    }
    setChat(r.chat);
    // New dates: the whole report is being redrawn (every page), so the page follows it
    if (r.redrawing) return router.refresh();
    setSectionsState(r.sections);
    if (!built) {
      setMessage(r.message);
      setBasis(r.sections ? reportBasis(r.sections, extras) : basis);
    }
    if (r.qa) setQa(r.qa);
    if (r.lesson) setNote({ ok: true, text: `Remembered for this client: ${r.lesson}` });
  };

  // Approved by mistake, or one more change: back to editing (nothing has gone out)
  const reopen = () =>
    start(async () => {
      const r = await reopenReport(report.id);
      if (!r.ok) return setNote({ ok: false, text: r.error });
      setStep("report");
      router.refresh();
    });

  // Step 1 done: on to the message. A built report's part is approved first (the builder then writes the message).
  const toMessage = () => {
    if (!built || mineDone) return setStep("message");
    start(async () => {
      setNote(null);
      const r = await approveMyPart(report.id);
      if (!r.ok) return setNote({ ok: false, text: r.error });
      if (isBuilder) setStep("message");
      else setNote({ ok: true, text: `Approved. ${bundle?.builder ?? "Whoever built it"} sends it with the rest, as one report.` });
      router.refresh();
    });
  };

  // How it goes out: exactly one of Slack, email, or (for a month's report) Drive, starting on how this buyer last sent
  const offers = sendOptions({ kind: report.kind, start: report.period.start, end: report.period.end });
  const [picked, setChoice] = useState<SendOption>(() => defaultSendOption(offers, lastUsed, client.hasChannel));
  // A built report already approved to go out can't change how: only Drive is left to do
  const choice: SendOption = built && bundle?.messageApproved && !sent && offers.includes("drive") ? "drive" : picked;
  const [recipients, setRecipients] = useState<Delivery["recipients"]>(delivery?.initial.recipients ?? []);
  // One channel at a time: a recap's saved channel (report_bundles.delivery) is just the one picked
  const route: Delivery = { channels: channelsFor(choice), recipients };
  const toDrive = choice === "drive";
  const [emailNote, setEmailNote] = useState("");
  const viaSlack = choice === "slack";
  const viaEmail = choice === "email";
  const [sentNote, setSentNote] = useState<string | null>(null);
  // A monthly recap's other parts still with their buyers (it goes out once they're all approved)
  const othersOpen = monthly ? (bundle?.parts.filter((p) => p.id !== report.id && !["submitted", "posted", "skipped"].includes(p.status)) ?? []) : [];
  const othersLabel = othersOpen.map((p) => `${p.owner ?? "the other buyer"} (${shortName(p.platform)})`).join(" and ");
  const waitingParts = bundle?.parts.filter((p) => p.status !== "submitted" && p.status !== "posted") ?? [];
  const stale = report.period.stale.length > 0 && !sent && !busy;
  // Sending happens now, or (an approved recap part, a built report's approved message) it's already queued to go
  const canSend = !sent && !rider && !(monthly && mineDone) && !(built && bundle?.messageApproved);
  const sendNow = canSend && !toDrive;
  const sendProblem = !sendNow
    ? null
    : stale
      ? "Redraw every page for the report's dates first."
      : riders.length && ridersWriting
        ? "The TikTok part is still being written. It goes out inside this report, so send once it's ready."
        : viaSlack && !client.hasChannel
          ? "No Slack channel is linked for this client. Add it on the client page, or send by email."
          : viaSlack && !monthly && !message.trim()
            ? "Write the message first."
            : viaSlack && !monthly && !joint && !slack.connected
              ? "Connect your Slack so it goes out as you."
              : viaEmail && !route.recipients.length
                ? "Pick at least one person to email."
                : viaEmail && delivery?.emailReady === false
                  ? "Email isn't set up yet (RESEND_API_KEY). Send in Slack for now."
                  : null;

  const from = joint ? { name: "Kaizen", image: null, app: true } : { name: slack.name || slack.me, image: slack.image, app: false };
  const fileName = reportFileName({ client: client.name, whiteLabel: Boolean(client.whiteLabel), built, kind: report.kind, platform: report.platform, periodLabel: report.periodLabel });
  // The PDF as it is on screen, under the name it goes out with; the server's copy when the preview isn't drawn yet
  const downloadPdf = async () => {
    setDownloading(true);
    const save = (href: string) => {
      const a = document.createElement("a");
      a.href = href;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
    };
    try {
      if (!pdfMaker.current) throw new Error("not drawn yet");
      const url = URL.createObjectURL(await pdfMaker.current());
      save(url);
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch {
      save(`/api/reports/${report.id}/pdf?download=1${joint ? "&whole=1" : ""}`);
    } finally {
      setDownloading(false);
    }
  };
  // Save to Drive: the PDF with our notes as a last section, in the client's Drive (the client's own PDF never has them)
  const saveDrive = async () => {
    setSavingDrive(true);
    setDriveError(null);
    try {
      const r = await saveToDrive(report.id);
      if (r.ok) {
        setDriveSave(r.save);
        // Saved: back to the one way it goes to the client, ready to send separately
        setChoice(defaultSendOption(offers.filter((o) => o !== "drive"), lastUsed, client.hasChannel));
        // A month's report goes no further than Drive: saved is done, so the page moves on to Saved
        if (monthly) router.refresh();
      } else setDriveError({ text: r.error, href: r.fixHref });
    } catch {
      setDriveError({ text: "It couldn't be saved to Drive. Try again in a moment." });
    } finally {
      setSavingDrive(false);
    }
  };
  const driveStatus = (
    <>
      {driveSave && !driveError && (
        <p className="text-[12px] text-muted">
          Saved to Drive ·{" "}
          {driveSave.url ? (
            <a href={driveSave.url} target="_blank" rel="noreferrer" className="text-fg underline-offset-4 hover:underline">
              Open
            </a>
          ) : (
            "Open"
          )}{" "}
          · {new Date(driveSave.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}
        </p>
      )}
      {driveError && (
        <p className="text-[12px] text-bad">
          {driveError.text}{" "}
          {driveError.href && (
            <Link href={driveError.href} className="underline underline-offset-4">
              Open the client page
            </Link>
          )}
        </p>
      )}
    </>
  );

  // The message the buyer sends: theirs, then the TikTok part's under its own name (one post), and a recap's link line
  const riderParts = riders.map((x) => ({ platform: x.platform, message: riderMsgs[x.id] ?? "" }));
  const slackText = forClient(
    `${riders.length ? jointMessage(message, riderParts) : message}${monthly ? (client.whiteLabel ? `\n\n*Your ${report.periodLabel} recap is attached.*` : `\n\n*Your ${report.periodLabel} recap:* <https://recap|the link to the recap>`) : ""}`,
    client.whiteLabel,
  );
  const saveRiderMessages = () => Promise.all(riders.map((x) => (riderMsgs[x.id] !== (x.message ?? "") ? saveReport(x.id, { message: riderMsgs[x.id] ?? "" }) : null)));

  // Step 3: it goes out (or is approved to go out with the rest), then Drive when picked
  const deliverNow = async (): Promise<boolean> => {
    if (built && bundle) {
      const r = await approveBuiltMessage(bundle.id, message, route);
      if (!r.ok) return (setNote({ ok: false, text: r.error }), false);
      if (r.sent) setStep("done");
      else setNote({ ok: true, text: `Approved. It goes out the moment ${r.waitingOn.join(" and ")} approve${r.waitingOn.length === 1 ? "s" : ""} their part: one report, ${channelsPhrase(route.channels)}.` });
      router.refresh();
      return true;
    }
    await saveReport(report.id, { message });
    await saveRiderMessages();
    const r = await sendReport(report.id, route, monthly ? undefined : emailNote);
    if (!r.ok) return (setNote({ ok: false, text: r.error }), false);
    setSentNote(r.note);
    if (monthly) setNote({ ok: true, text: r.note });
    else setStep("done");
    router.refresh();
    return true;
  };
  const go = () =>
    start(async () => {
      setNote(null);
      if (sendNow && !(await deliverNow())) return;
      if (toDrive) await saveDrive();
    });
  const partNow = () => {
    if (!confirm("Send your part to the client now, without waiting on the other buyer? Their part goes out on its own when they approve it.")) return;
    start(async () => {
      setNote(null);
      await saveReport(report.id, { message });
      await saveRiderMessages();
      const r = await sendMyPartNow(report.id, route);
      setNote(r.ok ? { ok: true, text: r.note } : { ok: false, text: r.error });
      if (r.ok) setSentNote(r.note);
      router.refresh();
    });
  };

  // Skipped: who, when and why, with the way back; nothing to edit or send until it's brought back
  if (skipped)
    return (
      <div className="grid gap-4">
        <SkippedBanner id={report.id} log={report.skip?.log ?? []} canBringBack={report.skip?.canBringBack ?? true} />
        <a href={`/api/reports/${report.id}/pdf${joint ? "?whole=1" : ""}`} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center text-xs text-faint hover:text-fg md:min-h-0">
          Preview the PDF as it stood ↗
        </a>
      </div>
    );

  // ─── The document: every line the buyer writes, the metrics on the page, and the tools that change them ─────────
  const LISTS = [["did", "What we did"], ["doing", "What we're doing"], ["next", "What's next"]] as const;
  const weekly = report.kind !== "monthly" && report.kind !== "built";
  const doc = (() => {
    if (!sections) return null;
    const cards: Takeaway[] = weekly && report.metrics ? takeawaysFor(report.metrics, sections.takeaways) : [];
    const fields: PdfField[] = [
      { id: "headline", label: "Headline", value: sections.headline },
      { id: "summary", label: "Summary", value: sections.summary },
      ...LISTS.flatMap(([k, label]) => (sections[k] ?? []).map((v, i, all) => ({ id: `${k}.${i}`, label, value: v, removable: true, list: { at: i, count: all.length } }))),
      { id: "extras", label: "Also (sales from their CRM, other channels…)", value: extras, removable: true },
      // The weekly's three takeaway cards (worked out from the numbers until the buyer or the AI words them)
      ...cards.flatMap((t, i) => [
        { id: `takeaway-${i}-title`, label: "Takeaway", value: t.title },
        { id: `takeaway-${i}-text`, label: "Takeaway, the numbers", value: t.text },
      ]),
      // The results the team entered from the client's CRM: the label of each tile on the page (its numbers are theirs, entered below)
      ...(report.metrics?.manual?.lines ?? []).filter((l) => !l.main).map((l) => ({ id: `manual-${l.id}`, label: "CRM result", value: l.label })),
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
      // A CRM result's label: saved with the rest of what was entered, and the page follows it
      if (id.startsWith("manual-")) {
        const lines = report.manual?.lines ?? [];
        const label = (v ?? "").trim().slice(0, 60);
        if (!label || !lines.some((l) => `manual-${l.id}` === id)) return;
        return start(async () => {
          const r = await saveManualResults(report.id, lines.map((l) => (`manual-${l.id}` === id ? { ...l, label } : l)));
          if (!r.ok) return setNote({ ok: false, text: r.error });
          router.refresh();
        });
      }
      if (id === "headline" || id === "summary") return setSections({ ...sections, [id]: v ?? "" });
      const card = id.match(/^takeaway-(\d+)-(title|text)$/);
      if (card) return setSections({ ...sections, takeaways: cards.map((t, i) => (i === Number(card[1]) ? { ...t, [card[2]]: v ?? "" } : t)) });
      const story = id.match(/^story-(\d+)-(title|see|why|next)$/);
      if (story) return setSections({ ...sections, stories: (sections.stories ?? []).map((st, i) => (i === Number(story[1]) ? { ...st, [story[2]]: v ?? "" } : st)) });
      const [k, n] = id.split(".") as ["did" | "doing" | "next", string];
      setSections({ ...sections, [k]: v ? (sections[k] ?? []).map((y, j) => (j === Number(n) ? v : y)) : (sections[k] ?? []).filter((_, j) => j !== Number(n)) });
    };
    // A new point just below one in the same list (that one's words too, when changed in the same box)
    const addBelow = (id: string, v: string, current?: string) => {
      const [k, n] = id.split(".") as ["did" | "doing" | "next", string];
      const list = (sections[k] ?? []).map((y, j) => (j === Number(n) && current ? current : y));
      if (v) list.splice(Number(n) + 1, 0, v);
      setSections({ ...sections, [k]: list });
    };
    // A point one place up or down in its list
    const move = (id: string, by: -1 | 1) => {
      const [k, n] = id.split(".") as ["did" | "doing" | "next", string];
      const list = [...(sections[k] ?? [])];
      const i = Number(n);
      const j = i + by;
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      setSections({ ...sections, [k]: list });
    };
    // The metrics on the page now, as the PDF draws them
    const goneNames = new Set(gone.map((g) => g.name));
    const m = report.metrics && goneNames.size ? { ...report.metrics, campaigns: report.metrics.campaigns.filter((c) => !goneNames.has(c.name)) } : report.metrics;
    // Every report is drawn in one design: four tiles by the client's KPI, the support line under them (its metrics are
    // the "key metric" rows) and the scorecard's columns. What's clicked on the page is what's changed.
    const tiles = m ? weeklyTileKeys(m, layout) : [];
    const table = m ? supportKeys(m, tiles, layout) : [];
    const columns = m ? scoreColumns(m, layout) : [];
    const hasTable = true;
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
          {metricKeysFor(report.platform).filter((k) => k === current || !list[where].includes(k)).map((k) => (
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
      if (platform !== report.platform) {
        const other = riders.find((x) => x.platform === platform);
        return other ? (
          <a href={`/reports/${other.id}`} className="flex min-h-10 items-center rounded-[10px] px-3 text-[13px] text-fg hover:bg-surface-2">
            The {shortName(platform)} part is changed on its own page. Open it →
          </a>
        ) : (
          <p className="text-[13px] text-muted">This part is the other buyer&rsquo;s: they change it from their report.</p>
        );
      }
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
    // The editing tools: metrics on the page, campaigns left out, lines for the message, and the CRM results
    const tools =
      editable && m ? (
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
            <span className="mr-1 text-faint">Metrics:</span>
            <button type="button" disabled={asking} onClick={() => void tweak("Add a trend chart of the cost per result by week for the last 5 weeks, with what we see, why and what's next")} className="h-9 rounded-full border border-line px-3 text-muted hover:text-fg disabled:opacity-40 max-md:h-10">
              + Trend chart
            </button>
            {([["tiles", "+ Tile"], ...(hasTable ? [["table", "+ Key metric row"]] : []), ["columns", "+ Scorecard column"], ...(weekly ? [] : [["campaign", "+ Campaign"]])] as ["tiles" | "table" | "columns" | "campaign", string][]).map(([k, label]) => (
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
              {metricKeysFor(report.platform).filter((k) => !list[addingMetric].includes(k)).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => {
                    setLayout({ ...layout, [addingMetric]: [...list[addingMetric], k].slice(0, addingMetric === "tiles" ? 6 : addingMetric === "columns" ? 7 : 10) });
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
                if (adding.key === "extras") setExtras(extras.trim() ? `${extras.trim()}\n${t}` : t);
                else setSections({ ...sections, [adding.key]: [...(sections[adding.key] ?? []), t] });
                setAdding(null);
              }}
              className="flex flex-wrap gap-2"
            >
              <textarea autoFocus value={adding.text} onChange={(e) => setAdding({ ...adding, text: e.target.value })} rows={2} placeholder={adding.key === "extras" ? "Write it as it should read in the message" : monthly ? "Write it as it should read in our notes" : "Write it as it should read in the message (not printed in the report)"} className="min-w-0 flex-1 resize-none rounded-[10px] border border-line bg-bg px-3 py-2 text-sm outline-none [field-sizing:content] focus:border-brand-text/60" />
              <div className="flex items-end gap-1.5">
                <button type="button" onClick={() => setAdding(null)} className="h-10 rounded-full px-3 text-[13px] text-muted hover:text-fg">
                  Cancel
                </button>
                <button type="submit" disabled={!adding.text.trim()} className="h-10 rounded-full bg-fg px-4 text-[13px] text-bg disabled:opacity-40">
                  Add
                </button>
              </div>
            </form>
          )}
        </div>
      ) : null;
    return { fields, save, addBelow, move, shownLayout, hotMenu, tools };
  })();

  // ─── The AI panel: ask for a change (the document and the message update), or the QA's checks ─────────────────
  const reportTurns = () => chat.map((t) => ({ role: t.role === "user" ? "user" : "ai", text: t.text, at: t.at, name: t.by ?? null }));
  const reportState = () => ({ reportId: report.id, kind: report.kind, platform: report.platform, period: { start: report.period.start, end: report.period.end, key: report.period.key }, status: report.status });
  const flagCount = qa?.flags.length ?? 0;
  const tabs = (
    <div className="flex items-center gap-1.5">
      <div className="flex flex-1 gap-1 rounded-full bg-surface-2 p-1 text-sm">
        {(["ai", "checks"] as const).map((k) => (
          <button key={k} type="button" onClick={() => setRail(k)} className={`h-10 flex-1 rounded-full px-3 transition-colors md:h-9 ${rail === k ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
            {k === "ai" ? "Ask the AI" : `Checks${flagCount ? ` · ${flagCount}` : ""}`}
          </button>
        ))}
      </div>
      <PanelButton label={minned ? "Restore the panel" : "Minimize"} onClick={() => (minned ? closeParams("chat") : pushParams({ chat: "min" }))} className="max-lg:hidden">
        {minned ? "▴" : "–"}
      </PanelButton>
      <PanelButton label={maxed ? "Close" : "Maximize"} onClick={() => (maxed ? closeParams("chat") : pushParams({ chat: "max" }))}>
        {maxed ? <span className="max-md:hidden">⤡</span> : "⤢"}
        {maxed && <span className="md:hidden">×</span>}
      </PanelButton>
    </div>
  );
  const thread = (big: boolean) => (
    <div className={`grid content-start gap-2.5 overflow-y-auto pr-1 ${big ? "min-h-0 flex-1" : "max-h-[52vh] min-h-[180px]"}`}>
      {!chat.length && (
        <div className={`grid gap-2.5 leading-relaxed text-faint ${big ? "text-sm" : "text-xs"}`}>
          <p>{step === "message" ? "Say what to change in the message or the report and watch both update." : "Say what to change and watch the report update."} It can look things up as it goes: live numbers from the ad account, Motion, the client&apos;s calls, Slack, email and Drive, and earlier reports.</p>
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
          {t.role === "assistant" && <ReportThis chat="report-studio" messageId={messageKey(i, t.text)} threadId={report.id} text={t.text} turns={reportTurns} state={reportState} clientSlug={client.slug} />}
        </div>
      ))}
      {chatError && !asking && (
        <div className="grid gap-1.5">
          <p className={`text-bad ${big ? "text-sm" : "text-xs"}`}>{chatError}</p>
          <ReportThis chat="report-studio" messageId={`error-${messageKey(chat.length, chatError)}`} threadId={report.id} error={chatError} turns={reportTurns} state={reportState} clientSlug={client.slug} />
        </div>
      )}
      {asking && (
        <p className="flex items-center gap-2 text-xs text-faint">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" /> Looking things up and changing it…
        </p>
      )}
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
            placeholder={step === "message" ? "e.g. make the message warmer, or mention Tuesday's call" : "e.g. pull last month's top 3 ads from Motion, or add what they said on Tuesday's call"}
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
        <button
          type="button"
          onClick={() =>
            start(async () => {
              const r = await checkAgain(report.id);
              if (r.ok) setQa(r.qa);
            })
          }
          className="h-10 justify-self-start rounded-full border border-line px-3 text-xs text-muted hover:text-fg md:h-9"
        >
          {pending ? "Checking…" : "Check again"}
        </button>
      )}
    </div>
  );
  const qaWarning = qa?.verdict === "fix" && !mineDone && !sent ? (
    <button type="button" onClick={() => setRail("checks")} className="text-left text-[12px] text-bad underline-offset-4 hover:underline">
      The QA found something to fix: worth a look in Checks first.
    </button>
  ) : null;

  // The one thing to do on each step, as a big button (the AI panel's foot on desktop, the bottom bar on phones)
  const primaryClass = "inline-flex h-12 w-full items-center justify-center gap-2 rounded-brand bg-brand px-4 text-sm font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-50";
  const reviewPrimary = rider ? (
    report.joint?.goesWith ? (
      <a href={`/reports/${report.joint.goesWith.id}${monthly ? "" : "?step=message"}`} className={primaryClass}>
        Continue on the Meta report →
      </a>
    ) : null
  ) : sent || busy || !sections ? null : monthly ? (
    // A month's report is saved to the client's Drive right here, with the write-up under it
    <button type="button" disabled={pending || savingDrive || stale} title={stale ? "Redraw every page for the report's dates first" : undefined} onClick={() => void saveDrive()} className={primaryClass}>
      {savingDrive ? "Saving to Drive…" : driveSave ? "Save to Drive again" : "Save to Drive"}
    </button>
  ) : mineDone && built ? (
    built && !isBuilder ? (
      <p className="text-center text-[13px] text-muted">{bundle?.builder ?? "Whoever built it"} sends it as one report.</p>
    ) : (
      <button type="button" onClick={() => setStep(built ? "message" : "send")} className={primaryClass}>
        {built ? "On to the message →" : "On to sending →"}
      </button>
    )
  ) : (
    <button type="button" disabled={pending || stale} title={stale ? "Redraw every page for the report's dates first" : undefined} onClick={toMessage} className={primaryClass}>
      {pending ? "One moment…" : built && !isBuilder ? "Approve my part" : "Looks good, continue to the message"}
    </button>
  );
  const messagePrimary = (
    <button type="button" disabled={syncing || (built && !message)} onClick={() => setStep("send")} className={primaryClass}>
      Continue to send →
    </button>
  );
  const approvedNote =
    mineDone && (monthly || built) && !sent ? (
      <p className="text-[12.5px] leading-snug text-muted">
        <span className="text-ok">✓ Your part is approved.</span> Locked while it waits to go out.{" "}
        <button type="button" disabled={pending} onClick={reopen} className="text-fg underline underline-offset-4 disabled:opacity-50">
          Back to editing
        </button>
      </p>
    ) : null;

  // The side panel and, on phones, the bottom bar with the AI and the step's one button
  const sidePanel = (foot: React.ReactNode) => {
    const panelFoot = (
      <div className="grid gap-2 border-t border-line pt-3">
        {approvedNote}
        {foot}
        {qaWarning}
      </div>
    );
    return (
      <>
        {minned ? (
          <Layer>
            <div className="fixed bottom-5 right-6 z-40 w-[460px] max-lg:hidden">
              <div className="grid gap-3 rounded-[18px] border border-line bg-surface/95 p-3 shadow-[0_18px_50px_-20px_rgba(0,0,0,0.6)] backdrop-blur-xl">
                {tabs}
                {panelFoot}
              </div>
            </div>
          </Layer>
        ) : (
          <aside className="grid gap-3 rounded-[16px] border border-line bg-surface p-4 max-lg:hidden lg:sticky lg:top-20">
            {tabs}
            {maxed ? <p className="text-xs text-faint">Open in the big panel.</p> : rail === "ai" ? <div className="grid gap-3">{thread(false)}{composer(false)}</div> : checks}
            {panelFoot}
          </aside>
        )}
        {/* Phones and tablets: the AI one tap away, and the step's button always in reach */}
        <Layer>
          <div className="fixed inset-x-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-40 px-4 md:bottom-5 lg:hidden">
            <div className="mx-auto grid max-w-xl gap-2 rounded-[20px] border border-line bg-surface/95 p-2 shadow-[0_18px_50px_-20px_rgba(0,0,0,0.6)] backdrop-blur-xl">
              {(approvedNote || (rider && jn)) && <div className="px-2 pt-1">{approvedNote ?? <p className="text-[12.5px] text-muted">{jn?.title}</p>}</div>}
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => pushParams({ chat: "max" })} className="inline-flex h-12 shrink-0 items-center gap-2 rounded-[14px] border border-line px-3.5 text-[13.5px] text-fg">
                  <span className="h-1.5 w-1.5 rounded-full bg-brand" aria-hidden />
                  Ask the AI{flagCount ? <span className="tabular text-faint">· {flagCount}</span> : null}
                </button>
                <div className="grid min-w-0 flex-1">{foot}</div>
              </div>
            </div>
          </div>
        </Layer>
        {/* Maximized: a big panel over the right of the page on wide screens, a bottom sheet on phones */}
        {maxed && (
          <Layer>
            <div className="fixed inset-0 z-50 flex items-end justify-end md:items-stretch">
              <button type="button" aria-label="Close the panel" onClick={() => closeParams("chat")} className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" />
              <div className="relative flex h-[88dvh] w-full flex-col gap-4 rounded-t-[24px] border-t border-line bg-surface p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-[0_0_80px_-20px_rgba(0,0,0,0.7)] md:h-full md:w-[min(760px,92vw)] md:rounded-none md:border-l md:border-t-0 md:p-6 md:pt-[calc(1.5rem+env(safe-area-inset-top))]">
                <span aria-hidden className="mx-auto -mt-1 h-1 w-10 shrink-0 rounded-full bg-line md:hidden" />
                {tabs}
                {rail === "ai" ? (
                  <>
                    {thread(true)}
                    {composer(true)}
                  </>
                ) : (
                  <div className="min-h-0 flex-1 overflow-y-auto">{checks}</div>
                )}
                {panelFoot}
              </div>
            </div>
          </Layer>
        )}
      </>
    );
  };

  // ─── Step 3: how it goes out ─────────────────────────────────────────────────────────────────────────────────
  const optionDetail: Record<SendOption, React.ReactNode> = {
    slack: !client.hasChannel ? "No Slack channel is linked for this client yet." : joint ? "One message from the Kaizen app in their channel, with the PDF." : monthly ? "Posted in their channel with the recap and its PDF." : "Posted in their channel as you, with the PDF.",
    email: monthly ? (client.whiteLabel ? "The recap email with the PDF attached." : "The recap email with the link to the recap.") : "From the agency's address, replies come to you. PDF attached.",
    drive: driveSave ? "Saved. Pick it to save a new version." : "The PDF with your write-up, in the client's reports folder.",
  };
  // Slack and email can be picked until it's on its way (an approved recap part still picks them for Send my part now)
  const routeOpen = !sent && !rider && !(built && bundle?.messageApproved);
  const channelsLocked = !routeOpen || pending;
  const sendLabel = (() => {
    if (sendNow) return built && waitingParts.length ? "Approve the message" : monthly && othersOpen.length ? "Approve my part" : `Send ${channelsPhrase(route.channels)}`;
    if (toDrive) return driveSave ? "Save to Drive again" : "Save to Drive";
    return null;
  })();

  return (
    <div className={`grid gap-5 ${step === "report" || step === "message" ? "max-lg:pb-36" : ""}`}>
      {/* Where it is: the steps, and a built or monthly report's parts */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ol className="-mx-1 flex max-w-full items-center gap-1 overflow-x-auto px-1 text-sm [scrollbar-width:none]" aria-label="Steps">
          {steps.map((s, i) => {
            const at = steps.indexOf(step);
            const on = s === step;
            const reachable = !sent && s !== "done" && i <= steps.indexOf(furthest);
            return (
              <li key={s} className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  disabled={!reachable || on}
                  aria-current={on ? "step" : undefined}
                  onClick={() => setStep(s)}
                  className={`flex h-10 items-center gap-2 rounded-full px-3 transition-colors md:h-9 md:px-3.5 ${on ? "bg-fg text-bg" : i < at ? "text-fg hover:bg-surface-2" : reachable ? "text-muted hover:bg-surface-2 hover:text-fg" : "text-faint"}`}
                >
                  <span className={`grid h-5 w-5 place-items-center rounded-full text-[11px] font-semibold ${on ? "bg-bg text-fg" : i < at ? "bg-ok text-white" : "border border-line"}`}>{i < at ? "✓" : i + 1}</span>
                  {s === "report" && built && joint ? "Your part" : s === "done" && monthly ? "Saved" : STEP_LABEL[s]}
                </button>
                {i < steps.length - 1 && <span className="h-px w-3 bg-line md:w-4" />}
              </li>
            );
          })}
        </ol>
        {bundle && bundle.parts.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            {bundle.parts.map((p) => (
              <a
                key={p.id}
                href={`/reports/${p.id}`}
                className={`flex h-11 items-center gap-2 rounded-full border px-3.5 text-xs md:h-8 md:px-3 ${p.id === report.id ? "border-fg/40" : "border-line"} ${p.status === "submitted" || p.status === "posted" ? "text-ok" : "text-muted"}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${p.status === "submitted" || p.status === "posted" ? "bg-ok" : p.status === "drafting" ? "animate-pulse bg-faint" : "bg-warn"}`} />
                {shortName(p.platform)}
                {p.platform === report.platform && riders.length ? " + TikTok" : ""} · {p.isMe ? "you" : (p.owner ?? "buyer")} · {PART_STATUS[p.status] ?? p.status}
              </a>
            ))}
          </div>
        )}
      </div>

      {(report.skip?.log.length ?? 0) > 0 && <SkipHistory log={report.skip!.log} />}

      {/* Meta + TikTok in one report: where this part goes, or what this report carries */}
      {jn && step === "report" && <JointBanner note={jn} />}

      {report.period.behind && !busy && !sent && step === "report" && (
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
      {stale && step !== "done" && (
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
      {gone.length > 0 && !busy && step === "report" && (
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
      {report.regen && !busy && !sent && step === "report" && <UndoRegenerate key={report.regen.at} id={report.id} at={report.regen.at} by={report.regen.by} />}

      {/* ─── Step 1: the report, the hero, with the AI beside it ─── */}
      {step === "report" && (
        <div className={`grid items-start gap-5 ${minned ? "lg:pb-20" : "lg:grid-cols-[minmax(0,1fr)_400px]"}`}>
          <div className="grid min-w-0 gap-3">
            {/* A quiet toolbar: the dates, and the tools for changing the report, out of the way until wanted */}
            <div className="flex flex-wrap items-center gap-2">
              {report.kind !== "monthly" && !sent && (
                <div className="min-w-0 flex-1 basis-60">
                  <PeriodPicker reportId={report.id} start={report.period.start} end={report.period.end} periodKey={report.period.key} today={report.period.today} locked={busy ? "It's being written right now." : report.period.locked} />
                </div>
              )}
              <div className="ml-auto flex flex-wrap items-center gap-1.5">
                {doc && !busy && (editable || report.manual) && (
                  <button
                    type="button"
                    aria-pressed={toolsOpen}
                    onClick={() => (toolsOpen ? closeParams("tools") : pushParams({ tools: "1" }))}
                    className={`inline-flex h-11 items-center gap-2 rounded-full border px-4 text-sm transition-colors md:h-9 ${toolsOpen ? "border-fg bg-fg text-bg" : "border-line text-muted hover:border-faint hover:text-fg"}`}
                  >
                    <svg viewBox="0 0 16 16" aria-hidden className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M10.5 2.5 13.5 5.5 6 13H3v-3z" />
                    </svg>
                    Edit
                  </button>
                )}
                {!busy && <RegenerateButton kind="one" variant="header" id={report.id} label={`${client.name}'s report`} sent={sent} approved={report.status === "submitted"} />}
                <button type="button" disabled={downloading || busy || !sections} onClick={() => void downloadPdf()} aria-label="Download PDF" title="Download PDF" className="inline-flex h-11 items-center justify-center gap-2 rounded-full border border-line px-3.5 text-sm text-muted transition-colors hover:border-faint hover:text-fg disabled:opacity-50 md:h-9">
                  <svg viewBox="0 0 16 16" aria-hidden className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" />
                  </svg>
                  <span className="max-sm:hidden">{downloading ? "Preparing…" : "PDF"}</span>
                </button>
                <div className="relative">
                  <button type="button" aria-label="More" aria-expanded={more} onClick={() => setMore((x) => !x)} className={`grid h-11 w-11 place-items-center rounded-full border text-base transition-colors md:h-9 md:w-9 ${more ? "border-fg text-fg" : "border-line text-muted hover:border-faint hover:text-fg"}`}>
                    ⋯
                  </button>
                  {/* Kept mounted (hidden when closed), so the skip sheet it opens stays open */}
                  <div className={`absolute right-0 top-full z-30 mt-2 w-[min(340px,calc(100vw-2rem))] gap-1 rounded-[16px] border border-line bg-surface p-2 text-sm shadow-[0_24px_60px_-24px_rgba(0,0,0,0.7)] ${more ? "grid" : "hidden"}`}>
                    <a href={`/api/reports/${report.id}/pdf${joint ? "?whole=1" : ""}`} target="_blank" rel="noreferrer" className="flex min-h-11 items-center rounded-[10px] px-3 text-muted hover:bg-surface-2 hover:text-fg">
                      {joint ? "Open the whole report (PDF) ↗" : "Open the PDF in a new tab ↗"}
                    </a>
                    {!sent && !busy && (
                      <div className="flex min-h-11 items-center rounded-[10px] px-3 text-muted hover:bg-surface-2">
                        <SkipButton id={report.id} title={`${client.name} · ${report.periodLabel}`} variant="link" onDone="list" />
                      </div>
                    )}
                    {monthly && (
                      <div className="pt-1">
                        <RecapDeckButton reportId={report.id} />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* The tools, when asked for: metrics, campaigns, lines, and the client's CRM results */}
            {toolsOpen && doc && !busy && (
              <section className="grid gap-3 rounded-[16px] border border-line bg-surface p-3.5" aria-label="Edit the report">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[13px] font-medium">Edit the report</p>
                  <button type="button" onClick={() => closeParams("tools")} className="h-10 rounded-full px-3 text-[13px] text-muted hover:text-fg md:h-8">
                    Done
                  </button>
                </div>
                {doc.tools}
                {(report.status !== "failed" || report.manual) && (
                  <ManualResults reportId={report.id} entered={report.manual} period={{ start: report.period.start, end: report.period.end, label: report.metrics?.main.label ?? report.periodLabel }} locked={sent || mineDone} />
                )}
              </section>
            )}

            {busy || !doc ? (
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
              <PdfPreview
                source={`/api/reports/${report.id}/preview${joint ? "?whole=1" : ""}`}
                baseKey={`${report.status}:${JSON.stringify(report.metrics ?? null).length}:${report.manual?.at ?? ""}`}
                // A month's report is the document saved to Drive: the write-up ("Our notes") under it, all of it editable
                patch={(input) => ({ ...input, ...(monthly ? { withNotes: true } : {}), parts: input.parts.map((p) => (p.platform === report.platform ? { ...p, sections: sections ?? p.sections, extras, layout: doc.shownLayout } : p)) })}
                patchKey={JSON.stringify({ sections, extras, layout: doc.shownLayout, notes: monthly })}
                ownPlatform={report.platform}
                fields={doc.fields}
                editable={editable}
                onSave={(id, v) => doc.save(id, v)}
                onRemove={(id) => doc.save(id, null)}
                onAdd={doc.addBelow}
                onMove={doc.move}
                hotMenu={doc.hotMenu}
                onMaker={(make) => {
                  pdfMaker.current = make;
                }}
              />
            )}
            {editable && doc && (
              <p className="text-xs text-faint">
                {monthly ? "This is the PDF saved to the client's Drive, with your write-up on the last page. " : "This is the PDF the client gets. "}
                Click a metric to pick another, or any text to change it; saved as you go.
              </p>
            )}
            {monthly && !sent && (driveError || (driveSave && !savingDrive)) && <div className="grid gap-1">{driveStatus}</div>}
            {act && sections && !busy && report.platform !== "tiktok" && <NextStepsAct reportId={report.id} platform={report.platform} steps={[...sections.next, ...(sections.stories ?? []).map((st) => st.next)]} write={act.write} canSwitch={act.canSwitch} />}
          </div>
          {sidePanel(reviewPrimary)}
        </div>
      )}

      {/* ─── Step 2: the message, the hero, with the AI beside it ─── */}
      {step === "message" && (
        <div className={`grid items-start gap-5 ${minned ? "lg:pb-20" : "lg:grid-cols-[minmax(0,1fr)_400px]"}`}>
          <div className="grid min-w-0 gap-4">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div className="grid gap-0.5">
                <h2 className="font-heading text-[22px] leading-tight">The message</h2>
                <p className="text-[13px] text-muted">{monthly ? "What posts in their channel with the recap. The other parts join it in one post." : joint ? "One post for every service, from the Kaizen app, with the PDF." : "What posts in their channel with the PDF. Change anything before it goes."}</p>
              </div>
              {format === "slack" && (!built || message) && !syncing && (
                <button type="button" disabled={!editable && !(built && isBuilder)} onClick={() => setEditMsg((x) => !x)} className={`h-11 rounded-full px-4 text-[13px] disabled:opacity-40 md:h-10 ${editMsg ? "bg-fg text-bg" : "border border-brand/60 text-brand-text hover:bg-brand/10"}`}>
                  {editMsg ? "✓ Done editing" : "✎ Edit the message"}
                </button>
              )}
            </div>
            {formats.length > 1 && <div role="tablist" aria-label="Preview as" className={`grid gap-1 rounded-full border border-line bg-surface p-1 ${formats.length === 3 ? "grid-cols-3" : "grid-cols-2"}`}>
              {formats.map((f) => (
                <button key={f} type="button" role="tab" aria-selected={format === f} onClick={() => pushParams({ fmt: f })} className={`min-h-11 rounded-full px-3 text-[13px] transition-colors md:min-h-10 ${format === f ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
                  {f === "slack" ? "Slack message" : f === "email" ? "Email" : "PDF report"}
                </button>
              ))}
            </div>}
            {format === "email" ? (
              <EmailFrame reportId={report.id} to={(recipients.length ? recipients : monthly ? (delivery?.contacts ?? []) : []).map((r) => ({ email: r.email, name: r.name ?? null }))} note={monthly || built ? "" : emailNote} file={fileName} />
            ) : format === "pdf" ? (
              sections ? (
                <PdfPreview
                  source={`/api/reports/${report.id}/preview${joint ? "?whole=1" : ""}`}
                  baseKey={`${report.status}:${JSON.stringify(report.metrics ?? null).length}:${report.manual?.at ?? ""}`}
                  patch={(input) => ({ ...input, withNotes: true, parts: input.parts.map((p) => (p.platform === report.platform ? { ...p, sections: sections ?? p.sections, extras, layout: doc?.shownLayout ?? p.layout } : p)) })}
                  patchKey={JSON.stringify({ sections, extras, layout: doc?.shownLayout, notes: true })}
                  fields={[]}
                  editable={false}
                  onSave={() => {}}
                  onRemove={() => {}}
                  onMaker={(make) => {
                    pdfMaker.current = make;
                  }}
                />
              ) : null
            ) : !message && built ? (
              <p className="rounded-[12px] border border-line bg-surface px-4 py-10 text-center text-sm text-muted">{joint ? "Putting each buyer's message together into one…" : "Writing the message…"}</p>
            ) : syncing ? (
              <p className="flex items-center justify-center gap-2 rounded-[12px] border border-line bg-surface px-4 py-10 text-center text-sm text-muted">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" /> Updating the message to match your changes to the report…
              </p>
            ) : editMsg ? (
              <div className="grid gap-3">
                <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={14} autoFocus aria-label="The message" className="w-full rounded-[14px] border border-brand/50 bg-surface px-4 py-3 font-mono text-[13px] leading-relaxed outline-none [field-sizing:content] focus:border-brand-text/60" />
                {riders.map((x) => (
                  <label key={x.id} className="grid gap-1.5">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">{platformName(x.platform as "tiktok")}, under yours in the same post</span>
                    <textarea
                      value={riderMsgs[x.id] ?? ""}
                      onChange={(e) => setRiderMsgs({ ...riderMsgs, [x.id]: e.target.value })}
                      onBlur={(e) => e.target.value !== (x.message ?? "") && start(async () => void (await saveReport(x.id, { message: e.target.value })))}
                      rows={6}
                      className="w-full rounded-[14px] border border-line bg-surface px-4 py-3 font-mono text-[13px] leading-relaxed outline-none [field-sizing:content] focus:border-brand-text/60"
                    />
                  </label>
                ))}
                <p className="text-[11.5px] text-faint">*bold* · _italic_ · • bullets, as Slack shows them</p>
              </div>
            ) : (
              <button type="button" disabled={!editable && !(built && isBuilder)} onClick={() => setEditMsg(true)} className="block w-full cursor-text rounded-[12px] text-left ring-brand/40 transition-shadow hover:ring-2 disabled:cursor-default disabled:hover:ring-0" aria-label="Edit the message">
                <SlackPreview from={from} text={slackText} file={fileName} />
              </button>
            )}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-faint">
              <button type="button" onClick={() => setStep("report")} className="inline-flex min-h-11 items-center text-muted hover:text-fg md:min-h-0">
                ← Back to the report
              </button>
              {built && joint && !bundle?.messageApproved && (
                <button
                  type="button"
                  onClick={() =>
                    start(async () => {
                      const r = await builtMessage(bundle!.id, true);
                      if (r.ok) setMessage(r.message);
                    })
                  }
                  className="inline-flex min-h-11 items-center hover:text-fg md:min-h-0"
                >
                  Put it together again from the parts
                </button>
              )}
            </div>
          </div>
          {sidePanel(messagePrimary)}
        </div>
      )}

      {/* ─── Step 3: how it goes out ─── */}
      {step === "send" && (
        <div className="mx-auto grid w-full max-w-3xl gap-5">
          <div className="grid gap-1">
            <h2 className="font-heading text-[24px] leading-tight">How it goes out</h2>
            <p className="text-[13px] text-muted">
              {client.name} · {report.periodLabel}. {monthly ? "Saved to their Drive." : "Pick one way to send it."}
            </p>
          </div>

          {/* A month's recap is saved to the client's Drive; customer success sends the month to the client */}
          {monthly && !sent && (
            <p className="rounded-[14px] bg-surface-2 px-4 py-3 text-[12.5px] leading-relaxed text-muted">
              The monthly recap is saved to the client&apos;s Drive with your write-up. Customer success sends the month to the client, with every team&apos;s report, once they&apos;re all in.
            </p>
          )}
          {false && monthly && othersOpen.length > 0 && !sent && (
            <div className="grid gap-1 rounded-[16px] border border-line bg-surface-2/60 px-4 py-3">
              <p className="text-sm font-medium">{mineDone ? "Approved. It goes out with the rest." : "The recap goes out once every buyer approves"}</p>
              <p className="text-[12.5px] leading-relaxed text-muted">
                Waiting on {othersLabel}. {mineDone ? "Or send yours now: their part follows on its own when they approve it." : "Approve yours now and it goes the moment they approve theirs, or send yours on its own."}
              </p>
            </div>
          )}
          {built && waitingParts.length > 0 && !bundle?.messageApproved && (
            <p className="rounded-[14px] bg-surface-2 px-4 py-3 text-[12.5px] text-muted">
              Waiting on {waitingParts.map((p) => `${p.owner ?? "the other buyer"} (${shortName(p.platform)})`).join(" and ")}. Approve the message now and it goes out the moment they approve theirs.
            </p>
          )}
          {built && bundle?.messageApproved && !sent && <p className="rounded-[14px] bg-ok-soft px-4 py-3 text-sm text-ok">✓ Approved. It goes out as soon as every part is in.</p>}
          {jn && !rider && <JointBanner note={jn} compact />}

          <div role="radiogroup" aria-label="How it goes out" className={`grid gap-3 ${offers.length === 3 ? "md:grid-cols-3" : "sm:grid-cols-2"}`}>
            <OptionCard option="slack" title="Send in Slack" detail={optionDetail.slack} on={viaSlack && routeOpen} last={lastUsed.includes("slack")} disabled={channelsLocked || !client.hasChannel} onPick={() => setChoice("slack")} />
            <OptionCard option="email" title="Send by email" detail={optionDetail.email} on={viaEmail && routeOpen} last={lastUsed.includes("email")} disabled={channelsLocked} onPick={() => setChoice("email")} />
            {offers.includes("drive") && (
              <OptionCard option="drive" title="Save to Google Drive" detail={optionDetail.drive} on={toDrive} last={lastUsed.includes("drive")} disabled={savingDrive || pending} onPick={() => setChoice("drive")}>
                {(driveSave || driveError) && <div className="pl-14">{driveStatus}</div>}
              </OptionCard>
            )}
          </div>

          {/* Email: who it goes to, a line from the buyer, and the email as they'll get it */}
          {viaEmail && routeOpen && (
            <section className="grid gap-3 rounded-[18px] border border-line bg-surface p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Email to</p>
              <DeliveryPicker channels={false} value={route} onChange={(d) => setRecipients(d.recipients)} options={delivery ?? { contacts: [], initial: route, slackChannel: client.hasChannel, emailReady: true }} disabled={channelsLocked} />
              {!monthly && !built && (
                <label className="grid gap-1.5">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">A line for the email (optional)</span>
                  <textarea value={emailNote} onChange={(e) => setEmailNote(e.target.value)} rows={2} maxLength={600} placeholder="e.g. Happy to walk through it on Thursday's call." className="resize-none rounded-[12px] border border-line bg-bg px-3 py-2 text-sm outline-none [field-sizing:content] focus:border-brand-text/60" />
                </label>
              )}
            </section>
          )}
          {viaSlack && canSend && !joint && !monthly && !slack.connected && (
            <div className="grid gap-2 rounded-[14px] border border-warn/40 bg-warn-soft/40 px-4 py-3">
              <p className="text-xs text-warn">Connect your Slack so it goes out as you, with your name and photo.</p>
              <SlackConnect connected={false} />
            </div>
          )}

          {/* The one button, and what's in the way of it */}
          <div className="grid gap-2">
            {sendProblem && <p className="text-[12.5px] text-warn">{sendProblem}</p>}
            {qaWarning}
            {sendLabel ? (
              <button type="button" disabled={pending || savingDrive || Boolean(sendProblem)} onClick={go} className={`${primaryClass} md:h-[52px] md:text-[15px]`}>
                {pending || savingDrive ? (sendNow ? "Sending…" : "Saving to Drive…") : sendLabel}
              </button>
            ) : canSend ? (
              <p className="text-[12.5px] text-muted">Pick how it goes out.</p>
            ) : null}
            {false && monthly && othersOpen.length > 0 && !sent && (
              <button type="button" disabled={pending || route.channels.length === 0 || stale || ridersWriting || (viaEmail && !route.recipients.length) || (viaSlack && !client.hasChannel)} onClick={partNow} className="inline-flex h-12 w-full items-center justify-center rounded-brand border border-line px-4 text-sm text-fg transition-colors hover:border-faint disabled:opacity-50">
                Send my part now, {channelsPhrase(route.channels)}
              </button>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <button type="button" onClick={() => setStep("message")} className="inline-flex min-h-11 items-center text-muted hover:text-fg">
                ← Back to the message
              </button>
              {approvedNote}
            </div>
          </div>
        </div>
      )}

      {step === "done" && (
        <div className="grid gap-5">
          <div className="relative isolate grid place-items-center gap-3 overflow-hidden rounded-[20px] border border-line bg-surface px-6 py-12 text-center">
            <span aria-hidden className="pointer-events-none absolute -top-24 left-1/2 -z-10 h-48 w-80 -translate-x-1/2 rounded-full bg-[rgba(52,195,143,0.18)] blur-[70px]" />
            <span className="grid h-12 w-12 place-items-center rounded-full bg-ok-soft text-xl text-ok">✓</span>
            <p className="font-heading text-xl">{monthly ? `Saved to ${client.name}'s Drive` : `Sent to ${client.name}`}</p>
            <p className="max-w-md text-sm text-muted">
              {monthly
                ? `${report.periodLabel}, with the write-up on the last page. Customer success sends the month to the client, with every team's report, once they're all in.`
                : (sentNote ?? (history[0] ? `${report.periodLabel}, by ${channelsLabel(history[0].channels).toLowerCase()}${history[0].to.length ? ` to ${history[0].to.join(", ")}` : ""}.` : `${report.periodLabel}, with the PDF.`))}
            </p>
            {(savingDrive || driveSave || driveError) && <div className="grid place-items-center">{savingDrive ? <p className="text-[12px] text-muted">Saving to Drive…</p> : driveStatus}</div>}
            {offers.includes("drive") && !savingDrive && (
              <button type="button" onClick={() => void saveDrive()} className="inline-flex min-h-11 items-center gap-2 rounded-full border border-line px-4 text-sm text-fg transition-colors hover:border-faint">
                {ICONS.drive}
                {driveSave ? "Save a new version to Drive" : "Save to Google Drive"}
              </button>
            )}
            <a href={history[0] ? `/api/reports/sends/${history[0].id}/pdf` : `/api/reports/${report.id}/pdf${joint ? "?whole=1" : ""}`} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center text-sm text-muted underline-offset-4 hover:text-fg hover:underline">
              {monthly ? "Open the PDF ↗" : "Open the PDF that went ↗"}
            </a>
          </div>
          {/* Every time it went, to review, send again or carry on next week (a month's report only goes to Drive) */}
          {(!monthly || history.length > 0) && (
          <section className="grid gap-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-heading text-[19px]">Sent</h3>
              <Link href="/reports?view=sent" className="inline-flex min-h-11 items-center text-xs text-faint hover:text-fg md:min-h-0">
                Every report sent →
              </Link>
            </div>
            <SendHistory items={history} showClient={false} empty={<p className="rounded-[14px] border border-line bg-surface px-4 py-6 text-center text-sm text-muted">It went out before sends were kept here. Open the PDF above to review it.</p>} />
          </section>
          )}
          {report.metrics && sections && (
            <section className="grid gap-3">
              <h3 className="font-heading text-[19px]">The report</h3>
              <PdfPreview source={`/api/reports/${report.id}/preview${joint ? "?whole=1" : ""}`} baseKey={`sent:${report.id}`} patch={(input) => (monthly ? { ...input, withNotes: true } : input)} patchKey={monthly ? "sent:notes" : "sent"} fields={[]} editable={false} onSave={() => {}} onRemove={() => {}} />
            </section>
          )}
        </div>
      )}
    </div>
  );
}
