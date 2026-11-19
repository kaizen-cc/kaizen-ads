"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { createClient } from "@/lib/supabase/client";
import { emailAllotmentLine, emailPools, type EmailAllotment, type SowScope } from "@/lib/email-allotment-core";
import { draftScopeNow, findSowNow, setEmailPackage, setScopeMonth, sowUploadSlot, sowUploaded } from "./email-scope-actions";

// The Allotment and SOW tab: this cycle at a glance, the package picker, the SOW (found or uploaded; replace it when
// the scope changes, the months follow), and each scoped month (changed by hand when needed). Saves on change.

type Pkg = { key: string; label: string; campaigns: number; flows: number; note: string | null };
type Sow = { id: string; name: string; url: string | null; source: "found" | "upload"; foundIn: string | null; scope: SowScope | null; status: string; note: string | null; at: string };
type Month = { month: string; campaigns: number; flows: number; label: string | null; notes: string | null; source: "sow" | "manual"; drafted: boolean };

const FOUND: Record<string, string> = { drive: "their Drive", gmail: "an email", documents: "their documents", kaizen_documents: "a SOW drawn in Kaizen OS", upload: "an upload" };
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const monthName = (m: string) => new Date(`${m}T12:00:00`).toLocaleDateString("en-US", { month: "long", year: "numeric" });
const thisMonth = () => `${new Date().toISOString().slice(0, 7)}-01`;

