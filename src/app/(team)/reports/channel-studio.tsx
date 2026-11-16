"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "@/components/toasts";
import { pushParams, useParam } from "@/lib/url-state";
import { channelsPhrase, deliveryProblem, type Delivery } from "@/lib/reports/delivery-core";
import { openWithHere } from "@/lib/reports/slack-text";
import type { ChatTurn, Qa, Sections } from "@/lib/reports/write";
import { channelNoteText, keyLines, type EmailMetrics, type SocialMetrics } from "@/lib/channel-reports/core";
import { saveReport } from "./actions";
import { checkChannel, keepChannelTextAsIs, refreshChannelMessageNow, reviseChannel, sendChannel, updateChannelTextNow } from "./channel-actions";
import { DeliveryPicker, type DeliveryOptions } from "./delivery-picker";
import { RegenerateButton, UndoRegenerate } from "./regenerate-button";
import { SendHistory, type HistoryItem } from "./send-history";
import { SkipButton, SkipHistory, SkippedBanner } from "./skip-report";
import type { LogEntry } from "@/lib/reports/skip-log";

// One email or social report, start to finish, in three steps and then sent: review the report (the PDF the client gets, with
// the AI beside it), the message that carries it (Slack), then how it goes out (Slack, email or both). Each step is in the
// address (?step=), so back returns to the one before. Edits save as they are made.

export type ChannelStudioReport = {
  id: string;
  kind: "weekly" | "monthly";
  platform: "klaviyo" | "social";
  status: string;
  periodLabel: string;
  message: string;
  sections: Sections | null;
  metrics: EmailMetrics | SocialMetrics | null;
  extras: string;
  qa: Qa | null;
  chat: ChatTurn[];
  error: string | null;
  owner: string | null;
  stale: string[];
  regen: { at: string; by: string | null } | null;
  skip: { log: LogEntry[]; canBringBack: boolean };
  shareUrl: string | null;
};

type Step = "report" | "message" | "send";
const STEPS: { key: Step; label: string }[] = [
  { key: "report", label: "Report" },
  { key: "message", label: "Message" },
  { key: "send", label: "Send" },
];
const SUGGEST = ["Make it shorter", "Explain why it moved", "More on what's next", "Warmer tone"];

const inputCls = "w-full rounded-[12px] border border-line bg-surface px-3.5 py-2.5 text-[15px] text-fg placeholder:text-faint focus:border-faint focus:outline-none";
const btn = "inline-flex h-11 items-center justify-center gap-2 rounded-full px-5 text-sm font-medium transition-opacity disabled:opacity-50 md:h-10";

/** A list the owner edits one point to a line */
const lines = (xs: string[]) => xs.join("\n");
const split = (t: string) => t.split("\n").map((x) => x.trim()).filter(Boolean);

function Slack({ text, from, file }: { from: string; text: string; file: string }) {
  return (
    <div className="grid gap-2 rounded-[14px] border border-line bg-surface-2 p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">As it looks in the client&apos;s Slack</p>
      <p className="text-sm font-semibold">{from}</p>
      <div className="grid gap-1 text-[15px] leading-[1.5]">
        {openWithHere(text)
          .replace(/<!here>/g, "@here")
          .replace(/\*([^*\n]+)\*/g, "$1")
          .split("\n")
          .map((l, i) => (l.trim() ? <p key={i}>{l}</p> : <p key={i} className="h-2" />))}
      </div>
      <span className="inline-flex w-fit items-center gap-2 rounded-[10px] border border-line px-3 py-2 text-xs text-muted">PDF · {file}</span>
    </div>
  );
}

