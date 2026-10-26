"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { PlannedOp } from "@/lib/ad-changes";
import { applyPlanned, changeFor, discardPlanned, loadChange, planFrom, type ChangeView } from "./change-actions";

// "Make this change in Google Ads / Meta" on an audit action or a sprint move: the buyer agent turns it into the exact
// changes (from the account's live setup), the platform checks each one without applying it (a dry run), and someone
// allowed confirms. Meta writes also pass the sandbox switch in Settings.

type From = { source: "audit"; auditId: string; index: number } | { source: "sprint"; actionId: string };

const money = (n: number | null) => (n == null ? "not set" : `$${n.toFixed(2)}`);

type Platform = "google" | "meta";
/** Each platform's name and colors (Google blue; Meta blue, a touch deeper) */
const P: Record<Platform, { name: string; full: string; head: string; border: string; panel: string; text: string; button: string; spin: string }> = {
  google: { name: "Google", full: "Google Ads", head: "the Head of Google", border: "border-[#4285f4]/40 hover:bg-[#4285f4]/10", panel: "border-[#4285f4]/30 bg-[#4285f4]/[0.05]", text: "text-[#8ab4f8]", button: "bg-[#4285f4]", spin: "border-[#8ab4f8]" },
  meta: { name: "Meta", full: "Meta", head: "the Head of Meta", border: "border-[#0866ff]/45 hover:bg-[#0866ff]/10", panel: "border-[#0866ff]/35 bg-[#0866ff]/[0.06]", text: "text-[#7aa7ff]", button: "bg-[#0866ff]", spin: "border-[#7aa7ff]" },
};

function Line({ op, platform }: { op: PlannedOp; platform: Platform }) {
  const [what, from, to] = (() => {
    switch (op.kind) {
      case "campaign_status":
        return [`Campaign "${op.campaign}"`, op.from.toLowerCase(), op.to === "PAUSED" ? "paused" : "on"];
      case "ad_group_status":
        return [`Ad group "${op.adGroup}" · ${op.campaign}`, op.from.toLowerCase(), op.to === "PAUSED" ? "paused" : "on"];
      case "campaign_budget":
        return [`Daily budget · "${op.campaign}"`, money(op.from), money(op.to)];
      case "target_cpa":
        return [`Target CPA · "${op.campaign}"`, money(op.from), money(op.to)];
      case "target_roas":
        return [`Target ROAS · "${op.campaign}"`, op.from == null ? "not set" : `${Math.round(op.from * 100)}%`, `${Math.round(op.to * 100)}%`];
      case "negative_keywords":
        return [`Negative keywords · "${op.campaign}"`, null, op.keywords.map((k) => (k.match === "EXACT" ? `[${k.text}]` : k.match === "PHRASE" ? `"${k.text}"` : k.text)).join(", ")];
      case "meta_status":
        return [`${op.level === "adset" ? "Ad set" : op.level === "ad" ? "Ad" : "Campaign"} "${op.name}"${op.parent ? ` · ${op.parent}` : ""}`, op.from === "ACTIVE" ? "on" : op.from.toLowerCase(), op.to === "PAUSED" ? "paused" : "on"];
      case "meta_budget":
        return [`Daily budget · ${op.level === "adset" ? "ad set" : "campaign"} "${op.name}"`, money(op.from), money(op.to)];
    }
  })();
  const state = op.result ? (op.result.ok ? "applied" : "refused") : op.check ? (op.check.ok ? "checked" : "won't go through") : null;
  const tone = op.result?.ok ? "text-ok" : op.result || op.check?.ok === false ? "text-bad" : "text-ok";
  return (
    <li className="grid gap-1 rounded-[12px] border border-line bg-bg/50 px-3.5 py-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="min-w-0 break-words text-sm">{what}</span>
        {state && <span className={`text-[11px] ${tone}`}>{state === "checked" ? `✓ ${P[platform].name} says it'll go through` : state === "applied" ? "✓ Applied" : `× ${state}`}</span>}
      </div>
      <p className="break-words text-sm">
        {from != null && (
          <>
            <span className="text-faint line-through decoration-faint/60">{from}</span>
            <span className="mx-1.5 text-faint">→</span>
          </>
        )}
        <span className="font-medium">{to}</span>
      </p>
      {op.why && <p className="text-[11px] text-faint">{op.why}</p>}
      {op.warning && <p className="text-[11px] text-warn">{op.warning}</p>}
      {(op.result?.error || op.check?.error) && <p className="text-[11px] text-bad">{op.result?.error ?? op.check?.error}</p>}
    </li>
  );
}

