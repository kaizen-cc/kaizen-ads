"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { SlackConnect } from "@/components/slack-connect";
import { pushParams, useParam } from "@/lib/url-state";
import { headlineTiles, kpiRows, money, platformName, type Delta } from "@/lib/reports/format";
import type { ReportMetrics } from "@/lib/reports/metrics";
import type { ChatTurn, Qa, Sections } from "@/lib/reports/write";
import { approveBuiltMessage, approveMyPart, builtMessage, checkAgain, redraft, reviseWithAi, saveReport, sendReport, skipReport } from "./actions";

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
  sections: Sections | null;
  metrics: ReportMetrics | null;
  extraMetrics: ReportMetrics[] | null;
  extras: string;
  qa: Qa | null;
  chat: ChatTurn[];
  error: string | null;
  owner: string | null;
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

const tone = (d: Delta | null) => (!d ? "text-[#9a9aa1]" : d.tone === "good" ? "text-[#16794c]" : d.tone === "bad" ? "text-[#c8102e]" : "text-[#5f5f66]");
const PART_STATUS: Record<string, string> = { queued: "Queued", drafting: "Writing", draft: "To review", submitted: "Approved", posted: "Sent", failed: "Couldn't write", skipped: "Left out" };
const SUGGEST = ["Make it shorter", "Explain why results moved", "More on what's next", "Warmer tone"];

/** A line of the document that turns into a text box on click. */
function Editable({ value, onSave, className = "", placeholder, disabled, multiline = true }: { value: string; onSave: (v: string) => void; className?: string; placeholder?: string; disabled?: boolean; multiline?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!editing || !box.current) return;
    box.current.focus();
    box.current.style.height = "auto";
    box.current.style.height = `${box.current.scrollHeight}px`;
  }, [editing]);
  if (editing)
    return (
      <textarea
        ref={box}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          e.target.style.height = "auto";
          e.target.style.height = `${e.target.scrollHeight}px`;
        }}
        onBlur={() => {
          setEditing(false);
          if (draft.trim() !== value.trim()) onSave(draft.trim());
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setDraft(value);
            setEditing(false);
          }
          if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            (e.target as HTMLTextAreaElement).blur();
          }
        }}
        rows={1}
        className={`w-full resize-none rounded-[6px] bg-[#fff8e6] px-1.5 py-0.5 outline outline-2 outline-[#f2b14c] ${className}`}
      />
    );
  return (
    <span
      role={disabled ? undefined : "button"}
      tabIndex={disabled ? undefined : 0}
      onClick={() => !disabled && (setDraft(value), setEditing(true))}
      onKeyDown={(e) => !disabled && e.key === "Enter" && (setDraft(value), setEditing(true))}
      className={`block rounded-[6px] ${disabled ? "" : "-mx-1.5 cursor-text px-1.5 transition-colors hover:bg-[#fff8e6] hover:outline hover:outline-1 hover:outline-[#f2b14c]/60"} ${className} ${!value ? "text-[#9a9aa1]" : ""}`}
      title={disabled ? undefined : "Click to change"}
    >
      {value || placeholder}
    </span>
  );
}

