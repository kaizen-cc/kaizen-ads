"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { createClient } from "@/lib/supabase/client";
import { emailAllotmentLine, emailPools, type EmailAllotment, type SowScope } from "@/lib/email-allotment-core";
import { draftScopeNow, findSowNow, rereadSowNow, setMonthStatus, setScopeMonth, sowUploadSlot, sowUploaded } from "./email-scope-actions";
import { ScopeChat } from "./scope-chat";

// The Allotment and SOW tab: this cycle at a glance (campaigns, SMS, flows and flow emails, each paced against the top
// of its range), the SOW (found or uploaded; replace it when the scope changes, the months follow), and each scoped month
// (changed by hand when needed). The tier itself is set in one place: Services, on Team & setup. Saves on change.

type Sow = { id: string; name: string; url: string | null; source: "found" | "upload"; foundIn: string | null; scope: SowScope | null; status: string; note: string | null; at: string };
/** A month's numbers as shown in the boxes: a number or a range ("3-5") */
export type ScopeMonth = { month: string; campaigns: string; sms: string; flows: string; flowEmails: string; label: string | null; notes: string | null; source: "sow" | "manual"; drafted: boolean; status: "active" | "unsigned" | "removed"; statusNote: string | null };

const FOUND: Record<string, string> = { drive: "their Drive", gmail: "an email", documents: "their documents", kaizen_documents: "a SOW drawn in Kaizen OS", upload: "an upload" };
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const monthName = (m: string) => new Date(`${m}T12:00:00`).toLocaleDateString("en-US", { month: "long", year: "numeric" });
const thisMonth = () => `${new Date().toISOString().slice(0, 7)}-01`;

function sourceLine(a: EmailAllotment | null) {
  if (a?.source === "strategy") return "Strategy only: no copy or design, so no allotment, pace alerts or requests.";
  if (a?.source === "sow") return `From their SOW${a.label ? `: ${a.label}` : ""}.`;
  if (a?.source === "setup") return `${a.label ?? "3-Month Initial Setup"}.`;
  if (a?.source === "manual") return "Set by hand for this month.";
  if (a?.source === "package") return `${a.label ?? ""} tier.`;
  return "No tier yet: set it in Services on Team & setup, or add their SOW below (onboarding months follow the SOW).";
}

