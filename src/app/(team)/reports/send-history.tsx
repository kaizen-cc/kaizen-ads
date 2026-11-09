"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { closeThen, pushParams, useParam } from "@/lib/url-state";
import { channelsLabel, type Channel, type Delivery } from "@/lib/reports/delivery-core";
import { Layer } from "../clients/[slug]/layer";
import { deliveryForSend, duplicateForNext, resendReport } from "./actions";
import { DeliveryPicker, type DeliveryOptions } from "./delivery-picker";

// Every report that went to a client, newest first: who sent it, when, where (Slack, email or both) and to whom, the
// period, and the PDF exactly as it went, to open and review. Any of them can be sent again (the same channel or
// another, to whoever is picked now) or duplicated for the next period. Nothing here is ever removed.

export type HistoryItem = {
  id: string;
  client: string;
  kind: string;
  platform: string | null;
  periodLabel: string;
  sentAt: string;
  sentBy: string | null;
  channels: Channel[];
  to: string[];
  failed: string[];
  status: string;
  resent: boolean;
  /** The report itself, to open in the studio (read-only once sent) */
  reviewHref: string | null;
};

const KIND: Record<string, string> = { weekly: "Weekly", monthly: "Monthly recap", custom: "On demand", built: "Built by hand" };
const when = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric", timeZone: "America/New_York" })} at ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}`;
};

function ChannelChip({ c }: { c: Channel }) {
  return (
    <span className={`inline-flex h-6 items-center gap-1 rounded-full px-2 text-[11px] font-medium ${c === "email" ? "bg-[#4f7cff]/12 text-[#7aa7ff]" : "bg-[#e01e5a]/12 text-[#f06b93]"}`}>
      {c === "email" ? "Email" : "Slack"}
    </span>
  );
}

