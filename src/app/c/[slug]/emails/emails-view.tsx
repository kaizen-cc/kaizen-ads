"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { EmailDesignCanvas, type Box } from "@/components/email-design-canvas";
import { submitEmailReview, type EmailDecision } from "./actions";

export type PortalEmailMessage = {
  id: string;
  channel: "email" | "sms";
  name: string;
  sendOn: string | null;
  delayHours: number | null;
  subject: string | null;
  preheader: string | null;
  body: string | null;
  designUrl: string | null;
  pdf: boolean;
  links: { label: string; url: string; box: Box | null }[];
  approved: boolean;
};
export type PortalEmailTicket = { id: string; kind: "batch" | "flow"; title: string; goal: string | null; trigger: string | null; messages: PortalEmailMessage[] };

type Draft = { decision: "approved" | "changes" | null; note: string; pins: { box: Box; body: string }[] };
const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

function MessageReview({ m, d, setD, n, flow }: { m: PortalEmailMessage; d: Draft; setD: (d: Draft) => void; n: number; flow: boolean }) {
  const [pinning, setPinning] = useState(false);
  const [box, setBox] = useState<Box | null>(null);
  const [text, setText] = useState("");
  return (
    <article className="grid gap-4 rounded-[24px] border border-line bg-surface p-4 md:p-5">
      <header className="flex flex-wrap items-center gap-2">
        <span className="grid h-8 w-8 place-items-center rounded-full bg-surface-2 text-xs font-bold text-muted">{n}</span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-heading text-lg">{m.name}</h3>
          <p className="text-xs text-muted">{m.channel === "sms" ? "Text message" : "Email"}{m.sendOn ? ` · sends ${day(m.sendOn)}` : flow && m.delayHours != null ? ` · ${m.delayHours ? `${m.delayHours >= 24 && m.delayHours % 24 === 0 ? `${m.delayHours / 24} days` : `${m.delayHours} hours`} after the one before` : "right away"}` : ""}</p>
        </div>
        {m.approved && <span className="rounded-full bg-ok-soft px-3 py-1 text-xs font-medium text-ok">Approved</span>}
      </header>
      {m.channel === "email" && (m.subject || m.preheader) && (
        <div className="rounded-[14px] bg-surface-2 p-3 text-sm">
          <p className="font-medium">{m.subject}</p>
          {m.preheader && <p className="text-muted">{m.preheader}</p>}
        </div>
      )}
      {m.channel === "sms" ? (
        <div className="mx-auto w-full max-w-sm rounded-[22px] bg-surface-2 p-4">
          <p className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-[18px] rounded-br-[6px] bg-[#34c759] px-3.5 py-2.5 text-[15px] leading-snug text-white">{m.body}</p>
        </div>
      ) : m.designUrl && !m.pdf ? (
        <EmailDesignCanvas
          src={m.designUrl}
          alt={`${m.name} design`}
          links={m.links}
          openLinks
          drawing={pinning}
          pins={d.pins.map((p, i) => ({ id: String(i), box: p.box, n: i + 1, tone: "client" as const, label: p.body }))}
          onDraw={(b) => {
            setBox(b);
            setPinning(false);
          }}
          className="mx-auto w-full max-w-[600px]"
        />
      ) : m.designUrl ? (
        <a href={m.designUrl} target="_blank" rel="noopener noreferrer" className="grid h-32 place-items-center rounded-[14px] border border-line text-sm text-muted">
          Open the design
        </a>
      ) : (
        <p className="whitespace-pre-wrap rounded-[14px] bg-surface-2 p-4 text-sm leading-relaxed">{m.body}</p>
      )}
      {m.links.length > 0 && m.channel === "email" && <p className="text-xs text-faint">Tap a button on the design to see where it goes.</p>}
      {!m.approved && (
        <>
          {box && (
            <div className="grid gap-2 rounded-[14px] border border-brand-text/40 p-3">
              <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="What should change here?" className="w-full rounded-[12px] border border-line bg-bg p-3 text-sm outline-none focus:border-brand-text" />
              <div className="flex gap-2">
                <button type="button" onClick={() => (setBox(null), setText(""))} className="h-11 flex-1 rounded-full border border-line text-sm text-muted">
                  Cancel
                </button>
                <button type="button" disabled={!text.trim()} onClick={() => (setD({ ...d, decision: "changes", pins: [...d.pins, { box, body: text.trim() }] }), setBox(null), setText(""))} className="h-11 flex-1 rounded-full bg-fg text-sm font-medium text-bg disabled:opacity-40">
                  Add the note
                </button>
              </div>
            </div>
          )}
          {d.pins.length > 0 && (
            <ol className="grid gap-1.5 text-sm">
              {d.pins.map((p, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-brand text-[10px] font-bold text-white">{i + 1}</span>
                  <span className="flex-1">{p.body}</span>
                  <button type="button" onClick={() => setD({ ...d, pins: d.pins.filter((_, k) => k !== i) })} className="min-h-8 px-2 text-xs text-faint">
                    Remove
                  </button>
                </li>
              ))}
            </ol>
          )}
          {d.decision === "changes" && <textarea value={d.note} onChange={(e) => setD({ ...d, note: e.target.value })} rows={2} placeholder={m.channel === "sms" ? "What should the text say instead?" : "Anything else to change (the subject line, the wording, a date)"} className="w-full rounded-[12px] border border-line bg-bg p-3 text-sm outline-none focus:border-brand-text" />}
          <div className="grid grid-cols-2 gap-2 sm:flex">
            <button type="button" onClick={() => setD({ ...d, decision: "approved", pins: [], note: "" })} className={`h-12 rounded-full px-5 text-sm font-medium sm:flex-none ${d.decision === "approved" ? "bg-ok text-white" : "border border-line text-fg"}`}>
              {d.decision === "approved" ? "✓ Approved" : "Approve"}
            </button>
            <button type="button" onClick={() => setD({ ...d, decision: "changes" })} className={`h-12 rounded-full px-5 text-sm font-medium sm:flex-none ${d.decision === "changes" ? "bg-brand text-white" : "border border-line text-fg"}`}>
              Ask for changes
            </button>
            {m.channel === "email" && m.designUrl && !m.pdf && (
              <button type="button" onClick={() => (setPinning(!pinning), setD({ ...d, decision: "changes" }))} className={`col-span-2 h-12 rounded-full px-5 text-sm sm:flex-none ${pinning ? "bg-brand-soft text-brand-text" : "text-muted"}`}>
                {pinning ? "Tap the spot on the design" : "Point at something on the design"}
              </button>
            )}
          </div>
        </>
      )}
    </article>
  );
}

export function EmailsView({ slug, brand, tickets, team }: { slug: string; brand: string; tickets: PortalEmailTicket[]; team: boolean }) {
  const router = useRouter();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string[]>([]);
  const dOf = (id: string): Draft => drafts[id] ?? { decision: null, note: "", pins: [] };
  if (!tickets.length || tickets.every((t) => sent.includes(t.id)))
    return (
      <div className="grid gap-2 rounded-[24px] border border-line bg-surface p-8 text-center">
        <p className="font-heading text-[18px]">{sent.length ? "Thank you, we have your answer" : "No emails waiting for you"}</p>
        <p className="text-[14px] text-muted">{sent.length ? "The team picks it up from here." : "We’ll let you know when the next ones are ready."}</p>
      </div>
    );
  return (
    <div className="grid gap-8">
      <header>
        <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-faint">{brand}</p>
        <h1 className="font-heading text-[28px] leading-tight">Emails for your review</h1>
        <p className="mt-1 text-[14px] text-muted">Approve each one, or point at anything on a design to say what to change.{team ? " (You're testing as the client.)" : ""}</p>
      </header>
      {tickets
        .filter((t) => !sent.includes(t.id))
        .map((t) => {
          const open = t.messages.filter((m) => !m.approved);
          const ready = open.every((m) => dOf(m.id).decision);
          return (
            <section key={t.id} className="grid gap-4">
              <div>
                <h2 className="font-heading text-[22px]">{t.title}</h2>
                <p className="text-sm text-muted">{t.kind === "flow" ? `An automated series${t.trigger ? `: ${t.trigger}` : ""}` : `${t.messages.length} ${t.messages.length === 1 ? "send" : "sends"}`}{t.goal ? ` · ${t.goal}` : ""}</p>
              </div>
              {t.messages.map((m, i) => (
                <MessageReview key={m.id} m={m} n={i + 1} flow={t.kind === "flow"} d={dOf(m.id)} setD={(d) => setDrafts((x) => ({ ...x, [m.id]: d }))} />
              ))}
              <div className="sticky bottom-[calc(70px+env(safe-area-inset-bottom))] z-10 grid gap-2 rounded-[20px] border border-line bg-bg/90 p-3 backdrop-blur-xl lg:bottom-4">
                {error && <p className="text-sm text-bad">{error}</p>}
                <button
                  type="button"
                  disabled={!ready || busy === t.id}
                  onClick={async () => {
                    setBusy(t.id);
                    setError(null);
                    const decisions: EmailDecision[] = open.map((m) => {
                      const d = dOf(m.id);
                      return { messageId: m.id, decision: d.decision!, note: d.note, pins: d.pins };
                    });
                    const r = await submitEmailReview(slug, t.id, decisions);
                    setBusy(null);
                    if (!r.ok) return setError(r.error);
                    setSent((s) => [...s, t.id]);
                    router.refresh();
                  }}
                  className="h-12 rounded-full bg-brand text-[15px] font-medium text-white disabled:opacity-40"
                >
                  {busy === t.id ? "Sending…" : ready ? "Send my answer" : `Answer all ${open.length} to send`}
                </button>
              </div>
            </section>
          );
        })}
    </div>
  );
}