export function EmailScopeEditor({ clientId, allotment, sow, replaced, months, log = [], canEdit }: { clientId: string; allotment: EmailAllotment | null; sow: Sow | null; replaced: { name: string; at: string }[]; months: ScopeMonth[]; log?: { note: string; via: string; at: string; by: string | null }[]; canEdit: boolean }) {
  const router = useRouter();
  const [, start] = useTransition();
  const [busy, setBusy] = useState<null | "upload" | "find" | "draft" | "reread">(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const refresh = () => start(() => router.refresh());

  const upload = async (f: File) => {
    setBusy("upload");
    setMsg(null);
    const slot = await sowUploadSlot(clientId, f.name, f.type, f.size);
    if (!slot.ok) {
      setBusy(null);
      return setMsg({ tone: "bad", text: slot.error });
    }
    const { error } = await createClient().storage.from("client-docs").uploadToSignedUrl(slot.path, slot.token, f, { contentType: f.type || "application/octet-stream" });
    if (error) {
      setBusy(null);
      return setMsg({ tone: "bad", text: "The upload didn't go through. Try again." });
    }
    const r = await sowUploaded(clientId, slot.path, f.name, f.type);
    setBusy(null);
    if (!r.ok) return setMsg({ tone: "bad", text: r.error });
    const n = r.scope?.months.length ?? 0;
    setMsg({ tone: r.note ? "bad" : "ok", text: r.note ?? (r.scope?.email_in_scope ? `Read: ${n} month${n === 1 ? "" : "s"} of email scope set as the allotment.` : "Saved. The SOW doesn't scope email work.") });
    refresh();
  };
  const find = async () => {
    setBusy("find");
    setMsg(null);
    const r = await findSowNow(clientId);
    setBusy(null);
    if (!r.ok) return setMsg({ tone: "bad", text: r.error });
    setMsg(r.found ? { tone: "ok", text: `Found and read: ${r.found}` } : { tone: "bad", text: "No SOW in their Drive, emails or documents yet. Upload it here." });
    refresh();
  };
  const reread = async () => {
    setBusy("reread");
    setMsg(null);
    const r = await rereadSowNow(clientId);
    setBusy(null);
    setMsg(r.ok ? { tone: "ok", text: "Read again: campaigns, SMS, flows and flow emails per month, and months that weren't signed." } : { tone: "bad", text: r.error });
    refresh();
  };
  const draft = async () => {
    setBusy("draft");
    const r = await draftScopeNow(clientId);
    setBusy(null);
    setMsg(r.ok ? { tone: "ok", text: "Drafting this month's requests. The Email Strategist is told when the copy is ready (a few minutes)." } : { tone: "bad", text: r.error });
  };

  const pools = emailPools(allotment);
  // The month the billing cycle started in is the one that counts now
  const now = allotment?.cycle ? `${allotment.cycle.start.slice(0, 7)}-01` : thisMonth();
  const current = months.find((m) => m.month === now);
  const strategy = allotment?.source === "strategy";
  const draftable = !strategy && (allotment?.source === "sow" || allotment?.source === "setup") && pools.some((p) => (p.cap ?? 0) > p.used);

  return (
    <div className="grid gap-6">
      <section className="grid gap-4 rounded-[20px] border border-line bg-surface p-5 md:p-7">
        <div className="grid gap-1">
          <p className="text-xs uppercase tracking-[0.2em] text-faint">Email allotment this cycle</p>
          <h2 className="font-heading text-xl leading-snug">{strategy ? "Strategy only" : (emailAllotmentLine(allotment) ?? "No allotment set yet")}</h2>
          <p className="text-[13px] text-muted">
            {sourceLine(allotment)} {strategy ? "" : "Delivered and in-progress requests both count; a flow counts once, its emails as flow emails."}
          </p>
          {allotment?.notes && <p className="text-[12.5px] text-faint">{allotment.notes}</p>}
        </div>
        {!strategy && pools.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            {pools.map((p) => {
              const total = Math.max(p.cap ?? 0, p.used, 1);
              return (
                <div key={p.key} className="grid gap-1.5">
                  <div className="flex items-baseline justify-between text-[13px]">
                    <span>{p.label}</span>
                    <span className="tabular text-muted">
                      {p.used}
                      {p.range != null ? `/${p.range}` : " asked"}
                      {p.progress ? ` · ${p.progress} in progress` : ""}
                      {p.done ? ` · ${p.done} done` : ""}
                    </span>
                  </div>
                  <span className="flex h-2 overflow-hidden rounded-full bg-surface-2" aria-hidden>
                    <span className="h-full bg-ok/80" style={{ width: `${(Math.max(0, p.used - p.progress) / total) * 100}%` }} />
                    <span className={`h-full ${p.over ? "bg-bad" : "bg-warn/80"}`} style={{ width: `${(p.progress / total) * 100}%` }} />
                  </span>
                </div>
              );
            })}
          </div>
        )}
        {canEdit && draftable && (
          <button type="button" onClick={draft} disabled={busy !== null || Boolean(current?.drafted)} className="min-h-11 justify-self-start rounded-full border border-brand/40 px-4 text-[13px] text-brand-text transition hover:bg-brand/10 disabled:opacity-50 md:min-h-9">
            {current?.drafted ? "This month's requests are drafted" : busy === "draft" ? "Starting…" : "Draft what's left of this month now"}
          </button>
        )}
      </section>

      <section className="grid gap-4 rounded-[20px] border border-line bg-surface p-5 md:p-7">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-1">
            <p className="text-xs uppercase tracking-[0.2em] text-faint">Scope of Work</p>
            <h2 className="font-heading text-xl leading-snug [overflow-wrap:anywhere]">{sow ? sow.name : "No SOW yet"}</h2>
            <p className="text-[13px] text-muted">
              {sow
                ? `${sow.source === "upload" ? "Uploaded" : `Found in ${FOUND[sow.foundIn ?? ""] ?? "their files"}`} ${day(sow.at)}${sow.status === "unreadable" ? ". Couldn't read its email scope: upload it again." : ""}`
                : "Kaizen looks for it in their Drive, emails and documents once they close. Not found yet? Upload it here."}
            </p>
          </div>
          {canEdit && (
            <div className="flex flex-wrap gap-2">
              <input
                ref={file}
                type="file"
                accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void upload(f);
                }}
              />
              <button type="button" onClick={() => file.current?.click()} disabled={busy !== null} className="min-h-11 rounded-full bg-fg px-4 text-[13px] font-medium text-bg transition active:scale-[0.98] disabled:opacity-50 md:min-h-9">
                {busy === "upload" ? "Reading the SOW…" : sow ? "Replace the SOW" : "Upload the SOW"}
              </button>
              {sow && (
                <button type="button" onClick={reread} disabled={busy !== null} className="min-h-11 rounded-full border border-line px-4 text-[13px] text-muted hover:border-faint hover:text-fg disabled:opacity-50 md:min-h-9">
                  {busy === "reread" ? "Reading…" : "Read it again"}
                </button>
              )}
              {!sow && (
                <button type="button" onClick={find} disabled={busy !== null} className="min-h-11 rounded-full border border-line px-4 text-[13px] text-muted hover:border-faint hover:text-fg disabled:opacity-50 md:min-h-9">
                  {busy === "find" ? "Looking…" : "Look for it again"}
                </button>
              )}
            </div>
          )}
        </div>
        {sow?.scope?.summary && <p className="text-[13.5px] leading-relaxed text-muted">{sow.scope.summary}</p>}
        {sow?.url && (
          <a href={sow.url} target="_blank" rel="noopener noreferrer" className="justify-self-start text-[13px] text-muted underline-offset-2 hover:text-fg hover:underline">
            Open the SOW ↗
          </a>
        )}
        {msg && <p className={`rounded-[12px] px-3 py-2 text-[13px] ${msg.tone === "ok" ? "bg-ok-soft text-fg" : "bg-bad-soft text-bad"}`}>{msg.text}</p>}
        {canEdit && (sow || months.length > 0) && <ScopeChat clientId={clientId} onApplied={refresh} />}

        {months.length > 0 && (
          <div className="grid gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">Month by month</p>
            {months.map((m) => (
              <MonthRow key={m.month} clientId={clientId} m={m} now={m.month === now} canEdit={canEdit} onSaved={refresh} />
            ))}
          </div>
        )}
        {canEdit && !current && !strategy && (
          <div className="grid gap-2">
            <p className="text-[12px] text-faint">This month isn&rsquo;t scoped by a SOW. Set it by hand to override the tier for this month only:</p>
            <MonthRow
              clientId={clientId}
              m={{ month: now, campaigns: String(allotment?.campaigns.max ?? 0), sms: String(allotment?.sms.max ?? 0), flows: String(allotment?.flows.max ?? 0), flowEmails: String(allotment?.flowEmails.max ?? 0), label: null, notes: null, source: "manual", drafted: false, status: "active", statusNote: null }}
              now
              canEdit={canEdit}
              onSaved={refresh}
            />
          </div>
        )}
        {log.length > 0 && (
          <div className="grid gap-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">Why it changed</p>
            {log.map((n, i) => (
              <p key={i} className="text-[12.5px] leading-relaxed text-muted">
                <span className="text-faint">
                  {day(n.at)}
                  {n.by ? ` · ${n.by.split(" ")[0]}` : ""}
                  {n.via === "chat" ? " · with AI" : ""}:
                </span>{" "}
                {n.note}
              </p>
            ))}
          </div>
        )}
        {replaced.length > 0 && <p className="text-[12px] text-faint">Replaced: {replaced.map((r) => `${r.name} (${day(r.at)})`).join(", ")}</p>}
      </section>
    </div>
  );
}

