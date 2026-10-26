"use client";

import { useMemo, useState, useTransition } from "react";
import { explainMoved, moveLaunched, type LaunchView } from "./launch-actions";

// After a launch: the buyer can move the ads to where they belong (an existing ad set, a new one copied from one, or a
// brand-new campaign built like one; Kaizen Ads makes the ads there, paused, and archives the old ones), or explain a
// move they made by hand in Ads Manager. Either way the reason becomes a rule the launcher reads first for this
// client next time.

const field = "h-10 w-full rounded-[10px] border border-line bg-bg px-3 text-sm text-fg outline-none transition-colors focus:border-[#0866ff]/60 max-md:h-11";
type Adset = NonNullable<LaunchView["plan"]>["options"]["adsets"][number];
type Mode = "existing" | "clone" | "campaign";

const MODES: [Mode, string, string][] = [
  ["existing", "Existing ad set", "Into an ad set that's already there"],
  ["clone", "New ad set", "A copy of the ad set you pick, in its campaign"],
  ["campaign", "New campaign", "Built like the ad set you pick: same objective, targeting, pixel"],
];

/** Every campaign and ad set, searchable: type to narrow by either name; grouped by campaign, the current one marked. */
function AdsetPicker({ adsets, value, current, onPick }: { adsets: Adset[]; value: string; current: string | undefined; onPick: (id: string) => void }) {
  const [q, setQ] = useState("");
  const groups = useMemo(() => {
    const t = q.trim().toLowerCase();
    const hits = adsets.filter((a) => !t || a.name.toLowerCase().includes(t) || a.campaign.toLowerCase().includes(t));
    const by = new Map<string, Adset[]>();
    for (const a of hits) by.set(a.campaign, [...(by.get(a.campaign) ?? []), a]);
    return [...by].sort((a, b) => b[1].reduce((n, x) => n + x.spend14, 0) - a[1].reduce((n, x) => n + x.spend14, 0));
  }, [q, adsets]);
  return (
    <div className="grid gap-2">
      <div className="flex h-11 items-center gap-2.5 rounded-[12px] border border-line bg-bg px-3.5 transition-colors focus-within:border-[#0866ff]/60">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0 text-faint" aria-hidden>
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.5-3.5" />
        </svg>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${adsets.length} ad sets and their campaigns`} className="h-full min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-faint" />
        {q && (
          <button type="button" onClick={() => setQ("")} className="text-xs text-faint hover:text-fg">
            Clear
          </button>
        )}
      </div>
      <div className="grid max-h-72 gap-3 overflow-y-auto overscroll-contain rounded-[12px] border border-line bg-bg/40 p-2 [scrollbar-width:thin]">
        {groups.length === 0 && <p className="px-2 py-4 text-center text-xs text-faint">Nothing matches &ldquo;{q}&rdquo;</p>}
        {groups.map(([campaign, list]) => (
          <div key={campaign} className="grid gap-0.5">
            <p className="truncate px-2 pb-0.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-faint">{campaign}</p>
            {list.map((a) => {
              const on = a.id === value;
              const here = a.id === current;
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => onPick(a.id)}
                  className={`flex min-h-11 items-center gap-2.5 rounded-[10px] px-2.5 text-left transition-colors ${on ? "bg-[#0866ff]/15 ring-1 ring-[#0866ff]/50" : "hover:bg-white/[0.04]"}`}
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${a.status === "ACTIVE" ? "bg-ok" : "bg-faint/50"}`} title={a.status === "ACTIVE" ? "On" : "Paused"} />
                  <span className="grid min-w-0 flex-1">
                    <span className={`truncate text-sm ${on ? "text-fg" : "text-muted"}`}>{a.name}</span>
                    <span className="truncate text-[11px] text-faint">
                      {a.status === "ACTIVE" ? "On" : "Paused"}
                      {a.spend14 ? ` · $${a.spend14.toLocaleString()} in 14 days` : ""}
                      {a.optimization ? ` · ${a.optimization.toLowerCase().replace(/_/g, " ")}` : ""}
                    </span>
                  </span>
                  {here && <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] text-faint">Now here</span>}
                  {on && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#7aa7ff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
                      <path d="M5 12l5 5L19 7" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

export function LaunchMove({ l, onDone }: { l: LaunchView; onDone: () => void }) {
  const p = l.plan;
  const current = (l.result as { adsetId?: string } | null)?.adsetId;
  const all = p?.options.allAdsets ?? p?.options.adsets ?? [];
  const here = all.find((a) => a.id === current);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("existing");
  const [adsetId, setAdsetId] = useState("");
  const [name, setName] = useState("");
  const [campaign, setCampaign] = useState("");
  const [budget, setBudget] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // Into an existing ad set: anywhere but where it is. A copy or a new campaign can start from any one, this one too
  const choices = mode === "existing" ? all.filter((a) => a.id !== current) : all;
  const picked = all.find((a) => a.id === adsetId);
  const ready = Boolean(adsetId) && reason.trim() && (mode !== "clone" || name.trim()) && (mode !== "campaign" || (campaign.trim() && name.trim()));

  // Moved by hand in Ads Manager: one line on why
  if (l.pendingMove)
    return (
      <div className="grid gap-2.5 rounded-[14px] border border-warn/40 bg-warn/[0.06] p-4">
        <p className="text-sm">
          You moved {l.result?.ads.length === 1 ? "this ad" : "these ads"} in Ads Manager from <span className="font-medium">&ldquo;{l.pendingMove.from.name}&rdquo;</span> to{" "}
          <span className="font-medium">&ldquo;{l.pendingMove.to.name}&rdquo;</span>. Why there? The launcher places this client&apos;s next ads by it.
        </p>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="e.g. New statics always start in the CBO testing ad set, never cold prospecting" className="rounded-[10px] border border-line bg-bg px-3 py-2 text-sm outline-none focus:border-[#0866ff]/60" />
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={pending || !reason.trim()}
            onClick={() =>
              start(async () => {
                const r = await explainMoved(l.id, reason);
                if (!r.ok) return setError(r.error);
                onDone();
              })
            }
            className="h-9 rounded-full bg-fg px-4 text-sm font-medium text-bg disabled:opacity-50 max-md:h-11 max-md:flex-1"
          >
            {pending ? "Saving…" : "Save the reason"}
          </button>
          {error && <span className="text-sm text-bad">{error}</span>}
        </div>
      </div>
    );

  return (
    <div className="grid gap-3">
      {l.moves.length > 0 && (
        <ul className="grid gap-1.5">
          {l.moves.map((m, i) => (
            <li key={i} className="rounded-[12px] bg-white/[0.03] px-3.5 py-2.5 text-xs text-muted">
              <span className="text-fg">
                Moved from &ldquo;{m.from.name}&rdquo; to &ldquo;{m.to.name}&rdquo;
              </span>
              {m.via === "ads_manager" ? " in Ads Manager" : ""} · {new Date(m.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              <span className="block pt-0.5 italic text-faint">&ldquo;{m.reason}&rdquo; · learned for this client</span>
            </li>
          ))}
        </ul>
      )}
      {done && <p className="text-sm text-ok">✓ Moved to &ldquo;{done}&rdquo;, paused. The old {l.result?.ads.length === 1 ? "ad is" : "ads are"} archived, and the launcher will place this client&apos;s next ads by your reason.</p>}

      {!open ? (
        all.length > 0 &&
        l.canLaunch && (
          <button type="button" onClick={() => setOpen(true)} className="w-fit text-xs text-muted underline-offset-2 hover:text-fg hover:underline max-md:-my-2 max-md:py-3">
            Wrong ad set? Move it
          </button>
        )
      ) : (
        <div className="grid gap-4 rounded-[16px] border border-line bg-bg/40 p-4">
          {/* Where it is now */}
          <div className="grid gap-0.5 rounded-[12px] bg-white/[0.03] px-3.5 py-2.5">
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-faint">Now in</p>
            <p className="truncate text-sm">
              <span className="text-muted">{here?.campaign ?? "Its campaign"}</span>
              <span className="mx-1.5 text-faint">›</span>
              <span className="text-fg">{here?.name ?? "the ad set it launched in"}</span>
            </p>
          </div>

          {/* How */}
          <div className="grid gap-1.5 sm:grid-cols-3">
            {MODES.map(([m, label, hint]) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setMode(m);
                  if (m === "existing" && adsetId === current) setAdsetId("");
                }}
                className={`grid gap-0.5 rounded-[12px] border px-3 py-2.5 text-left transition-colors max-md:min-h-12 ${mode === m ? "border-[#0866ff]/60 bg-[#0866ff]/10" : "border-line hover:border-faint"}`}
              >
                <span className="text-sm font-medium">{label}</span>
                <span className="text-[11px] leading-snug text-faint">{hint}</span>
              </button>
            ))}
          </div>

          <div className="grid gap-1.5">
            <p className="text-[11px] uppercase tracking-[0.14em] text-faint">{mode === "existing" ? "Move into" : "Copy the setup from"}</p>
            <AdsetPicker adsets={choices} value={adsetId} current={current} onPick={setAdsetId} />
          </div>

          {mode === "clone" && <input value={name} onChange={(e) => setName(e.target.value)} placeholder={picked ? `New ad set name, e.g. ${picked.name} | New` : "New ad set name"} className={field} />}
          {mode === "campaign" && (
            <div className="grid gap-2 sm:grid-cols-2">
              <input value={campaign} onChange={(e) => setCampaign(e.target.value)} placeholder="New campaign name, e.g. Kaizen | Sales | Fall offer" className={`${field} sm:col-span-2`} />
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ad set name" className={field} />
              <label className="flex h-10 items-center gap-2 rounded-[10px] border border-line bg-bg px-3 text-sm focus-within:border-[#0866ff]/60 max-md:h-11">
                <span className="text-faint">$</span>
                <input value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^\d.]/g, ""))} inputMode="decimal" placeholder="Daily budget (else the copied one)" className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint" />
              </label>
              <p className="text-[11px] text-faint sm:col-span-2">Created paused, with the objective and special ad category of the ad set picked, and a copy of it (targeting, pixel, optimization) as its ad set.</p>
            </div>
          )}

          <label className="grid gap-1 text-[11px] uppercase tracking-[0.14em] text-faint">
            Why there
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="One line the launcher can follow next time, e.g. Offer ads go in the Sales CBO, not the evergreen prospecting ad set"
              className="rounded-[10px] border border-line bg-bg px-3 py-2 text-sm normal-case tracking-normal text-fg outline-none focus:border-[#0866ff]/60"
            />
          </label>
          <p className="text-[11px] text-faint">The same creative is used (nothing uploaded again); the new ad is paused and the old one archived, so it can still be found in Meta.</p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={pending || !ready}
              onClick={() =>
                start(async () => {
                  setError(null);
                  const r = await moveLaunched(
                    l.id,
                    { adsetId, mode, newAdsetName: mode !== "existing" ? name : null, newCampaignName: mode === "campaign" ? campaign : null, dailyBudget: mode === "campaign" && budget ? Number(budget) : null },
                    reason,
                  );
                  if (!r.ok) return setError(r.error);
                  setDone(r.to);
                  setOpen(false);
                  setReason("");
                  onDone();
                })
              }
              className="h-10 rounded-full bg-[#0866ff] px-5 text-sm font-medium text-white disabled:opacity-50 max-md:h-11 max-md:flex-1"
            >
              {pending ? (mode === "campaign" ? "Creating and moving…" : "Moving…") : mode === "campaign" ? "Create the campaign and move it" : mode === "clone" ? "Create the ad set and move it" : "Move it"}
            </button>
            <button type="button" onClick={() => setOpen(false)} className="h-10 px-3 text-sm text-faint hover:text-fg max-md:h-11 max-md:px-4">
              Cancel
            </button>
            {error && <span className="text-sm text-bad">{error}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
