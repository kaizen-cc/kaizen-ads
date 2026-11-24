"use client";

import { useState, useTransition } from "react";
import { removeRate, saveRate } from "./rate-card-actions";

// Settings › Rate card (executives): Kaizen's starting prices per service line and tier, one-time or monthly, the
// prices every proposal, quote and SOW quotes. Empty until it's filled: documents mark fees "[Price to confirm]" and
// the assistant asks. A different price agreed with one client is relationship pricing, set in the conversation.

export type Rate = { id: string; service: string; tier: string | null; label: string; cadence: "one_time" | "month"; amount: number; note: string | null };

const SERVICES = ["meta", "google", "paid_ads", "full_stack", "tiktok", "social", "creative", "email", "web", "crm", "a_la_carte", "tracking", "other"];
const field = "h-11 w-full rounded-[10px] border border-line bg-bg/60 px-3 text-[16px] text-fg outline-none transition-colors focus:border-faint md:h-9 md:text-[13px]";
const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
type Draft = { id: string | null; service: string; tier: string; label: string; cadence: "one_time" | "month"; amount: string; note: string };
const blank: Draft = { id: null, service: "meta", tier: "", label: "", cadence: "month", amount: "", note: "" };

export function RateCard({ rates }: { rates: Rate[] }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const groups = SERVICES.map((s) => ({ s, rows: rates.filter((r) => r.service === s) })).filter((g) => g.rows.length);
  const save = () =>
    draft &&
    start(async () => {
      setError(null);
      const r = await saveRate(draft);
      if (r.ok) setDraft(null);
      else setError(r.error);
    });
  return (
    <section className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <h2 className="text-[16px] font-semibold text-fg">Rate card</h2>
          <p className="max-w-2xl text-[13px] leading-snug text-muted">The starting prices proposals, quotes and SOWs quote. A different price agreed with a client is relationship pricing, confirmed in the conversation. Until a line has prices, documents mark its fees [Price to confirm] and the assistant asks.</p>
        </div>
        <button type="button" onClick={() => setDraft({ ...blank })} className="inline-flex min-h-11 items-center rounded-full bg-brand px-4 text-[13px] font-medium text-white transition hover:bg-brand-hover active:scale-[0.98] md:min-h-9">
          Add a price
        </button>
      </div>

      {draft && (
        <div className="grid gap-3 rounded-[16px] border border-line bg-surface p-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="grid gap-1 text-[12px] text-faint">
              Service line
              <select value={draft.service} onChange={(e) => setDraft({ ...draft, service: e.target.value })} className={field}>
                {SERVICES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-[12px] text-faint">
              Tier (optional)
              <input value={draft.tier} onChange={(e) => setDraft({ ...draft, tier: e.target.value })} placeholder="Basic" className={field} />
            </label>
            <label className="grid gap-1 text-[12px] text-faint">
              What it is
              <input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="Meta advertising management" className={field} />
            </label>
            <label className="grid gap-1 text-[12px] text-faint">
              Billed
              <select value={draft.cadence} onChange={(e) => setDraft({ ...draft, cadence: e.target.value as Draft["cadence"] })} className={field}>
                <option value="month">Monthly</option>
                <option value="one_time">One time</option>
              </select>
            </label>
            <label className="grid gap-1 text-[12px] text-faint">
              Amount ($)
              <input value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} inputMode="decimal" placeholder="1000" className={field} />
            </label>
            <label className="grid gap-1 text-[12px] text-faint">
              Note (optional)
              <input value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} placeholder="10 images and 3 videos a month" className={field} />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={save} disabled={busy} className="inline-flex min-h-11 items-center rounded-full bg-brand px-4 text-[13px] font-medium text-white transition hover:bg-brand-hover disabled:opacity-60 md:min-h-9">
              {busy ? "Saving…" : "Save"}
            </button>
            <button type="button" onClick={() => setDraft(null)} className="inline-flex min-h-11 items-center rounded-full px-3 text-[13px] text-muted hover:bg-surface-2 hover:text-fg md:min-h-9">
              Cancel
            </button>
            {error && <span className="text-[12.5px] text-bad">{error}</span>}
          </div>
        </div>
      )}

      {groups.length === 0 ? (
        <p className="rounded-[16px] border border-dashed border-line px-4 py-6 text-center text-[13px] text-muted">No prices yet. Documents mark fees [Price to confirm] until they&apos;re added.</p>
      ) : (
        <div className="grid gap-3">
          {groups.map((g) => (
            <div key={g.s} className="overflow-hidden rounded-[16px] border border-line bg-surface">
              <p className="border-b border-line px-4 py-2.5 text-[11px] font-medium uppercase tracking-[0.12em] text-faint">{g.s}</p>
              <ul className="divide-y divide-line">
                {g.rows.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                    <span className="min-w-0 flex-1 text-[14px] text-fg">
                      {r.tier ? <span className="text-muted">{r.tier} · </span> : null}
                      {r.label}
                      {r.note ? <span className="block text-[12px] text-faint">{r.note}</span> : null}
                    </span>
                    <span className="text-[14px] font-semibold tabular-nums text-fg">
                      {money(r.amount)}
                      <span className="text-[12px] font-normal text-faint">{r.cadence === "month" ? "/mo" : " one time"}</span>
                    </span>
                    <span className="flex gap-1">
                      <button type="button" onClick={() => setDraft({ id: r.id, service: r.service, tier: r.tier ?? "", label: r.label, cadence: r.cadence, amount: String(r.amount), note: r.note ?? "" })} className="inline-flex min-h-11 items-center rounded-full px-3 text-[12.5px] text-muted hover:bg-surface-2 hover:text-fg md:min-h-8">
                        Edit
                      </button>
                      <button type="button" disabled={busy} onClick={() => start(async () => void (await removeRate(r.id)))} className="inline-flex min-h-11 items-center rounded-full px-3 text-[12.5px] text-muted hover:bg-surface-2 hover:text-bad md:min-h-8">
                        Remove
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
