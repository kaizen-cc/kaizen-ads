"use client";

import { useState, useTransition } from "react";
import { explainMoved, moveLaunched, type LaunchView } from "./launch-actions";

// After a launch: the buyer can move the ads to the ad set they belong in (Kaizen Ads makes them there and archives
// the old ones), or explain a move they made by hand in Ads Manager. Either way the reason becomes a rule the
// launcher reads first for this client next time.

const field = "h-10 w-full rounded-[10px] border border-line bg-bg px-3 text-sm text-fg outline-none transition-colors focus:border-[#0866ff]/60 max-md:h-11";

export function LaunchMove({ l, onDone }: { l: LaunchView; onDone: () => void }) {
  const p = l.plan;
  const current = (l.result as { adsetId?: string } | null)?.adsetId;
  const others = (p?.options.allAdsets ?? p?.options.adsets ?? []).filter((a) => a.id !== current);
  const [open, setOpen] = useState(false);
  const [adsetId, setAdsetId] = useState(others[0]?.id ?? "");
  const [mode, setMode] = useState<"existing" | "clone">("existing");
  const [name, setName] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();

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
        others.length > 0 &&
        l.canLaunch && (
          <button type="button" onClick={() => setOpen(true)} className="w-fit text-xs text-muted underline-offset-2 hover:text-fg hover:underline max-md:-my-2 max-md:py-3">
            Wrong ad set? Move it
          </button>
        )
      ) : (
        <div className="grid gap-3 rounded-[14px] border border-line bg-bg/40 p-4">
          <p className="text-[11px] uppercase tracking-[0.14em] text-faint">Move to</p>
          <select value={adsetId} onChange={(e) => setAdsetId(e.target.value)} className={field}>
            {[...new Set(others.map((a) => a.campaign))].map((c) => (
              <optgroup key={c} label={c}>
                {others
                  .filter((a) => a.campaign === c)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                      {a.status !== "ACTIVE" ? " (paused)" : ""}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
          <div className="flex flex-wrap gap-1.5">
            {(["existing", "clone"] as const).map((m) => (
              <button key={m} type="button" onClick={() => setMode(m)} className={`h-8 rounded-full px-3 text-xs transition-colors max-md:h-11 max-md:px-4 ${mode === m ? "bg-fg text-bg" : "border border-line text-muted hover:text-fg"}`}>
                {m === "existing" ? "Into this ad set" : "A new ad set, copied from it"}
              </button>
            ))}
          </div>
          {mode === "clone" && <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New ad set name" className={field} />}
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
              disabled={pending || !adsetId || !reason.trim() || (mode === "clone" && !name.trim())}
              onClick={() =>
                start(async () => {
                  setError(null);
                  const r = await moveLaunched(l.id, { adsetId, mode, newAdsetName: mode === "clone" ? name : null }, reason);
                  if (!r.ok) return setError(r.error);
                  setDone(r.to);
                  setOpen(false);
                  setReason("");
                  onDone();
                })
              }
              className="h-9 rounded-full bg-[#0866ff] px-4 text-sm font-medium text-white disabled:opacity-50 max-md:h-11 max-md:flex-1"
            >
              {pending ? "Moving…" : "Move it"}
            </button>
            <button type="button" onClick={() => setOpen(false)} className="h-9 px-2 text-sm text-faint hover:text-fg max-md:h-11 max-md:px-4">
              Cancel
            </button>
            {error && <span className="text-sm text-bad">{error}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