export function ChannelStudio({
  report,
  delivery,
  history,
  client,
  slack,
}: {
  report: ChannelStudioReport;
  delivery: DeliveryOptions | null;
  history: (HistoryItem & { clientId?: string })[];
  client: { name: string; hasChannel: boolean; whiteLabel: boolean };
  slack: { connected: boolean; name: string | null; image: string | null; me: string };
}) {
  const router = useRouter();
  const [pending, go] = useTransition();
  const sent = report.status === "posted";
  const skipped = report.status === "skipped";
  const working = report.status === "queued" || report.status === "drafting";
  const asked = useParam("step");
  const step: Step = STEPS.some((s) => s.key === asked) ? (asked as Step) : "report";
  const [sections, setSections] = useState<Sections | null>(report.sections);
  const [message, setMessage] = useState(report.message);
  const [chat, setChat] = useState<ChatTurn[]>(report.chat);
  const [qa, setQa] = useState<Qa | null>(report.qa);
  const [rail, setRail] = useState<"ai" | "checks" | "edit">("ai");
  const [ask, setAsk] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [bust, setBust] = useState(0);
  const [note, setNote] = useState("");
  const [route, setRoute] = useState<Delivery>(delivery?.initial ?? { channels: client.hasChannel ? ["slack"] : ["email"], recipients: [] });
  const saving = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A report still being written is followed until it's done
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => router.refresh(), 6000);
    return () => clearInterval(t);
  }, [working, router]);
  // What the server says is new (a redraw, a refreshed text) replaces what is on screen
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setSections(report.sections);
    setMessage(report.message);
    setChat(report.chat);
    setQa(report.qa);
    setBust((b) => b + 1);
  }, [report.sections, report.message, report.chat, report.qa]);

  const m = report.metrics;
  const flags = qa?.flags ?? [];
  const noteOn = m?.refreshNote;

  const keep = (patch: { message?: string; sections?: Sections }) => {
    if (saving.current) clearTimeout(saving.current);
    saving.current = setTimeout(async () => {
      const r = await saveReport(report.id, patch);
      if (!r.ok) toast({ tone: "bad", title: "Couldn't save", body: r.error });
      else if (patch.sections) setBust((b) => b + 1);
    }, 400);
  };
  const setSection = (next: Sections) => {
    setSections(next);
    keep({ sections: next });
  };

  const revise = (text: string) =>
    go(async () => {
      if (!text.trim()) return;
      setBusy("Changing it…");
      setChat((c) => [...c, { role: "user", text: text.trim(), at: new Date().toISOString(), by: slack.me }]);
      setAsk("");
      const r = await reviseChannel(report.id, text);
      setBusy(null);
      if (!r.ok) {
        toast({ tone: "bad", title: "Couldn't change it", body: r.error });
        return;
      }
      setChat(r.chat);
      setMessage(r.message);
      setSections(r.sections);
      setQa(r.qa);
      setBust((b) => b + 1);
      router.refresh();
    });

  const checkAgain = () =>
    go(async () => {
      setBusy("Checking…");
      const r = await checkChannel(report.id);
      setBusy(null);
      if (!r.ok) return toast({ tone: "bad", title: "Couldn't check it", body: r.error });
      setQa(r.qa);
    });

  const bringMessage = () =>
    go(async () => {
      setBusy("Updating the message…");
      const r = await refreshChannelMessageNow(report.id);
      setBusy(null);
      if (!r.ok) return toast({ tone: "bad", title: "Couldn't update it", body: r.error });
      setMessage(r.message);
      toast({ tone: "ok", title: "The message follows the report" });
    });

  const updateText = () =>
    go(async () => {
      setBusy("Updating the text…");
      const r = await updateChannelTextNow(report.id);
      setBusy(null);
      if (!r.ok) return toast({ tone: "bad", title: "Couldn't update it", body: r.error });
      router.refresh();
    });

  const problem = deliveryProblem(route, { slackChannel: client.hasChannel, slackConnected: slack.connected, emailReady: delivery?.emailReady ?? true });
  const send = () =>
    go(async () => {
      if (problem) return toast({ tone: "bad", title: "Not yet", body: problem });
      setBusy("Sending…");
      const r = await sendChannel(report.id, route, note);
      setBusy(null);
      if (!r.ok) return toast({ tone: "bad", title: "It didn't go out", body: r.error });
      toast({ tone: "ok", title: "Sent", body: r.note });
      router.refresh();
    });

  if (working)
    return (
      <div className="grid place-items-center gap-3 rounded-[22px] border border-dashed border-line px-6 py-16 text-center">
        <span className="h-3 w-3 animate-pulse rounded-full bg-faint" />
        <p className="font-heading text-lg">Writing the report…</p>
        <p className="max-w-md text-sm text-muted">The numbers are in; the write-up and its check take a minute. This page follows it.</p>
      </div>
    );

  const pdfUrl = `/api/reports/${report.id}/pdf`;
  const title = `${client.name} ${report.periodLabel}`;

  return (
    <div className="grid gap-5">
      {/* Where it stands, and the things to do with a draft */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${sent ? "border-ok/30 bg-ok-soft text-ok" : skipped ? "border-line text-faint" : report.status === "failed" ? "border-bad/30 bg-bad-soft text-bad" : "border-line text-muted"}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${sent ? "bg-ok" : report.status === "failed" ? "bg-bad" : "bg-faint"}`} />
          {sent ? "Sent" : skipped ? "Skipped" : report.status === "failed" ? "Couldn't write it" : "Draft"}
          {report.owner ? ` · ${report.owner}` : ""}
        </span>
        <span className="flex flex-wrap items-center gap-2">
          {!sent && !skipped && <RegenerateButton kind="one" variant="header" id={report.id} label={title} />}
          {!sent && !skipped && <SkipButton id={report.id} title={title} variant="link" />}
        </span>
      </div>

      {skipped && <SkippedBanner id={report.id} log={report.skip.log} canBringBack={report.skip.canBringBack} />}
      {report.regen && !sent && <UndoRegenerate id={report.id} at={report.regen.at} by={report.regen.by} />}
      {report.status === "failed" && <p className="rounded-[14px] border border-bad/30 bg-bad-soft px-4 py-3 text-sm text-bad">{report.error ?? "It couldn't be written."} Regenerate it, or open the client to check the connection.</p>}

      {!sent && noteOn && (
        <div className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[14px] border px-4 py-3 ${noteOn.text === "needs_look" ? "border-warn/40 bg-warn-soft/40" : "border-line bg-surface"}`}>
          <p className="min-w-0 flex-1 basis-64 text-[13px] leading-snug text-muted">{channelNoteText(report.platform, noteOn)}</p>
          {noteOn.text === "needs_look" && (
            <span className="flex gap-2">
              <button type="button" disabled={pending} onClick={updateText} className={`${btn} bg-fg text-bg`}>
                Update the text
              </button>
              <button type="button" disabled={pending} onClick={() =>
                  go(async () => {
                    await keepChannelTextAsIs(report.id);
                    router.refresh();
                  })
                } className={`${btn} border border-line text-muted`}>
                Keep it as it is
              </button>
            </span>
          )}
        </div>
      )}
      {!sent && report.stale.length > 0 && <p className="rounded-[14px] border border-warn/40 bg-warn-soft/40 px-4 py-3 text-sm text-muted">Part of this isn&apos;t drawn for its dates yet ({report.stale.join(", ")}). Regenerate it with fresh data before sending.</p>}

      {!sent && !skipped && (
        <nav className="grid grid-cols-3 gap-1.5 rounded-[22px] border border-line bg-surface p-1.5" aria-label="Steps">
          {STEPS.map((s, i) => (
            <button key={s.key} type="button" aria-current={step === s.key ? "step" : undefined} onClick={() => pushParams({ step: s.key === "report" ? null : s.key })} className={`flex h-12 items-center justify-center gap-2 rounded-[17px] text-sm transition-colors ${step === s.key ? "bg-deep text-fg ring-1 ring-ink/10" : "text-muted hover:bg-surface-2 hover:text-fg"}`}>
              <span className="tabular text-xs text-faint">{i + 1}</span>
              {s.label}
            </button>
          ))}
        </nav>
      )}

      {(sent || step === "report") && !skipped && (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
          <section className="grid gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-heading text-[19px]">{sent ? "The report that went" : "The report the client gets"}</h2>
              <span className="flex gap-2">
                <a href={pdfUrl} target="_blank" rel="noopener noreferrer" className={`${btn} border border-line text-fg`}>
                  Open the PDF
                </a>
                <a href={`${pdfUrl}?download=1`} className={`${btn} border border-line text-fg`}>
                  Download
                </a>
              </span>
            </div>
            {/* The PDF itself: what is drawn is what is sent. A phone shows its first page; the buttons open it whole. */}
            <iframe key={bust} title="The report as a PDF" src={`${pdfUrl}#view=FitH&toolbar=0`} className="h-[78vh] min-h-[520px] w-full rounded-[18px] border border-line bg-surface-2" />
            {m && (
              <ul className="grid gap-1 rounded-[14px] border border-line bg-surface px-4 py-3 text-[13px] text-muted">
                {keyLines(m).map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            )}
          </section>

          {!sent && (
            <aside className="grid content-start gap-3">
              <div className="flex gap-1 rounded-full bg-surface-2 p-1 text-sm">
                {(["ai", "checks", "edit"] as const).map((k) => (
                  <button key={k} type="button" onClick={() => setRail(k)} className={`h-10 flex-1 rounded-full px-3 transition-colors ${rail === k ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
                    {k === "ai" ? "Ask the AI" : k === "checks" ? `Checks${flags.length ? ` · ${flags.length}` : ""}` : "Edit"}
                  </button>
                ))}
              </div>

              {rail === "ai" && (
                <div className="grid gap-3">
                  <div className="grid max-h-[46vh] min-h-[140px] content-start gap-2.5 overflow-y-auto pr-1">
                    {!chat.length && <p className="text-xs leading-relaxed text-faint">Say what to change and watch the report and the message update. It can look things up as it goes: the client&apos;s calls, Slack, email and Drive, earlier reports, and these numbers for other dates.</p>}
                    {chat.map((t, i) => (
                      <div key={i} className={`rounded-[14px] px-3.5 py-2.5 text-sm leading-relaxed ${t.role === "user" ? "ml-6 bg-surface-2" : "mr-6 border border-line"}`}>
                        {t.text}
                        {t.pulled?.length ? <p className="mt-1 text-[11px] text-faint">Looked up: {t.pulled.join("; ")}</p> : null}
                      </div>
                    ))}
                    {busy && <p className="text-xs text-faint">{busy}</p>}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {SUGGEST.map((s) => (
                      <button key={s} type="button" disabled={pending} onClick={() => revise(s)} className="inline-flex h-9 items-center rounded-full border border-line px-3 text-xs text-muted hover:border-faint hover:text-fg disabled:opacity-50 max-md:h-11">
                        {s}
                      </button>
                    ))}
                  </div>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      revise(ask);
                    }}
                    className="flex gap-2"
                  >
                    <input value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="Ask for a change…" className={`${inputCls} h-11`} />
                    <button type="submit" disabled={pending || !ask.trim()} className={`${btn} bg-brand text-white`}>
                      Send
                    </button>
                  </form>
                </div>
              )}

              {rail === "checks" && (
                <div className="grid gap-2.5">
                  {flags.length === 0 && <p className="rounded-[14px] border border-line bg-surface px-4 py-3 text-sm text-ok">{qa ? "Nothing to fix or check." : "Not checked yet."}</p>}
                  {flags.map((f, i) => (
                    <div key={i} className={`grid gap-1 rounded-[14px] border px-4 py-3 text-sm ${f.severity === "fix" ? "border-bad/30 bg-bad-soft/40" : f.severity === "alert" ? "border-warn/40 bg-warn-soft/40" : "border-line bg-surface"}`}>
                      <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">{f.severity === "fix" ? "To fix" : f.severity === "alert" ? "Alert" : "To check"}</span>
                      <span>{f.issue}</span>
                      <span className="text-xs text-muted">{f.suggestion}</span>
                    </div>
                  ))}
                  <button type="button" disabled={pending} onClick={checkAgain} className={`${btn} border border-line text-fg`}>
                    {busy === "Checking…" ? "Checking…" : "Check it again"}
                  </button>
                </div>
              )}

              {rail === "edit" && sections && (
                <div className="grid gap-3 text-sm">
                  <label className="grid gap-1">
                    <span className="text-xs text-faint">Headline</span>
                    <input className={inputCls} value={sections.headline} onChange={(e) => setSection({ ...sections, headline: e.target.value })} />
                  </label>
                  <label className="grid gap-1">
                    <span className="text-xs text-faint">Summary</span>
                    <textarea rows={4} className={inputCls} value={sections.summary} onChange={(e) => setSection({ ...sections, summary: e.target.value })} />
                  </label>
                  {(["did", "doing", "next", "highlights"] as const).map((k) => (
                    <label key={k} className="grid gap-1">
                      <span className="text-xs text-faint">{k === "did" ? "What we did" : k === "doing" ? "What we're doing" : k === "next" ? "What's next" : "Highlights"} (one per line)</span>
                      <textarea rows={4} className={inputCls} defaultValue={lines(sections[k])} onBlur={(e) => setSection({ ...sections, [k]: split(e.target.value) })} />
                    </label>
                  ))}
                  <p className="text-xs text-faint">The PDF shows the three takeaway cards; the rest travels in the message.</p>
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="grid gap-1 rounded-[14px] border border-line p-3">
                      <input aria-label={`Takeaway ${i + 1} title`} className={inputCls} value={sections.takeaways?.[i]?.title ?? ""} onChange={(e) => setSection({ ...sections, takeaways: [0, 1, 2].map((j) => (j === i ? { title: e.target.value, text: sections.takeaways?.[j]?.text ?? "" } : (sections.takeaways?.[j] ?? { title: "", text: "" }))) })} />
                      <textarea aria-label={`Takeaway ${i + 1} text`} rows={2} className={inputCls} value={sections.takeaways?.[i]?.text ?? ""} onChange={(e) => setSection({ ...sections, takeaways: [0, 1, 2].map((j) => (j === i ? { title: sections.takeaways?.[j]?.title ?? "", text: e.target.value } : (sections.takeaways?.[j] ?? { title: "", text: "" }))) })} />
                    </div>
                  ))}
                </div>
              )}
            </aside>
          )}
        </div>
      )}

      {!sent && !skipped && step === "message" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="grid content-start gap-3">
            <h2 className="font-heading text-[19px]">The Slack message</h2>
            <textarea
              rows={16}
              className={inputCls}
              value={message}
              onChange={(e) => {
                setMessage(e.target.value);
                keep({ message: e.target.value });
              }}
            />
            <button type="button" disabled={pending || !sections} onClick={bringMessage} className={`${btn} w-fit border border-line text-fg`}>
              {busy === "Updating the message…" ? "Updating…" : "Bring it up to date with the report"}
            </button>
          </section>
          <section className="grid content-start gap-3">
            <h2 className="font-heading text-[19px]">Preview</h2>
            <Slack from={slack.name ?? slack.me} text={message} file={`${client.name} report.pdf`} />
          </section>
        </div>
      )}

      {!sent && !skipped && step === "send" && (
        <section className="grid max-w-2xl gap-4">
          <h2 className="font-heading text-[19px]">Send it to {client.name}</h2>
          <DeliveryPicker value={route} onChange={setRoute} options={delivery ?? { contacts: [], initial: route, slackChannel: client.hasChannel, emailReady: true }} />
          <label className="grid gap-1">
            <span className="text-xs text-faint">A note for the email (optional)</span>
            <textarea rows={3} className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          {flags.some((f) => f.severity === "fix") && <p className="text-sm text-bad">The QA still has something to fix. You can send anyway, but read the Checks first.</p>}
          {problem && <p className="text-sm text-warn">{problem}</p>}
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" disabled={pending || Boolean(problem) || report.stale.length > 0} onClick={send} className={`${btn} bg-brand text-white shadow-[0_18px_40px_-16px_rgba(200,16,46,0.9)]`}>
              {busy === "Sending…" ? "Sending…" : `Send ${channelsPhrase(route.channels)}`}
            </button>
            <span className="text-xs text-faint">Slack goes out as you; the email carries the PDF and replies come to you.</span>
          </div>
        </section>
      )}

      {sent && (
        <section className="grid gap-3">
          <p className="rounded-[14px] border border-ok/30 bg-ok-soft/40 px-4 py-3 text-sm text-ok">
            It went to the client.{report.shareUrl ? " The live page opens from the link in the message." : ""}
          </p>
          {report.shareUrl && (
            <a href={report.shareUrl} target="_blank" rel="noopener noreferrer" className="w-fit break-all text-sm text-brand-text underline-offset-4 hover:underline">
              {report.shareUrl}
            </a>
          )}
        </section>
      )}

      {history.length > 0 && (
        <section className="grid gap-3">
          <h3 className="font-heading text-[19px]">History</h3>
          <SendHistory items={history} showClient={false} />
        </section>
      )}
      {report.skip.log.length > 0 && <SkipHistory log={report.skip.log} />}
    </div>
  );
}
