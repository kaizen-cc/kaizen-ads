"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setCreativeTier, setEmailTier, setStrategyOnly } from "./tier-actions";

// The tier pickers in the Services panel, the one place every service's tier is set (owner, Nov 19 2026):
//   Email: 3-Month Initial Setup (its start month, then the ongoing tier), Basic, Silver, Gold, Custom (each pool's
//          numbers), or Strategy only, no deliverables.
//   Creative: a package, Custom (images and videos a month), a sprint until a day, or Strategy only.
//   Any other service: Strategy only, no deliverables, beside its tier.
// A pick saves at once; Setup, Custom and Sprint ask for their numbers first.

export type EmailTierValue = { key: string | null; setupStart: string | null; custom: Record<string, number | null> | null };

const EMAIL_TIERS: { key: "basic" | "silver" | "gold"; label: string; text: string }[] = [
  { key: "basic", label: "Basic", text: "3-5 campaigns, 2 SMS, 3-5 flow emails a month · $1,000" },
  { key: "silver", label: "Silver", text: "7-10 campaigns, 4-6 SMS, 5-7 flow emails a month · $1,750" },
  { key: "gold", label: "Gold", text: "15-20 campaigns, 6-8 SMS, 5-10 flow emails a month · $2,250" },
];
const STRATEGY = "__strategy";
const select = "max-w-full cursor-pointer truncate bg-transparent text-xs text-muted outline-none hover:text-fg max-md:min-h-10";
const box = "h-11 w-14 rounded-[8px] border border-line bg-bg px-1.5 text-center text-xs tabular outline-none focus:border-brand/60 md:h-8";
const btn = "h-10 rounded-full bg-fg px-4 text-[11px] font-medium text-bg disabled:opacity-50 md:h-7 md:px-3";

const monthsSince = (start: string) => {
  const a = new Date(`${start.slice(0, 7)}-01T12:00:00`);
  const b = new Date();
  return (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth();
};
const monthLabel = (m: string) => new Date(`${m.slice(0, 7)}-01T12:00:00`).toLocaleDateString("en-US", { month: "long", year: "numeric" });
const thisMonth = () => new Date().toISOString().slice(0, 7);

function useSave() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<{ ok: true } | { ok: false; error: string }>, then?: () => void) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) return setError(r.error);
      then?.();
      router.refresh();
    });
  return { pending, error, run };
}

function Num({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-[11px] text-faint">
      {label}
      <input inputMode="numeric" value={value} onChange={(e) => onChange(e.target.value.replace(/[^\d-]/g, "").slice(0, 5))} className={box} />
    </label>
  );
}

/** "3-5" → [3, 5]; "4" → [4, 4] */
const range = (v: string): [number, number] => {
  const [a, b] = v.split("-").map((x) => Math.max(0, Number(x) || 0));
  return b == null ? [a ?? 0, a ?? 0] : [Math.min(a, b), Math.max(a, b)];
};

// ─── Email ───────────────────────────────────────────────────────────────────