export function EmailScopeEditor({ clientId, allotment, packages, packageKey, sow, replaced, months, canEdit, canSetPackage }: { clientId: string; allotment: EmailAllotment | null; packages: Pkg[]; packageKey: string | null; sow: Sow | null; replaced: { name: string; at: string }[]; months: Month[]; canEdit: boolean; canSetPackage: boolean }) {
  const router = useRouter();
  const [, start] = useTransition();
  const [busy, setBusy] = useState<null | "upload" | "find" | "draft" | "package">(null);
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
  const draft = async () => {
    setBusy("draft");
    const r = await draftScopeNow(clientId);
    setBusy(null);
    setMsg(r.ok ? { tone: "ok", text: "Drafting this month's requests. The Email Strategist is told when the copy is ready (a few minutes)." } : { tone: "bad", text: r.error });
  };
  const pick = async (key: string) => {
    setBusy("package");
    const r = await setEmailPackage(clientId, key || null);
    setBusy(null);
    if (!r.ok) return setMsg({ tone: "bad", text: r.error });
    refresh();
  };

  const pools = emailPools(allotment);
  // The month the billing cycle started in is the one that counts now
  const now = allotment?.cycle ? `${allotment.cycle.start.slice(0, 7)}-01` : thisMonth();
  const current = months.find((m) => m.month === now);

  return (
    <div className="grid gap-6">
      <section className="grid gap-4 rounded-[20px] border border-line bg-surface p-5 md:p-7">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-1">
            <p className="text-xs uppercase tracking-[0.2em] text-faint">Email allotment this cycle</p>
            <h2 className="font-heading text-xl leading-snug">{emailAllotmentLine(allotment) ?? "No allotment set yet"}</h2>
            <p className="text-[13px] text-muted">
              {allotment?.source === "sow" ? `From their SOW${allotment.label ? `: ${allotment.label}` : ""}.` : allotment?.source === "manual" ? "Set by hand for this month." : allotment?.source === "package" ? `From the ${allotment.label ?? ""} package.` : "Pick their package, or add their SOW: onboarding months follow the SOW."} Delivered and in-progress requests both count; a flow counts once.
            </p>
          </div>
        </div>
        {pools.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            {pools.map((p) => {
              const total = Math.max(p.cap, p.used, 1);
              return (
                <div key={p.key} className="grid gap-1.5">
                  <div className="flex items-baseline justify-between text-[13px]">
                    <span>{p.label}</span>
                    <span className="tabular text-muted">
                      {p.used}/{p.cap}
                      {p.progress ? ` · ${p.progress} in progress` : ""}
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
        <div className="flex flex-wrap items-center gap-3">
          <label className="grid gap-1 text-[12px] text-faint">
            Email package
            <select
              value={packageKey ?? ""}
              disabled={!canSetPackage || busy !== null}
              onChange={(e) => void pick(e.target.value)}
              className="min-h-11 rounded-[12px] border border-line bg-bg px-3 text-[14px] text-fg outline-none disabled:opacity-60 md:min-h-10"
            >
              <option value="">{packages.length ? "No package" : "No packages set up yet"}</option>
              {packages.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}: {p.campaigns} campaigns, {p.flows} flow{p.flows === 1 ? "" : "s"} a month
                </option>
              ))}
            </select>
          </label>
          {!canSetPackage && <span className="text-[12px] text-faint">An executive or a lead sets the package.</span>}
        </div>
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

        {months.length > 0 && (
          <div className="grid gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">Month by month</p>
            {months.map((m) => (
              <MonthRow key={m.month} clientId={clientId} m={m} now={m.month === now} canEdit={canEdit} onSaved={refresh} />
            ))}
          </div>
        )}
        {canEdit && !current && (
          <div className="grid gap-2">
            <p className="text-[12px] text-faint">This month isn&rsquo;t scoped by a SOW. Set it by hand to override the package for this month only:</p>
            <MonthRow clientId={clientId} m={{ month: now, campaigns: allotment?.campaigns ?? 0, flows: allotment?.flows ?? 0, label: null, notes: null, source: "manual", drafted: false }} now canEdit={canEdit} onSaved={refresh} />
          </div>
        )}
        {canEdit && current && !current.drafted && (current.campaigns > 0 || current.flows > 0) && (
          <button type="button" onClick={draft} disabled={busy !== null} className="min-h-11 justify-self-start rounded-full border border-brand/40 px-4 text-[13px] text-brand-text transition hover:bg-brand/10 disabled:opacity-50 md:min-h-9">
            {busy === "draft" ? "Starting…" : "Draft this month's requests now"}
          </button>
        )}
        {replaced.length > 0 && <p className="text-[12px] text-faint">Replaced: {replaced.map((r) => `${r.name} (${day(r.at)})`).join(", ")}</p>}
      </section>
    </div>
  );
}

function MonthRow({ clientId, m, now, canEdit, onSaved }: { clientId: string; m: Month; now: boolean; canEdit: boolean; onSaved: () => void }) {
  const [campaigns, setCampaigns] = useState(String(m.campaigns));
  const [flows, setFlows] = useState(String(m.flows));
  const [saving, setSaving] = useState(false);
  const save = async (c = campaigns, f = flows) => {
    if (Number(c) === m.campaigns && Number(f) === m.flows) return;
    setSaving(true);
    await setScopeMonth(clientId, m.month, Number(c) || 0, Number(f) || 0);
    setSaving(false);
    onSaved();
  };
  const num = "h-11 w-16 rounded-[10px] border border-line bg-bg px-2 text-center text-[16px] tabular text-fg outline-none focus:border-faint disabled:opacity-60 md:h-9 md:text-[14px]";
  return (
    <div className={`flex flex-wrap items-center gap-3 rounded-[14px] border px-4 py-3 ${now ? "border-brand/40 bg-brand/[0.05]" : "border-line"}`}>
      <span className="grid min-w-[140px] flex-1">
        <span className="text-[14px] text-fg">
          {monthName(m.month)}
          {now && <span className="ml-2 rounded-full bg-brand-soft px-2 py-0.5 text-[10.5px] text-brand-text">Now</span>}
        </span>
        <span className="text-[12px] text-faint">
          {[m.label, m.source === "manual" ? "set by hand" : "from the SOW", m.drafted ? "requests drafted" : null].filter(Boolean).join(" · ")}
        </span>
        {m.notes && <span className="text-[12px] text-muted">{m.notes}</span>}
      </span>
      <label className="flex items-center gap-2 text-[12.5px] text-muted">
        Campaigns
        <input inputMode="numeric" value={campaigns} disabled={!canEdit || saving} onChange={(e) => setCampaigns(e.target.value.replace(/\D/g, "").slice(0, 2))} onBlur={() => void save()} className={num} />
      </label>
      <label className="flex items-center gap-2 text-[12.5px] text-muted">
        Flows
        <input inputMode="numeric" value={flows} disabled={!canEdit || saving} onChange={(e) => setFlows(e.target.value.replace(/\D/g, "").slice(0, 2))} onBlur={() => void save()} className={num} />
      </label>
    </div>
  );
}
