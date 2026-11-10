"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import type { ClientNoticesCard } from "@/lib/approval-notices";

type Result = { ok: true } | { ok: false; error: string };

const KIND: Record<ClientNoticesCard["recent"][number]["kind"], string> = {
  ready: "Ready for review",
  remind_24: "Reminder · 24 business hours",
  remind_48: "Reminder · 48 business hours",
  escalated: "To customer success",
  auto_approved: "Approved automatically",
};

const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
const where = (channels: string[]) => channels.map((c) => (c === "slack" ? "Slack" : c === "email" ? "Email" : "Team")).join(" · ");

/**
 * Client notifications on Team & setup: the exec switch (off by default), whether notices really reach them (every
 * switch and somewhere to send), the last posts and reminders, and what's coming for each ticket with them.
 */
export function ClientNoticesPanel({ data, canEdit, toggle }: { data: ClientNoticesCard; canEdit: boolean; toggle: (on: boolean) => Promise<Result> }) {
  const [on, setOn] = useState(data.on);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const reaches = on && data.portalLive && (data.globalOn || data.sandbox);
  // What still stops it, in plain words
  const blockers = [
    !data.portalLive && "their portal is off",
    !data.globalOn && !data.sandbox && "client outreach is on hold for every client (Settings)",
    !data.slack && !data.contacts && "they have no Slack channel and no portal contact",
  ].filter(Boolean) as string[];
  return (
    <div className="grid min-w-0 gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <span className={`inline-flex min-h-7 w-fit items-center gap-2 rounded-full px-3 text-[12.5px] font-medium ${reaches ? "bg-ok-soft text-ok" : on ? "bg-warn-soft text-warn" : "bg-surface-2 text-muted"}`}>
            <span className={`h-2 w-2 rounded-full ${reaches ? "bg-ok" : on ? "bg-warn" : "bg-faint"}`} />
            {reaches ? "On: they hear about new creative" : on ? "On, but held" : "Off"}
          </span>
          {data.by && data.at && (
            <span className="text-[12px] text-faint">
              {on ? "Switched on" : "Switched off"} by {data.by} · {new Date(data.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
            </span>
          )}
        </div>
        {canEdit && (
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              if (!on && !confirm("Switch on client notifications? When their portal is live they get a Slack post and email for new creative, and reminders at 24 and 48 business hours.")) return;
              start(async () => {
                const r = await toggle(!on);
                if (r.ok) {
                  setOn(!on);
                  setError(null);
                } else setError(r.error);
              });
            }}
            className={`min-h-11 w-full rounded-full px-5 text-[14px] font-medium disabled:opacity-60 sm:w-auto ${on ? "border border-line text-muted hover:text-fg" : "bg-brand text-white hover:bg-brand-hover"}`}
          >
            {pending ? "Saving…" : on ? "Switch off" : "Switch on"}
          </button>
        )}
      </div>
      {error && <p className="text-[12.5px] text-bad">{error}</p>}
      <p className="text-[13px] leading-relaxed text-muted">
        New creative in &ldquo;With client&rdquo; gets one short post in their Slack channel and an email to their portal contacts (one per batch, at most once a day). No decision after 24 business hours: a gentle reminder; after 48: a second one, and it goes to customer success&rsquo;s Waiting on the client list.
        {data.optedIn ? " They opted into auto-approval, so what waits 48 business hours is approved for them instead." : ""}
        {data.whiteLabel ? " White label: nothing they get names Kaizen or links to it." : ""}
      </p>
      {on && blockers.length > 0 && <p className="rounded-[12px] border border-warn/35 bg-warn-soft/40 px-3 py-2 text-[12.5px] leading-relaxed text-fg">Nothing reaches them yet: {blockers.join("; ")}.</p>}
      <div className="flex flex-wrap gap-2 text-[12px] text-muted">
        <span className={`rounded-full px-2.5 py-1 ${data.slack ? "bg-ok-soft text-ok" : "bg-surface-2"}`}>{data.slack ? "Slack channel linked" : "No Slack channel"}</span>
        <span className={`rounded-full px-2.5 py-1 ${data.contacts ? "bg-ok-soft text-ok" : "bg-surface-2"}`}>
          {data.contacts} portal {data.contacts === 1 ? "contact" : "contacts"}
        </span>
        <span className={`rounded-full px-2.5 py-1 ${data.optedIn ? "bg-ok-soft text-ok" : "bg-surface-2"}`}>{data.optedIn ? "Auto-approval opted in" : "No auto-approval"}</span>
      </div>

      {data.pending.length > 0 && (
        <div className="grid gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">With them now</p>
          <ul className="grid divide-y divide-line overflow-hidden rounded-[14px] border border-line">
            {data.pending.map((p) => (
              <li key={p.number}>
                <Link href={`/board?t=${p.number}`} className="grid min-h-11 gap-0.5 px-3.5 py-2.5 transition-colors hover:bg-surface-2">
                  <span className="truncate text-[13.5px]">
                    <span className="tabular text-faint">#{p.number}</span> {p.title}
                  </span>
                  <span className="text-[12px] text-faint">
                    {p.told ? `Told ${when(p.told)}` : `With them since ${when(p.since)}`}
                    {p.next ? ` · ${p.next.what} ${p.next.what === "Ready post" ? "on the next run" : when(p.next.at)}` : " · Nothing more to send"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Last notices</p>
        {data.recent.length ? (
          <ul className="grid gap-2">
            {data.recent.map((r, i) => (
              <li key={i} className="grid gap-0.5 rounded-[12px] bg-surface-2/60 px-3.5 py-2.5">
                <span className="flex flex-wrap items-center gap-x-2 text-[13px]">
                  <span className={r.status === "held" ? "text-warn" : "text-fg"}>{KIND[r.kind]}</span>
                  {r.number && <span className="tabular text-[12px] text-faint">#{r.number}</span>}
                  <span className="text-[12px] text-faint">
                    {when(r.at)}
                    {r.channels.length ? ` · ${where(r.channels)}` : ""}
                    {r.status === "held" ? " · couldn't reach them" : ""}
                  </span>
                </span>
                {r.detail && r.kind !== "escalated" && r.kind !== "auto_approved" && <span className="line-clamp-2 break-words text-[12px] text-muted">{r.detail}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-faint">Nothing sent yet.</p>
        )}
      </div>
    </div>
  );
}