export function EmailTier({ clientId, slug, value, strategy, canEdit }: { clientId: string; slug: string; value: EmailTierValue; strategy: boolean; canEdit: boolean }) {
  const inSetup = Boolean(value.setupStart) && monthsSince(value.setupStart!) < 3 && monthsSince(value.setupStart!) >= -6;
  const current = strategy ? STRATEGY : inSetup ? "setup" : (value.key ?? "");
  const [open, setOpen] = useState<null | "setup" | "custom">(null);
  const [start, setStart] = useState(value.setupStart?.slice(0, 7) ?? thisMonth());
  const [after, setAfter] = useState(value.key && value.key !== "custom" ? value.key : "basic");
  const c = value.custom ?? {};
  const r = (max: unknown, min: unknown) => (max == null ? "" : min != null && Number(min) < Number(max) ? `${min}-${max}` : String(max));
  const [custom, setCustom] = useState({ campaigns: r(c.campaigns, c.campaigns_min), sms: r(c.sms, c.sms_min), flows: c.flows == null ? "" : String(c.flows), flowEmails: r(c.flow_emails, c.flow_emails_min) });
  const { pending, error, run } = useSave();

  const summary = strategy
    ? "Strategy only, no copy or design: no allotment or requests"
    : inSetup
      ? `3-Month Initial Setup from ${monthLabel(value.setupStart!)} (month ${monthsSince(value.setupStart!) + 1} of 3), then ${EMAIL_TIERS.find((t) => t.key === value.key)?.label ?? "Basic"}`
      : value.key === "custom"
        ? `Custom: ${[custom.campaigns && `${custom.campaigns} campaigns`, custom.sms && `${custom.sms} SMS`, custom.flows && `${custom.flows} flows`, custom.flowEmails && `${custom.flowEmails} flow emails`].filter(Boolean).join(", ") || "no numbers yet"} a month`
        : (EMAIL_TIERS.find((t) => t.key === value.key)?.text ?? null);

  if (!canEdit) return <span className="text-xs text-muted">{summary ?? "No tier set"}</span>;

  const pick = (v: string) => {
    if (v === "setup" || v === "custom") return setOpen(v);
    setOpen(null);
    if (v === STRATEGY) return run(() => setStrategyOnly(clientId, slug, "email-marketing", true));
    if (v) run(() => setEmailTier(clientId, slug, { tier: v as "basic" | "silver" | "gold" }));
  };

  return (
    <span className="grid gap-1.5">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <select value={open ?? current} disabled={pending} onChange={(e) => pick(e.target.value)} className={select} aria-label="Email tier">
          <option value="">Pick a tier</option>
          <option value="setup">3-Month Initial Setup · $1,000/mo for 90 days</option>
          {EMAIL_TIERS.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label} · {t.text}
            </option>
          ))}
          <option value="custom">Custom numbers…</option>
          <option value={STRATEGY}>Strategy only, no deliverables</option>
        </select>
        {pending && <span className="text-[11px] text-faint">Saving…</span>}
      </span>
      {!open && summary && current !== "basic" && current !== "silver" && current !== "gold" && <span className="text-[11px] text-faint">{summary}</span>}
      {open === "setup" && (
        <span className="flex flex-wrap items-center gap-2 pt-1">
          <label className="flex items-center gap-1.5 text-[11px] text-faint">
            Starts
            <input type="month" value={start} onChange={(e) => setStart(e.target.value)} className="h-11 rounded-[8px] border border-line bg-bg px-2 text-xs outline-none focus:border-brand/60 md:h-8" />
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-faint">
            Then
            <select value={after} onChange={(e) => setAfter(e.target.value)} className="h-11 rounded-[8px] border border-line bg-bg px-2 text-xs md:h-8">
              {EMAIL_TIERS.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" disabled={pending || !start} onClick={() => run(() => setEmailTier(clientId, slug, { tier: "setup", start, after }), () => setOpen(null))} className={btn}>
            Save
          </button>
          <button type="button" onClick={() => setOpen(null)} className="min-h-10 text-[11px] text-faint hover:text-fg md:min-h-0">
            Cancel
          </button>
          <span className="w-full text-[11px] text-faint">Month 1 Foundation (3 flows, 15 flow emails), month 2 Expansion (2 flows, 10 flow emails, 3 campaigns, 2 SMS), month 3 Ongoing (1 flow or 5 optimization emails, 5 campaigns, 2 SMS). A client SOW that says otherwise wins.</span>
        </span>
      )}
      {open === "custom" && (
        <span className="flex flex-wrap items-center gap-2 pt-1">
          <Num label="Campaigns" value={custom.campaigns} onChange={(v) => setCustom((x) => ({ ...x, campaigns: v }))} />
          <Num label="SMS" value={custom.sms} onChange={(v) => setCustom((x) => ({ ...x, sms: v }))} />
          <Num label="Flows" value={custom.flows} onChange={(v) => setCustom((x) => ({ ...x, flows: v }))} />
          <Num label="Flow emails" value={custom.flowEmails} onChange={(v) => setCustom((x) => ({ ...x, flowEmails: v }))} />
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              const [cMin, cMax] = range(custom.campaigns);
              const [sMin, sMax] = range(custom.sms);
              const [fMin, fMax] = range(custom.flowEmails);
              run(() => setEmailTier(clientId, slug, { tier: "custom", custom: { campaigns: cMax, campaigns_min: cMin, sms: sMax, sms_min: sMin, flows: custom.flows ? Number(custom.flows) : null, flow_emails: fMax, flow_emails_min: fMin } }), () => setOpen(null));
            }}
            className={btn}
          >
            Save
          </button>
          <button type="button" onClick={() => setOpen(null)} className="min-h-10 text-[11px] text-faint hover:text-fg md:min-h-0">
            Cancel
          </button>
          <span className="w-full text-[11px] text-faint">A month each, as one number or a range (3-5). Leave flows empty to count flows without a cap.</span>
        </span>
      )}
      {error && <span className="text-[11px] text-bad">{error}</span>}
    </span>
  );
}

// ─── Creative ────────────────────────────────────────────────────────────────