export function SendHistory({ items: all, showClient = true, filterable = false, empty }: { items: (HistoryItem & { clientId?: string })[]; showClient?: boolean; filterable?: boolean; empty?: React.ReactNode }) {
  const router = useRouter();
  const [pending, go] = useTransition();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const open = useParam("resend");
  // One client at a time (?hc=), in the address so back returns to the whole list
  const hc = useParam("hc");
  const clients = [...new Map(all.filter((x) => x.clientId).map((x) => [x.clientId!, x.client])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const items = filterable && hc ? all.filter((x) => x.clientId === hc) : all;
  const item = all.find((x) => x.id === open) ?? null;
  const filter = filterable && clients.length > 1 && (
    <label className="relative inline-flex w-full max-w-sm items-center">
      <span className="sr-only">Client</span>
      <select value={hc ?? ""} onChange={(e) => pushParams({ hc: e.target.value || null })} className="h-11 w-full appearance-none truncate rounded-full border border-line bg-surface pl-4 pr-9 text-sm text-fg hover:border-faint md:h-9">
        <option value="">Every client · {all.length} sent</option>
        {clients.map(([id, name]) => (
          <option key={id} value={id}>
            {name} · {all.filter((x) => x.clientId === id).length}
          </option>
        ))}
      </select>
      <span aria-hidden className="pointer-events-none absolute right-3.5 text-[10px] text-faint">▼</span>
    </label>
  );

  const duplicate = (id: string) =>
    go(async () => {
      setNote(null);
      const r = await duplicateForNext(id);
      if (!r.ok) return setNote({ ok: false, text: r.error });
      router.push(`/reports/${r.id}`);
    });

  if (!all.length) return <>{empty ?? null}</>;
  return (
    <div className="grid gap-3">
      {filter}
      {note &&<p className={`rounded-[12px] px-4 py-3 text-sm ${note.ok ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad"}`}>{note.text}</p>}
      <ul className="grid gap-2.5">
        {items.map((s) => (
          <li key={s.id} className="grid gap-3 rounded-[18px] border border-line bg-surface p-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
            <div className="grid min-w-0 gap-1.5">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                {showClient && <span className="truncate font-heading text-[16px] leading-tight">{s.client}</span>}
                <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-muted">
                  {KIND[s.kind] ?? "Report"}
                  {s.platform ? ` · ${s.platform === "google" ? "Google" : "Meta"}` : s.kind === "built" ? " · Joint" : ""}
                </span>
                <span className="text-[13px] text-fg">{s.periodLabel}</span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                {s.channels.map((c) => (
                  <ChannelChip key={c} c={c} />
                ))}
                <span>
                  {s.resent ? "Resent" : "Sent"} {when(s.sentAt)}
                  {s.sentBy ? ` by ${s.sentBy}` : ""}
                </span>
                {s.status === "partial" && <span className="text-warn">· not everywhere it was meant to go</span>}
              </div>
              {s.to.length > 0 && <p className="truncate text-[12px] text-faint" title={s.to.join(", ")}>To {s.to.join(", ")}</p>}
              {s.failed.length > 0 && <p className="truncate text-[12px] text-warn">Didn&rsquo;t reach {s.failed.join(", ")}</p>}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <a href={`/api/reports/sends/${s.id}/pdf`} target="_blank" rel="noreferrer" className="inline-flex h-11 items-center rounded-full border border-line px-3.5 text-[13px] text-fg hover:border-faint md:h-9">
                Open PDF ↗
              </a>
              {s.reviewHref && (
                <Link href={s.reviewHref} className="inline-flex h-11 items-center rounded-full border border-line px-3.5 text-[13px] text-muted hover:text-fg md:h-9">
                  Review
                </Link>
              )}
              <button type="button" onClick={() => pushParams({ resend: s.id })} className="h-11 rounded-full bg-fg px-4 text-[13px] font-medium text-bg md:h-9">
                Resend
              </button>
              <button type="button" disabled={pending} onClick={() => duplicate(s.id)} className="h-11 rounded-full px-3 text-[13px] text-muted hover:text-fg disabled:opacity-50 md:h-9" title={s.kind === "monthly" ? "A draft for the next month" : "A draft for the period after this one"}>
                {s.kind === "monthly" ? "Duplicate for next month" : "Duplicate for next week"}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {item && (
        <ResendSheet
          key={item.id}
          item={item}
          onDone={(text) => {
            setNote({ ok: true, text });
            closeThen(() => router.refresh(), "resend");
          }}
        />
      )}
    </div>
  );
}

/** Send it again: the same PDF and message, by the channel (or both) and to the people picked now */
function ResendSheet({ item, onDone }: { item: HistoryItem; onDone: (note: string) => void }) {
  const [options, setOptions] = useState<DeliveryOptions | null>(null);
  const [value, setValue] = useState<Delivery | null>(null);
  const [extra, setExtra] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, go] = useTransition();
  useEffect(() => {
    let live = true;
    void deliveryForSend(item.id).then((r) => {
      if (!live) return;
      if (!r.ok) return setError(r.error);
      setOptions(r.options);
      setValue(r.options.initial);
    });
    return () => {
      live = false;
    };
  }, [item.id]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && closeThen(() => {}, "resend");
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, []);
  const blocked = !value || !options || (value.channels.includes("slack") && !options.slackChannel) || (value.channels.includes("email") && (!value.recipients.length || !options.emailReady));
  const send = () =>
    value &&
    go(async () => {
      setError(null);
      const r = await resendReport(item.id, value, extra);
      if (!r.ok) return setError(r.error);
      onDone(r.note);
    });

  return (
    <Layer>
      <div className="fixed inset-0 z-50 flex items-end justify-center md:items-center">
        <button type="button" aria-label="Close" onClick={() => closeThen(() => {}, "resend")} className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" />
        <div role="dialog" aria-modal="true" aria-label="Resend this report" className="relative grid max-h-[92dvh] w-full gap-4 overflow-y-auto rounded-t-[24px] border border-line bg-surface p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-[0_-20px_80px_-30px_rgba(0,0,0,0.7)] md:max-w-lg md:rounded-[24px] md:pb-5">
          <span aria-hidden className="mx-auto h-1 w-10 rounded-full bg-line md:hidden" />
          <div className="grid gap-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-brand-text">Resend</p>
            <h2 className="font-heading text-[22px] leading-tight">{item.client}</h2>
            <p className="text-sm text-muted">
              {item.periodLabel} · first went by {channelsLabel(item.channels).toLowerCase()}. The same PDF and message go again.
            </p>
          </div>
          {!options || !value ? (
            error ? <p className="text-sm text-bad">{error}</p> : <p className="flex items-center gap-2 text-sm text-faint"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" /> Loading their contacts…</p>
          ) : (
            <>
              <DeliveryPicker value={value} onChange={setValue} options={options} disabled={pending} />
              {value.channels.includes("email") && (
                <label className="grid gap-1.5">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">A line for the email (optional)</span>
                  <textarea value={extra} onChange={(e) => setExtra(e.target.value)} rows={2} maxLength={600} placeholder="e.g. Resending in case this got buried." className="resize-none rounded-[12px] border border-line bg-bg px-3 py-2 text-sm outline-none [field-sizing:content] focus:border-brand-text/60" />
                </label>
              )}
              {error && <p className="rounded-[12px] bg-bad-soft px-3 py-2 text-sm text-bad">{error}</p>}
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button type="button" onClick={() => closeThen(() => {}, "resend")} className="h-12 rounded-full px-4 text-sm text-muted hover:text-fg md:h-10">
                  Cancel
                </button>
                <button type="button" disabled={pending || blocked} onClick={send} className="h-12 rounded-full bg-brand px-5 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-40 md:h-10">
                  {pending ? "Sending…" : `Send again by ${channelsLabel(value.channels).toLowerCase()}`}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </Layer>
  );
}