const POOLS = [
  ["campaigns", "Campaigns"],
  ["sms", "SMS"],
  ["flows", "Flows"],
  ["flowEmails", "Flow emails"],
] as const;

function MonthRow({ clientId, m, now, canEdit, onSaved }: { clientId: string; m: ScopeMonth; now: boolean; canEdit: boolean; onSaved: () => void }) {
  const [v, setV] = useState({ campaigns: m.campaigns, sms: m.sms, flows: m.flows, flowEmails: m.flowEmails });
  const [saving, setSaving] = useState(false);
  const off = m.status !== "active";
  const save = async () => {
    if (v.campaigns === m.campaigns && v.sms === m.sms && v.flows === m.flows && v.flowEmails === m.flowEmails) return;
    setSaving(true);
    await setScopeMonth(clientId, m.month, v);
    setSaving(false);
    onSaved();
  };
  const mark = async (action: "unsigned" | "removed" | "reopen") => {
    if (action === "removed" && !confirm(`Remove ${monthName(m.month)}? It holds no allotment until it's reopened.`)) return;
    setSaving(true);
    await setMonthStatus(clientId, m.month, action);
    setSaving(false);
    onSaved();
  };
  const num = "h-11 w-16 rounded-[10px] border border-line bg-bg px-2 text-center text-[16px] tabular text-fg outline-none focus:border-faint disabled:opacity-60 md:h-9 md:text-[14px]";
  const link = "min-h-10 text-[12px] text-faint underline-offset-2 hover:text-fg hover:underline disabled:opacity-50 md:min-h-0";
  return (
    <div className={`grid gap-3 rounded-[14px] border px-4 py-3 ${off ? "border-dashed border-line opacity-60" : now ? "border-brand/40 bg-brand/[0.05]" : "border-line"}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="grid min-w-0">
          <span className="text-[14px] text-fg">
            {monthName(m.month)}
            {now && !off && <span className="ml-2 rounded-full bg-brand-soft px-2 py-0.5 text-[10.5px] text-brand-text">Now</span>}
            {off && <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-[10.5px] text-muted">{m.status === "unsigned" ? "Not signed" : "Removed"}</span>}
          </span>
          <span className="text-[12px] text-faint">{[m.label, m.source === "manual" ? "set by hand" : "from the SOW", m.drafted ? "requests drafted" : null].filter(Boolean).join(" · ")}</span>
          {m.notes && <span className="text-[12px] text-muted">{m.notes}</span>}
          {off && <span className="text-[12px] text-muted">{m.statusNote ? `${m.statusNote}. ` : ""}Holds no allotment.</span>}
        </span>
        {canEdit && (
          <span className="flex flex-wrap gap-3">
            {off ? (
              <button type="button" disabled={saving} onClick={() => void mark("reopen")} className={link}>
                Reopen
              </button>
            ) : (
              <>
                <button type="button" disabled={saving} onClick={() => void mark("unsigned")} className={link}>
                  Not signed
                </button>
                <button type="button" disabled={saving} onClick={() => void mark("removed")} className={link}>
                  Remove month
                </button>
              </>
            )}
          </span>
        )}
      </div>
      {!off && (
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {POOLS.map(([key, label]) => (
            <label key={key} className="flex items-center gap-2 text-[12.5px] text-muted">
              {label}
              <input
                value={v[key]}
                disabled={!canEdit || saving}
                onChange={(e) => setV((x) => ({ ...x, [key]: e.target.value.replace(/[^\d-]/g, "").slice(0, 5) }))}
                onBlur={() => void save()}
                aria-label={`${label}: a number or a range like 3-5`}
                className={num}
              />
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