export function CreativeTier({
  clientId,
  slug,
  creative,
  packages,
  strategy,
  canEdit,
}: {
  clientId: string;
  slug: string;
  creative: { label: string | null; active: boolean; until: string | null; key?: string | null };
  packages: { key: string; label: string; images: number; videos: number }[];
  strategy: boolean;
  canEdit: boolean;
}) {
  const current = strategy ? STRATEGY : creative.active && creative.until ? "sprint" : creative.active ? (creative.key ?? "custom") : "";
  const [open, setOpen] = useState<null | "custom" | "sprint">(null);
  const [images, setImages] = useState("");
  const [videos, setVideos] = useState("");
  const [until, setUntil] = useState("");
  const [sprintKey, setSprintKey] = useState(packages[0]?.key ?? "custom");
  const { pending, error, run } = useSave();
  const both = (i: number, v: number) => [i && `${i} images`, v && `${v} videos`].filter(Boolean).join(" + ") || "no allotment";
  const summary = strategy ? "Strategy only, no design: no allotment or briefs" : creative.label ? `${creative.label}${creative.until ? ` (sprint until ${creative.until})` : ""}` : "No package set";

  if (!canEdit) return <span className="text-xs text-muted">{summary}</span>;

  const pick = (v: string) => {
    if (v === "custom" || v === "sprint") return setOpen(v);
    setOpen(null);
    if (v === STRATEGY) return run(() => setStrategyOnly(clientId, slug, "creative", true));
    if (v) run(() => setCreativeTier(clientId, slug, { tier: "package", key: v }));
  };

  return (
    <span className="grid gap-1.5">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <select value={open ?? current} disabled={pending} onChange={(e) => pick(e.target.value)} className={select} aria-label="Creative package">
          <option value="">{creative.label && current === "" ? summary : "Pick a package"}</option>
          {packages.map((pk) => (
            <option key={pk.key} value={pk.key}>
              {pk.label} · {both(pk.images, pk.videos)} a month
            </option>
          ))}
          <option value="custom">{current === "custom" && creative.label ? `${creative.label} (custom)` : "Custom numbers…"}</option>
          <option value="sprint">{current === "sprint" ? summary : "Sprint until a day…"}</option>
          <option value={STRATEGY}>Strategy only, no deliverables</option>
        </select>
        {pending && <span className="text-[11px] text-faint">Saving…</span>}
      </span>
      {(current === STRATEGY || current === "sprint") && !open && <span className="text-[11px] text-faint">{summary}</span>}
      {open && (
        <span className="flex flex-wrap items-center gap-2 pt-1">
          {open === "sprint" && (
            <>
              <label className="flex items-center gap-1.5 text-[11px] text-faint">
                Until
                <input type="date" value={until} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setUntil(e.target.value)} className="h-11 rounded-[8px] border border-line bg-bg px-2 text-xs outline-none focus:border-brand/60 md:h-8" />
              </label>
              <select value={sprintKey} onChange={(e) => setSprintKey(e.target.value)} className="h-11 rounded-[8px] border border-line bg-bg px-2 text-xs md:h-8" aria-label="Sprint package">
                {packages.map((pk) => (
                  <option key={pk.key} value={pk.key}>
                    {pk.label}
                  </option>
                ))}
                <option value="custom">Custom numbers</option>
              </select>
            </>
          )}
          {(open === "custom" || sprintKey === "custom") && (
            <>
              <Num label="Images" value={images} onChange={setImages} />
              <Num label="Videos" value={videos} onChange={setVideos} />
            </>
          )}
          <button
            type="button"
            disabled={pending || (open === "sprint" && !until)}
            onClick={() =>
              run(
                () =>
                  open === "custom"
                    ? setCreativeTier(clientId, slug, { tier: "custom", images: Number(images) || 0, videos: Number(videos) || 0 })
                    : setCreativeTier(clientId, slug, { tier: "sprint", until, key: sprintKey === "custom" ? null : sprintKey, images: Number(images) || 0, videos: Number(videos) || 0 }),
                () => setOpen(null),
              )
            }
            className={btn}
          >
            {open === "sprint" ? "Start sprint" : "Save"}
          </button>
          <button type="button" onClick={() => setOpen(null)} className="min-h-10 text-[11px] text-faint hover:text-fg md:min-h-0">
            Cancel
          </button>
        </span>
      )}
      {error && <span className="text-[11px] text-bad">{error}</span>}
    </span>
  );
}

// ─── Any service ─────────────────────────────────────────────────────────────

/** Strategy only, no deliverables: on (no allotment, alerts or requests for it) or back to deliverables */
export function StrategyToggle({ clientId, slug, service, on, canEdit }: { clientId: string; slug: string; service: string; on: boolean; canEdit: boolean }) {
  const { pending, error, run } = useSave();
  if (!canEdit) return on ? <span className="text-xs text-muted">Strategy only, no deliverables</span> : null;
  return (
    <span className="inline-flex items-center gap-2">
      <label className="inline-flex min-h-10 cursor-pointer items-center gap-1.5 text-[11px] text-faint hover:text-fg md:min-h-0">
        <input type="checkbox" checked={on} disabled={pending} onChange={(e) => run(() => setStrategyOnly(clientId, slug, service, e.target.checked))} className="h-3.5 w-3.5 accent-[var(--color-brand,#c8102e)]" />
        Strategy only, no deliverables
      </label>
      {error && <span className="text-[11px] text-bad">{error}</span>}
    </span>
  );
}