/** The report as the client will read it (light, like the PDF), every line editable in place. */
function Document({ r, sections, setSections, extras, setExtras, client, editable }: { r: StudioReport; sections: Sections; setSections: (s: Sections) => void; extras: string; setExtras: (s: string) => void; client: string; editable: boolean }) {
  const m = r.metrics;
  const list = (key: "did" | "doing" | "next", title: string) => (
    <div className="grid gap-2">
      <p className="text-[13px] font-semibold text-[#0b0b0c]">{title}</p>
      <ul className="grid gap-1.5">
        {sections[key].map((x, i) => (
          <li key={`${key}-${i}`} className="group flex gap-2 text-[13.5px] leading-relaxed text-[#2a2a30]">
            <span className="mt-[1px] font-bold text-[#c8102e]">•</span>
            <span className="min-w-0 flex-1">
              <Editable value={x} disabled={!editable} onSave={(v) => setSections({ ...sections, [key]: v ? sections[key].map((y, j) => (j === i ? v : y)) : sections[key].filter((_, j) => j !== i) })} />
            </span>
            {editable && (
              <button type="button" onClick={() => setSections({ ...sections, [key]: sections[key].filter((_, j) => j !== i) })} aria-label="Remove this line" className="h-6 w-6 shrink-0 rounded-full text-[#9a9aa1] opacity-0 hover:bg-[#f3f3f2] hover:text-[#0b0b0c] group-hover:opacity-100 max-md:opacity-100">
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      {editable && (
        <button type="button" onClick={() => setSections({ ...sections, [key]: [...sections[key], "New point"] })} className="justify-self-start rounded-full px-2 py-1 text-[12px] text-[#9a9aa1] hover:bg-[#f3f3f2] hover:text-[#0b0b0c]">
          + Add a line
        </button>
      )}
    </div>
  );
  return (
    <article className="overflow-hidden rounded-[14px] bg-fg text-[#0b0b0c] shadow-[0_30px_80px_-30px_rgba(0,0,0,0.7)]">
      <header className="bg-deep px-7 pb-6 pt-7 text-fg max-md:px-5">
        <span className="mb-3 block h-[3px] w-7 bg-[#c8102e]" />
        <p className="font-heading text-[22px] leading-tight">{client}</p>
        <p className="mt-1 text-[13px] text-[#b4b4bb]">
          {platformName(r.platform)} · {r.periodLabel}
        </p>
      </header>
      <div className="grid gap-6 px-7 py-7 max-md:px-5">
        <div className="grid gap-2">
          <Editable value={sections.headline} disabled={!editable} multiline={false} onSave={(v) => setSections({ ...sections, headline: v })} className="font-heading text-[19px] leading-snug" placeholder="The main takeaway" />
          <Editable value={sections.summary} disabled={!editable} onSave={(v) => setSections({ ...sections, summary: v })} className="text-[14px] leading-relaxed text-[#3a3a40]" placeholder="The numbers in context" />
        </div>
        {m && (
          <div className="grid gap-4">
            {[m, ...(r.extraMetrics ?? [])].map((x) => (
              <div key={x.main.label} className="grid gap-2">
                <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[#6b6b73]">
                  {x.main.label} vs {x.compare.label}
                </p>
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                  {headlineTiles(x).map((t) => (
                    <div key={t.label} className="grid gap-0.5 rounded-[8px] border border-[#e7e7ea] px-3 py-2.5">
                      <span className="text-[10px] uppercase tracking-[0.08em] text-[#6b6b73]">{t.label}</span>
                      <span className="tabular font-heading text-[19px] leading-tight">{t.value}</span>
                      {t.sub && <span className="text-[11px] text-[#6b6b73]">{t.sub}</span>}
                      <span className={`text-[11px] font-semibold ${tone(t.delta)}`}>{t.delta?.text ?? "No comparison"}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <details className="group">
              <summary className="cursor-pointer list-none text-[12px] text-[#6b6b73] hover:text-[#0b0b0c]">
                <span className="group-open:hidden">Key metrics and campaigns ▾</span>
                <span className="hidden group-open:inline">Hide ▴</span>
              </summary>
              <table className="mt-3 w-full text-[12.5px]">
                <tbody>
                  {kpiRows(m).map((row) => (
                    <tr key={row.label} className="border-t border-[#e7e7ea]">
                      <td className="py-1.5 font-semibold">{row.label}</td>
                      <td className="py-1.5 text-right tabular">{row.now}</td>
                      <td className="py-1.5 text-right tabular text-[#6b6b73]">{row.before}</td>
                      <td className={`py-1.5 text-right font-semibold tabular ${tone(row.delta)}`}>{row.delta?.text ?? "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <ul className="mt-3 grid gap-1 text-[12px] text-[#3a3a40]">
                {m.campaigns.slice(0, 6).map((c) => (
                  <li key={c.name} className="flex justify-between gap-3">
                    <span className="truncate">{c.name}</span>
                    <span className="shrink-0 tabular text-[#6b6b73]">
                      {money(c.spend)} · {c.results} · {money(c.costPerResult)}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}
        {list("did", "What we did")}
        {list("doing", "What we're doing")}
        {list("next", "What's next")}
        <div className="grid gap-1.5 border-l-2 border-[#c8102e] pl-3">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[#6b6b73]">Also (sales from their CRM, other channels…)</p>
          <Editable value={extras} disabled={!editable} onSave={setExtras} className="text-[13.5px] leading-relaxed text-[#3a3a40]" placeholder={editable ? "Add anything the numbers don't show" : ""} />
        </div>
        {r.owner && <p className="text-[12px] text-[#6b6b73]">Prepared by {r.owner}, Kaizen Marketing</p>}
      </div>
    </article>
  );
}

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

export function ReportStudio({
  report,
  client,
  bundle,
  slack,
}: {
  report: StudioReport;
  client: { name: string; slug: string; hasChannel: boolean };
  bundle: StudioBundle | null;
  slack: { connected: boolean; name: string | null; image: string | null; me: string };
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
  const initial: "report" | "message" | "done" = sent ? "done" : built && mineDone && bundle?.isBuilder ? "message" : "report";
  // The step is in the address (?step=), so back from the Slack message returns to the report. Once it's sent, it's
  // sent: every entry shows that.
  const [sentHere, setSentHere] = useState(false);
  const asked = useParam("step");
  const step: "report" | "message" | "done" = sent || sentHere ? "done" : asked === "report" || asked === "message" ? asked : initial;
  const setStep = (to: "report" | "message" | "done") => (to === "done" ? setSentHere(true) : pushParams({ step: to === initial ? null : to }));
  const chatEnd = useRef<HTMLDivElement>(null);

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
  }, [chat, asking]);
  // The message step of a built report: the combined (or single) message, written from the approved parts
  useEffect(() => {
    if (step !== "message" || !built || !bundle || message) return;
    let live = true;
    void builtMessage(bundle.id).then((r) => live && r.ok && setMessage(r.message));
    return () => {
      live = false;
    };
  }, [step, built, bundle, message]);

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
    if (!r.ok) return setNote({ ok: false, text: r.error });
    setChat(r.chat);
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

  const send = () =>
    start(async () => {
      setNote(null);
      if (built && bundle) {
        const r = await approveBuiltMessage(bundle.id, message);
        if (!r.ok) return setNote({ ok: false, text: r.error });
        if (r.sent) setStep("done");
        else setNote({ ok: true, text: `Approved. It goes out the moment ${r.waitingOn.join(" and ")} approve${r.waitingOn.length === 1 ? "s" : ""} their part: one message, one PDF.` });
        router.refresh();
        return;
      }
      await saveReport(report.id, { message });
      const r = await sendReport(report.id);
      if (!r.ok) return setNote({ ok: false, text: r.error });
      setStep("done");
      router.refresh();
    });

  const from = joint ? { name: "Kaizen", image: null, app: true } : { name: slack.name || slack.me, image: slack.image, app: false };
  const fileName = `${client.name} - ${built ? "Report" : `${platformName(report.platform).replace(" Ads", "")} report`} - ${report.periodLabel}.pdf`;
  const waitingParts = bundle?.parts.filter((p) => p.status !== "submitted" && p.status !== "posted") ?? [];
  const STEPS = [
    { key: "report", label: built && joint ? "Your part" : "Report" },
    ...(report.kind === "monthly" || (built && !bundle?.isBuilder) ? [] : [{ key: "message", label: "Slack message" }]),
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
        {bundle && bundle.parts.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            {bundle.parts.map((p) => (
              <a
                key={p.id}
                href={`/reports/${p.id}`}
                className={`flex h-8 items-center gap-2 rounded-full border px-3 text-xs ${p.isMe ? "border-fg/40" : "border-line"} ${p.status === "submitted" || p.status === "posted" ? "text-ok" : "text-muted"}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${p.status === "submitted" || p.status === "posted" ? "bg-ok" : p.status === "drafting" ? "animate-pulse bg-faint" : "bg-warn"}`} />
                {platformName(p.platform as "meta" | "google").replace(" Ads", "")} · {p.isMe ? "you" : (p.owner ?? "buyer")} · {PART_STATUS[p.status] ?? p.status}
              </a>
            ))}
          </div>
        )}
      </div>

      {note && <p className={`rounded-[12px] px-4 py-3 text-sm ${note.ok ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad"}`}>{note.text}</p>}

      {step === "report" && (
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="grid min-w-0 gap-3">
            {busy || !sections ? (
              <div className="grid place-items-center gap-3 rounded-[14px] border border-line bg-surface px-6 py-20 text-center">
                {report.status === "failed" ? (
                  <>
                    <p className="font-heading text-lg">The AI couldn&apos;t write it</p>
                    <p className="max-w-md text-sm text-muted">{report.error ?? "Try again."}</p>
                    <button type="button" onClick={() => start(async () => void (await redraft(report.id), router.refresh()))} className="h-10 rounded-brand bg-fg px-4 text-sm text-bg">
                      Write it again
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
              <Document r={report} sections={sections} setSections={setSections} extras={extras} setExtras={setExtras} client={client.name} editable={editable} />
            )}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-faint">
              {editable && <span>Click any line to change it. Changes save as you go.</span>}
              <a href={`/api/reports/${report.id}/pdf${joint ? "?whole=1" : ""}`} target="_blank" rel="noreferrer" className="hover:text-fg">
                {joint ? "Preview the whole report (PDF) ↗" : "Preview the PDF ↗"}
              </a>
              {!sent && (
                <button type="button" onClick={() => start(async () => void (await redraft(report.id), router.refresh()))} className="hover:text-fg">
                  Write it again from scratch
                </button>
              )}
              {!sent && !built && report.kind !== "monthly" && (
                <button type="button" onClick={() => start(async () => void (await skipReport(report.id), router.push("/reports")))} className="hover:text-fg">
                  Skip this one
                </button>
              )}
            </div>
          </div>

          {/* The side: ask the AI for a change (the document updates), or the QA's checks */}
          <aside className="grid gap-3 rounded-[16px] border border-line bg-surface p-4 lg:sticky lg:top-20">
            <div className="flex gap-1 rounded-full bg-surface-2 p-1 text-sm">
              {(["ai", "checks"] as const).map((k) => (
                <button key={k} type="button" onClick={() => setRail(k)} className={`h-9 flex-1 rounded-full transition-colors ${rail === k ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
                  {k === "ai" ? "Ask the AI" : `Checks${qa?.flags.length ? ` · ${qa.flags.length}` : ""}`}
                </button>
              ))}
            </div>
            {rail === "ai" ? (
              <div className="grid gap-3">
                <div className="grid max-h-[46vh] content-start gap-2 overflow-y-auto">
                  {!chat.length && <p className="text-xs leading-relaxed text-faint">Say what to change and watch the report update. What this client always wants (&ldquo;they care about lead quality&rdquo;) is remembered for next time.</p>}
                  {chat.map((t, i) => (
                    <p key={i} className={`max-w-[92%] whitespace-pre-wrap rounded-[12px] px-3 py-2 text-[13px] leading-relaxed ${t.role === "user" ? "justify-self-end bg-fg text-bg" : "bg-surface-2 text-fg"}`}>
                      {t.text}
                    </p>
                  ))}
                  {asking && <p className="flex items-center gap-2 text-xs text-faint"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" /> Changing it…</p>}
                  <div ref={chatEnd} />
                </div>
                {editable && (
                  <>
                    <div className="flex flex-wrap gap-1.5">
                      {SUGGEST.map((s) => (
                        <button key={s} type="button" onClick={() => tweak(s)} disabled={asking} className="rounded-full border border-line px-2.5 py-1 text-[11.5px] text-muted hover:text-fg disabled:opacity-40 max-md:min-h-9">
                          {s}
                        </button>
                      ))}
                    </div>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void tweak(ask);
                      }}
                      className="flex gap-2"
                    >
                      <input value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="e.g. add the lead quality from the CRM" className="h-10 min-w-0 flex-1 rounded-brand border border-line bg-bg px-3 text-sm outline-none focus:border-brand-text/60 max-md:h-11" />
                      <button type="submit" disabled={!ask.trim() || asking} className="h-10 shrink-0 rounded-brand bg-fg px-3.5 text-sm text-bg disabled:opacity-40 max-md:h-11">
                        Change
                      </button>
                    </form>
                  </>
                )}
              </div>
            ) : (
              <div className="grid gap-2">
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
            )}
            {!sent && sections && !busy && (
              <div className="grid gap-2 border-t border-line pt-3">
                {mineDone ? (
                  <p className="text-sm text-ok">
                    ✓ Your part is approved.{" "}
                    {bundle?.isBuilder ? (
                      <button type="button" onClick={() => setStep("message")} className="underline">
                        On to the message →
                      </button>
                    ) : (
                      `${bundle?.builder ?? "Whoever built it"} sends it as one report.`
                    )}
                  </p>
                ) : (
                  <button type="button" disabled={pending} onClick={approve} className="h-11 rounded-brand bg-brand px-4 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-50 max-md:h-12">
                    {pending ? "One moment…" : report.kind === "monthly" ? "Approve and submit my part" : built ? (bundle?.isBuilder ? "Approve report →" : "Approve my part") : "Approve report →"}
                  </button>
                )}
                {qa?.verdict === "fix" && !mineDone && <p className="text-[11.5px] text-bad">The QA found something to fix: worth a look in Checks first.</p>}
              </div>
            )}
          </aside>
        </div>
      )}

      {step === "message" && (
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="grid min-w-0 gap-3">
            {!message && built ? (
              <p className="rounded-[12px] border border-line bg-surface px-4 py-10 text-center text-sm text-muted">{joint ? "Putting each buyer's message together into one…" : "Writing the message…"}</p>
            ) : editMsg ? (
              <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={16} className="w-full rounded-[12px] border border-line bg-surface px-4 py-3 font-mono text-[13px] leading-relaxed outline-none focus:border-brand-text/60" />
            ) : (
              <SlackPreview from={from} text={message} file={fileName} />
            )}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-faint">
              <button type="button" onClick={() => setEditMsg((x) => !x)} className="hover:text-fg">
                {editMsg ? "See how it looks" : "Edit the message"}
              </button>
              {built && joint && !bundle?.messageApproved && (
                <button type="button" onClick={() => start(async () => { const r = await builtMessage(bundle!.id, true); if (r.ok) setMessage(r.message); })} className="hover:text-fg">
                  Put it together again from the parts
                </button>
              )}
              <span>*bold* · _italic_ · • bullets, as Slack shows them</span>
            </div>
          </div>
          <aside className="grid gap-3 rounded-[16px] border border-line bg-surface p-4 lg:sticky lg:top-20">
            <p className="text-sm font-medium">{joint ? "One report, from Kaizen" : "From you, in their channel"}</p>
            <p className="text-xs leading-relaxed text-muted">
              {joint
                ? "Every service in one message and one PDF (the whole account first, then each service), posted by the Kaizen app so the client gets a single report."
                : "Posted in the client's channel as you, with the PDF attached."}
            </p>
            {!client.hasChannel && <p className="rounded-[10px] bg-warn-soft px-3 py-2 text-xs text-warn">This client has no Slack channel linked. Add it on the client page first.</p>}
            {!joint && !slack.connected && (
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
                disabled={pending || !message.trim() || !client.hasChannel || (!joint && !slack.connected)}
                onClick={send}
                className="h-11 rounded-brand bg-brand px-4 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-40 max-md:h-12"
              >
                {pending ? "Sending…" : built && waitingParts.length ? "Approve the message" : "Approve and send"}
              </button>
            )}
          </aside>
        </div>
      )}

      {step === "done" && (
        <div className="grid place-items-center gap-3 rounded-[16px] border border-line bg-surface px-6 py-16 text-center">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-ok-soft text-xl text-ok">✓</span>
          <p className="font-heading text-xl">Sent to {client.name}</p>
          <p className="max-w-md text-sm text-muted">{joint ? "One message and one PDF covering every service, in their Slack channel." : "In their Slack channel, with the PDF."}</p>
          <a href={`/api/reports/${report.id}/pdf${joint ? "?whole=1" : ""}`} target="_blank" rel="noreferrer" className="text-sm text-muted underline-offset-4 hover:text-fg hover:underline">
            Open the PDF ↗
          </a>
        </div>
      )}
    </div>
  );
}