export function GoogleChange({ from, disabled, platform = "google" }: { from: From; disabled?: boolean; platform?: Platform }) {
  const p = P[platform];
  const router = useRouter();
  const [c, setC] = useState<ChangeView | null>(null);
  const [open, setOpen] = useState(false);
  // The last change planned from this action, if there is one (one under way opens)
  const key = from.source === "audit" ? `${from.auditId}:${from.index}` : from.actionId;
  useEffect(() => {
    let live = true;
    void changeFor(from).then((x) => {
      if (!live || !x) return;
      setC(x);
      if (["planning", "ready", "applying", "partial", "failed"].includes(x.status)) setOpen(true);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const busy = c?.status === "planning" || c?.status === "applying";

  // While the plan is being written (or applied), follow it
  useEffect(() => {
    if (!c || !busy) return;
    const t = setInterval(async () => {
      const next = await loadChange(c.id);
      if (next) setC(next);
    }, 3000);
    return () => clearInterval(t);
  }, [c, busy]);

  const plan = () =>
    start(async () => {
      setError(null);
      setOpen(true);
      const r = await planFrom(from);
      if (!r.ok) return setError(r.error);
      setC(await loadChange(r.id));
    });
  const apply = () =>
    start(async () => {
      if (!c) return;
      setConfirm(false);
      setError(null);
      setC({ ...c, status: "applying" });
      const r = await applyPlanned(c.id);
      if (!r.ok) setError(r.error);
      setC(await loadChange(c.id));
      router.refresh();
    });
  const discard = () =>
    start(async () => {
      if (!c) return;
      await discardPlanned(c.id);
      setC(null);
      setOpen(false);
    });

  if (!open || !c)
    return (
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={disabled || pending} onClick={plan} className={`inline-flex min-h-[40px] items-center gap-1.5 rounded-full border px-3 py-2 text-left text-xs disabled:opacity-50 md:min-h-0 md:px-2.5 md:py-0.5 md:text-[11px] ${p.border} ${p.text}`}>
          <span aria-hidden>⚡</span>
          {pending ? "Planning…" : c?.status === "applied" ? `Applied in ${p.full} · plan again` : `Make this change in ${p.full}`}
        </button>
        {c?.status === "applied" && !open && (
          <button type="button" onClick={() => setOpen(true)} className="py-2 text-[11px] text-faint hover:text-fg md:py-0">
            See what was applied
          </button>
        )}
        {error && <span className="text-[11px] text-bad">{error}</span>}
      </div>
    );

  const ready = c.ops.filter((o) => o.check?.ok && !o.result?.ok);
  return (
    <div className={`grid min-w-0 gap-3 rounded-[14px] border p-3.5 md:p-4 ${p.panel}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${p.text}`}>Change in {p.full}</p>
        <button type="button" onClick={() => setOpen(false)} className="-my-2 py-2 pl-3 text-[11px] text-faint hover:text-fg md:my-0 md:py-0 md:pl-0">
          Hide
        </button>
      </div>

      {c.status === "planning" && (
        <p className="flex items-center gap-2 text-sm text-muted">
          <span className={`h-3.5 w-3.5 animate-spin rounded-full border-2 border-t-transparent ${p.spin}`} />
          Reading the account and working out the exact changes…
        </p>
      )}
      {c.note && c.status !== "planning" && <p className="text-sm leading-relaxed text-muted">{c.note}</p>}
      {c.ops.length > 0 && (
        <ul className="grid gap-2">
          {c.ops.map((op, i) => (
            <Line key={i} op={op} platform={platform} />
          ))}
        </ul>
      )}
      {c.status === "failed" && c.error && <p className="text-sm text-bad">{c.error}</p>}
      {(c.status === "applied" || c.status === "partial") && c.appliedBy && (
        <p className="text-[11px] text-faint">
          Applied by {c.appliedBy}
          {c.appliedAt ? ` · ${new Date(c.appliedAt).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}. It shows in the account&apos;s change history after the next sync.
        </p>
      )}

      {confirm && (
        <div className="grid gap-2 rounded-[12px] border border-warn/40 bg-warn-soft px-4 py-3 text-sm">
          <p>
            This changes the live {p.full} account right away: {ready.length} {ready.length === 1 ? "change" : "changes"}. They can be undone in {p.full} or with another change here.
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={apply} disabled={pending} className="h-11 flex-1 rounded-full bg-fg px-4 text-xs text-bg disabled:opacity-60 md:h-8 md:flex-none">
              Yes, apply in {p.full}
            </button>
            <button type="button" onClick={() => setConfirm(false)} className="h-11 rounded-full border border-line bg-surface px-4 text-xs text-muted hover:text-fg md:h-8 md:px-3">
              Not yet
            </button>
          </div>
        </div>
      )}

      {!confirm && (
        <div className="flex flex-wrap items-center gap-2">
          {(c.status === "ready" || c.status === "partial") && ready.length > 0 &&
            (c.canApply ? (
              <button type="button" onClick={() => setConfirm(true)} disabled={pending} className={`h-11 w-full rounded-full px-4 text-sm font-medium text-white hover:brightness-110 disabled:opacity-60 sm:w-auto md:h-9 ${p.button}`}>
                Apply {ready.length} {ready.length === 1 ? "change" : "changes"}
              </button>
            ) : (
              <span className="text-xs text-faint">The account&apos;s buyer, {p.head} or an exec can apply these.</span>
            ))}
          {c.status === "applying" && (
            <span className="flex items-center gap-2 text-sm text-muted">
              <span className={`h-3.5 w-3.5 animate-spin rounded-full border-2 border-t-transparent ${p.spin}`} />
              Applying…
            </span>
          )}
          {!busy && (
            <button type="button" onClick={plan} disabled={pending || disabled} className="h-11 rounded-full border border-line px-4 text-sm text-muted hover:text-fg disabled:opacity-60 md:h-9">
              Plan it again
            </button>
          )}
          {["ready", "nothing", "failed"].includes(c.status) && (
            <button type="button" onClick={discard} disabled={pending} className="h-11 px-3 text-sm text-faint hover:text-fg md:h-9 md:px-2">
              Discard
            </button>
          )}
          {error && <span className="text-xs text-bad">{error}</span>}
        </div>
      )}
    </div>
  );
}
