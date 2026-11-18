"use client";

import { useState } from "react";
import type { SocialMetrics } from "@/lib/channel-reports/core";
import { CARD_NOTE_MAX, OVERRIDE_KEYS, OVERRIDE_LABEL, overrideLine, TEAM_NOTE_MAX, teamFindingsOf, withTeamFindings, type MetricOverride, type OverrideKey } from "@/lib/channel-reports/social-notes";
import { socialInsights } from "@/lib/channel-reports/social-report";
import type { Sections } from "@/lib/reports/write";

// The social report studio's "Team notes and figures": where the strategist adds what the numbers can't say (a note on the
// report, one on each takeaway) and the figures Meta didn't report for the period. Everything here is printed on the report
// and the live page as the team's own, and the AI writer reads it but never rewrites it. Saved when a field is left.

const field = "w-full resize-none rounded-[10px] border border-line bg-bg px-3 py-2 text-[13.5px] outline-none [field-sizing:content] focus:border-brand-text/60 disabled:opacity-60";

/** Which figures Meta left out of the period (so the form offers those first) */
export function missingKeys(m: SocialMetrics): OverrideKey[] {
  const n = m.now;
  const out: OverrideKey[] = [];
  if (!n.reach) out.push("reach");
  if (!n.views) out.push("views");
  if (n.interactions == null) out.push("interactions");
  if (!n.followers) out.push("followers");
  return out;
}

export function SocialTeamPanel({ m, sections, setSections, me, disabled }: { m: SocialMetrics; sections: Sections; setSections: (s: Sections) => void; me: string; disabled?: boolean }) {
  const f = teamFindingsOf(sections);
  const cards = socialInsights(withTeamFindings(m, sections), sections);
  const missing = missingKeys(m);
  const free = OVERRIDE_KEYS.filter((k) => !f.overrides.some((o) => o.key === k));
  const [key, setKey] = useState<OverrideKey>(missing.find((k) => free.includes(k)) ?? free[0] ?? "reach");
  const [value, setValue] = useState("");
  const [why, setWhy] = useState("");
  const count = (f.notes ? 1 : 0) + f.cards.filter(Boolean).length + f.overrides.length;

  const setCard = (i: number, text: string) => {
    const next = Array.from({ length: Math.max(cards.length, f.cards.length) }, (_, j) => (j === i ? text : (sections.cardNotes?.[j] ?? "")));
    setSections({ ...sections, cardNotes: next.some((x) => x.trim()) ? next : [] });
  };
  const addFigure = () => {
    const n = Math.round(Number(value.replace(/[,\s]/g, "")));
    if (!Number.isFinite(n) || n < 0 || value.trim() === "") return;
    const entry: MetricOverride = { key, value: n, by: me, at: new Date().toISOString(), ...(why.trim() ? { why: why.trim() } : {}) };
    setSections({ ...sections, overrides: [...(sections.overrides ?? []).filter((o) => o.key !== key), entry] });
    setValue("");
    setWhy("");
  };

  return (
    <details className="group rounded-[12px] border border-line" open={count > 0 || undefined}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 text-[12.5px] [&::-webkit-details-marker]:hidden">
        <span className="text-muted">
          <span className="text-fg">Team notes and figures</span>
          {count > 0 ? ` · ${count} added` : missing.length ? ` · Meta didn't report ${missing.map((k) => OVERRIDE_LABEL[k].toLowerCase()).join(", ")}` : ""}
        </span>
        <span aria-hidden className="text-faint transition-transform group-open:rotate-90">
          ›
        </span>
      </summary>
      <div className="grid gap-4 border-t border-line p-3">
        <label className="grid gap-1.5">
          <span className="text-[12px] font-medium text-fg">Note on the report</span>
          <span className="text-[11.5px] leading-snug text-faint">Printed on the report and the live page as the team&apos;s notes. The writer reads it and works it in, and never changes it.</span>
          <textarea key={sections.teamNotes ?? ""} defaultValue={sections.teamNotes ?? ""} disabled={disabled} rows={3} maxLength={TEAM_NOTE_MAX} placeholder="What you know that the numbers don't show: a campaign, a trend, why a post worked, what the client said" className={field} onBlur={(e) => e.currentTarget.value !== (sections.teamNotes ?? "") && setSections({ ...sections, teamNotes: e.currentTarget.value })} />
        </label>

        {cards.length > 0 && (
          <div className="grid gap-2">
            <p className="text-[12px] font-medium text-fg">Notes on the takeaways</p>
            {cards.map((c, i) => (
              <label key={`${i}-${c.title}`} className="grid gap-1">
                <span className="text-[11.5px] text-muted">{c.title}</span>
                <textarea key={sections.cardNotes?.[i] ?? ""} defaultValue={sections.cardNotes?.[i] ?? ""} disabled={disabled} rows={1} maxLength={CARD_NOTE_MAX} placeholder="Add your note to this card" className={field} onBlur={(e) => e.currentTarget.value !== (sections.cardNotes?.[i] ?? "") && setCard(i, e.currentTarget.value)} />
              </label>
            ))}
          </div>
        )}

        <div className="grid gap-2">
          <p className="text-[12px] font-medium text-fg">Figures Meta didn&apos;t report</p>
          <p className="text-[11.5px] leading-snug text-faint">Enter a figure for this period and the rate is worked out again from it. The report says it was entered by the team.</p>
          {f.overrides.map((o) => (
            <div key={o.key} className="flex items-center justify-between gap-2 rounded-[10px] bg-surface-2 px-3 py-2 text-[12.5px]">
              <span className="min-w-0 [overflow-wrap:anywhere]">{overrideLine(o)}</span>
              <button type="button" disabled={disabled} onClick={() => setSections({ ...sections, overrides: (sections.overrides ?? []).filter((x) => x.key !== o.key) })} className="h-9 shrink-0 rounded-full px-3 text-[12px] text-faint hover:text-bad max-md:h-11">
                Remove
              </button>
            </div>
          ))}
          {free.length > 0 && (
            <div className="flex flex-wrap items-end gap-2">
              <label className="grid gap-1 text-[11.5px] text-muted">
                Figure
                <select value={key} onChange={(e) => setKey(e.target.value as OverrideKey)} disabled={disabled} className="h-10 rounded-[10px] border border-line bg-bg px-2 text-[13px] text-fg">
                  {free.map((k) => (
                    <option key={k} value={k}>
                      {OVERRIDE_LABEL[k]}
                      {missing.includes(k) ? " (not reported)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-[11.5px] text-muted">
                Number
                <input value={value} onChange={(e) => setValue(e.target.value)} disabled={disabled} inputMode="numeric" placeholder="12,400" className="h-10 w-28 rounded-[10px] border border-line bg-bg px-3 text-[13px] text-fg outline-none focus:border-brand-text/60" />
              </label>
              <label className="grid min-w-40 flex-1 gap-1 text-[11.5px] text-muted">
                Where it came from (optional)
                <input value={why} onChange={(e) => setWhy(e.target.value)} disabled={disabled} maxLength={300} placeholder="Read from Instagram's own app" className="h-10 rounded-[10px] border border-line bg-bg px-3 text-[13px] text-fg outline-none focus:border-brand-text/60" />
              </label>
              <button type="button" onClick={addFigure} disabled={disabled || !value.trim()} className="h-10 rounded-full bg-fg px-4 text-[13px] text-bg disabled:opacity-40">
                Add
              </button>
            </div>
          )}
        </div>
      </div>
    </details>
  );
}
