"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { PlannedOp } from "@/lib/ad-changes";
import { applyPlanned, changeFor, discardPlanned, loadChange, planFrom, type ChangeView } from "./change-actions";

// "Make this change in Google Ads" on an audit action or a sprint move: the Google Buyer turns it into the exact
// changes (from the account's live setup), Google checks each one without applying it, and someone allowed confirms.

type From = { source: "audit"; auditId: string; index: number } | { source: "sprint"; actionId: string };

const money = (n: number | null) => (n == null ? "not set" : `$${n.toFixed(2)}`);

function Line({ op }: { op: PlannedOp }) {
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
    }
  })();
  const state = op.result ? (op.result.ok ? "applied" : "refused") : op.check ? (op.check.ok ? "checked" : "won't go through") : null;
  const tone = op.result?.ok ? "text-ok" : op.result || op.check?.ok === false ? "text-bad" : "text-ok";
  return (
    <li className="grid gap-1 rounded-[12px] border border-line bg-bg/50 px-3.5 py-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm">{what}</span>
        {state && <span className={`text-[11px] ${tone}`}>{state === "checked" ? "✓ Google says it'll go through" : state === "applied" ? "✓ Applied" : `× ${state}`}</span>}
      </div>
      <p className="text-sm">
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

export function GoogleChange({ from, disabled }: { from: From; disabled?: boolean }) {
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
        <button type="button" disabled={disabled || pending} onClick={plan} className="inline-flex items-center gap-1.5 rounded-full border border-[#4285f4]/40 px-2.5 py-0.5 text-[11px] text-[#8ab4f8] hover:bg-[#4285f4]/10 disabled:opacity-50">
          <span aria-hidden>⚡</span>
          {pending ? "Planning…" : c?.status === "applied" ? "Applied in Google Ads · plan again" : "Make this change in Google Ads"}
        </button>
        {c?.status === "applied" && !open && (
          <button type="button" onClick={() => setOpen(true)} className="text-[11px] text-faint hover:text-fg">
            See what was applied
          </button>
        )}
        {error && <span className="text-[11px] text-bad">{error}</span>}
      </div>
    );

  const ready = c.ops.filter((o) => o.check?.ok && !o.result?.ok);
  return (
    <div className="grid gap-3 rounded-[14px] border border-[#4285f4]/30 bg-[#4285f4]/[0.05] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#8ab4f8]">Change in Google Ads</p>
        <button type="button" onClick={() => setOpen(false)} className="text-[11px] text-faint hover:text-fg">
          Hide
        </button>
      </div>

      {c.status === "planning" && (
        <p className="flex items-center gap-2 text-sm text-muted">
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#8ab4f8] border-t-transparent" />
          Reading the account and working out the exact changes…
        </p>
      )}
      {c.note && c.status !== "planning" && <p className="text-sm leading-relaxed text-muted">{c.note}</p>}
      {c.ops.length > 0 && (
        <ul className="grid gap-2">
          {c.ops.map((op, i) => (
            <Line key={i} op={op} />
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
            This changes the live Google Ads account right away: {ready.length} {ready.length === 1 ? "change" : "changes"}. They can be undone in Google Ads or with another change here.
          </p>
          <div className="flex gap-2">
            <button type="button" onClick={apply} disabled={pending} className="h-8 rounded-full bg-fg px-4 text-xs text-bg disabled:opacity-60">
              Yes, apply in Google Ads
            </button>
            <button type="button" onClick={() => setConfirm(false)} className="h-8 rounded-full border border-line bg-surface px-3 text-xs text-muted hover:text-fg">
              Not yet
            </button>
          </div>
        </div>
      )}

      {!confirm && (
        <div className="flex flex-wrap items-center gap-2">
          {(c.status === "ready" || c.status === "partial") && ready.length > 0 &&
            (c.canApply ? (
              <button type="button" onClick={() => setConfirm(true)} disabled={pending} className="h-9 rounded-full bg-[#4285f4] px-4 text-sm font-medium text-white hover:brightness-110 disabled:opacity-60">
                Apply {ready.length} {ready.length === 1 ? "change" : "changes"}
              </button>
            ) : (
              <span className="text-xs text-faint">The account&apos;s buyer, the Head of Google or an exec can apply these.</span>
            ))}
          {c.status === "applying" && (
            <span className="flex items-center gap-2 text-sm text-muted">
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#8ab4f8] border-t-transparent" />
              Applying…
            </span>
          )}
          {!busy && (
            <button type="button" onClick={plan} disabled={pending || disabled} className="h-9 rounded-full border border-line px-4 text-sm text-muted hover:text-fg disabled:opacity-60">
              Plan it again
            </button>
          )}
          {["ready", "nothing", "failed"].includes(c.status) && (
            <button type="button" onClick={discard} disabled={pending} className="h-9 px-2 text-sm text-faint hover:text-fg">
              Discard
            </button>
          )}
          {error && <span className="text-xs text-bad">{error}</span>}
        </div>
      )}
    </div>
  );
}
