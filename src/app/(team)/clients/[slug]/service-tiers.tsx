"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import {
  ADDON_PRICE,
  addedPlatforms,
  isSocialTier,
  parseRange,
  platformsFor,
  SOCIAL_PLATFORM_OPTIONS,
  SOCIAL_TIERS,
  socialAllotmentPace,
  socialPace,
  socialPools,
  socialTier,
  tierText,
  type SocialAllotment,
  type SocialCustom,
  type SocialPlatformKey,
  type SocialTierKey,
} from "@/lib/social-allotment-core";
import { setAllotmentPool, setCreativeTier, setEmailTier, setSocialExtraVideos, setSocialPlatforms, setSocialTier, setStrategyOnly } from "./tier-actions";

// The tier pickers in the Services panel, the one place every service's tier is set (owner, Nov 19 2026):
//   Email: 3-Month Initial Setup (its start month, then the ongoing tier), a Sprint (its own numbers until a day, then
//          a tier or nothing), Basic, Silver, Gold, Custom (each pool's numbers), or Strategy only, no deliverables.
//   Creative: a package, Custom (images and videos a month), a sprint until a day, or Strategy only.
//   Social: Basic, Silver, Gold, Platinum (and added video/reels), a Sprint, Custom numbers, or Strategy only; the
//           platforms the client posts on (the tier's own unless picked), and this cycle's allotment with its pace.
// A pick saves at once; Setup, Sprint and Custom ask for their numbers first. The menu is the app's own (grouped rows
// with what each tier holds and its price), never the browser's plain dropdown.

export type EmailTierValue = { key: string | null; setupStart: string | null; custom: Record<string, number | string | null> | null };

type Ongoing = "basic" | "silver" | "gold";
const EMAIL_TIERS: { key: Ongoing; label: string; text: string; price: string }[] = [
  { key: "basic", label: "Basic", text: "3-5 campaigns, 2 SMS, 3-5 flow emails a month", price: "$1,000" },
  { key: "silver", label: "Silver", text: "7-10 campaigns, 4-6 SMS, 5-7 flow emails a month", price: "$1,750" },
  { key: "gold", label: "Gold", text: "15-20 campaigns, 6-8 SMS, 5-10 flow emails a month", price: "$2,250" },
];
const STRATEGY = "__strategy";
const box = "h-11 w-14 rounded-[10px] border border-line bg-bg px-1.5 text-center text-xs tabular outline-none transition-colors focus:border-brand/60 md:h-8";
const btn = "h-10 rounded-full bg-fg px-4 text-[11px] font-medium text-bg transition-opacity disabled:opacity-50 md:h-8 md:px-3.5";
const dateBox = "h-11 rounded-[10px] border border-line bg-bg px-2 text-xs outline-none transition-colors focus:border-brand/60 md:h-8 [color-scheme:dark] [:root[data-theme=light]_&]:[color-scheme:light]";

const monthsSince = (start: string) => {
  const a = new Date(`${start.slice(0, 7)}-01T12:00:00`);
  const b = new Date();
  return (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth();
};
const monthLabel = (m: string) => new Date(`${m.slice(0, 7)}-01T12:00:00`).toLocaleDateString("en-US", { month: "long", year: "numeric" });
const dayLabel = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const thisMonth = () => new Date().toISOString().slice(0, 7);
const today = () => new Date().toISOString().slice(0, 10);

/**
 * A save that answers as soon as the row is written: the new tier shows at once (`shown`) with "Saved", and the page
 * refreshes in the background, never holding "Saving…" while the whole client page renders again.
 */
function useSave() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const run = (fn: () => Promise<{ ok: true } | { ok: false; error: string }>, then?: () => void, show?: string) =>
    start(async () => {
      setError(null);
      setSaved(false);
      const r = await fn();
      if (!r.ok) return setError(r.error);
      then?.();
      if (show !== undefined) setShown(show);
      setSaved(true);
      setTimeout(() => router.refresh(), 0);
    });
  return { pending, error, run, shown, saved };
}

// ─── The menu ────────────────────────────────────────────────────────────────

export type MenuItem = { value: string; label: string; detail?: string; price?: string; more?: boolean };
export type MenuGroup = { title: string; items: MenuItem[] };

/** The tier menu: the current tier as a quiet button, and a panel of grouped rows (what each holds, its price) */
export function TierMenu({ label, value, groups, onPick, disabled, empty }: { label: string; value: string; groups: MenuGroup[]; onPick: (v: string) => void; disabled?: boolean; empty: string }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const items = groups.flatMap((g) => g.items);
  const current = items.find((i) => i.value === value) ?? null;
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => wrap.current && !wrap.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  // Arrow keys move between the rows
  const move = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const rows = [...(e.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]") ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    rows[(at + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
  };
  return (
    <span ref={wrap} className="relative inline-flex max-w-full">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        className={`group inline-flex min-h-10 max-w-full items-center gap-1.5 rounded-full border px-3 py-1 text-left text-xs transition-colors disabled:opacity-60 md:min-h-8 ${open ? "border-brand/50 bg-brand/10 text-fg" : "border-line bg-ink/[0.03] text-muted hover:border-faint hover:text-fg"}`}
      >
        <span className="truncate">
          {current ? (
            <>
              <span className="font-medium text-fg">{current.label}</span>
              {current.price && <span className="text-faint"> · {current.price}</span>}
            </>
          ) : (
            empty
          )}
        </span>
        <svg aria-hidden width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 text-faint transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          aria-label={label}
          onKeyDown={move}
          className="absolute left-0 top-[calc(100%+6px)] z-40 grid w-[min(26rem,calc(100vw-3rem))] gap-1 rounded-[16px] border border-line bg-surface-2 p-1.5 shadow-[var(--lift-3,0_24px_60px_-20px_rgba(0,0,0,0.6))]"
          style={{ animation: "card-in .16s cubic-bezier(.2,.8,.2,1) both" }}
        >
          {groups
            .filter((g) => g.items.length)
            .map((g, gi) => (
              <div key={g.title} className={`grid gap-0.5 ${gi ? "border-t border-line/70 pt-1" : ""}`}>
                <p className="px-2.5 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">{g.title}</p>
                {g.items.map((it) => {
                  const on = it.value === value;
                  return (
                    <button
                      key={it.value}
                      type="button"
                      role="menuitemradio"
                      aria-checked={on}
                      autoFocus={on}
                      onClick={() => {
                        setOpen(false);
                        onPick(it.value);
                      }}
                      className={`grid grid-cols-[1fr_auto] items-start gap-x-3 rounded-[11px] px-2.5 py-2 text-left outline-none transition-colors focus-visible:bg-ink/[0.07] ${on ? "bg-brand/10" : "hover:bg-ink/[0.05]"}`}
                    >
                      <span className="grid min-w-0 gap-0.5">
                        <span className={`flex items-center gap-1.5 text-[13px] ${on ? "font-medium text-fg" : "text-fg/90"}`}>
                          {on && <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />}
                          {it.label}
                          {it.more && <span className="text-faint">…</span>}
                        </span>
                        {it.detail && <span className="text-[11.5px] leading-snug text-faint">{it.detail}</span>}
                      </span>
                      {it.price && <span className="tabular pt-px text-[12px] text-muted">{it.price}</span>}
                    </button>
                  );
                })}
              </div>
            ))}
        </div>
      )}
    </span>
  );
}

/** A few choices as pills (the tier a setup or sprint rolls into, a sprint's package) */
function Pills<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
      {label}
      <span role="radiogroup" aria-label={label} className="inline-flex flex-wrap rounded-full border border-line bg-bg p-0.5">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            onClick={() => onChange(o.value)}
            className={`min-h-9 rounded-full px-2.5 text-[11px] transition-colors md:min-h-6 ${value === o.value ? "bg-fg font-medium text-bg" : "text-muted hover:text-fg"}`}
          >
            {o.label}
          </button>
        ))}
      </span>
    </span>
  );
}

function Num({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-[11px] text-faint">
      {label}
      <input inputMode="numeric" value={value} onChange={(e) => onChange(e.target.value.replace(/[^\d-]/g, "").slice(0, 5))} className={box} />
    </label>
  );
}

/** The panel under the menu where a tier's numbers are set */
function Panel({ children, note }: { children: React.ReactNode; note?: string }) {
  return (
    <span className="grid gap-2 rounded-[14px] border border-line bg-bg/60 p-3" style={{ animation: "card-in .2s cubic-bezier(.2,.8,.2,1) both" }}>
      <span className="flex flex-wrap items-center gap-2">{children}</span>
      {note && <span className="text-[11px] leading-snug text-faint">{note}</span>}
    </span>
  );
}

function Status({ pending, saved, error }: { pending: boolean; saved: boolean; error: string | null }) {
  if (pending) return <span className="text-[11px] text-faint">Saving…</span>;
  if (error) return null;
  return saved ? <span className="text-[11px] text-ok">Saved</span> : null;
}

/** "3-5" → [3, 5]; "4" → [4, 4] */
const range = (v: string): [number, number] => {
  const [a, b] = v.split("-").map((x) => Math.max(0, Number(x) || 0));
  return b == null ? [a ?? 0, a ?? 0] : [Math.min(a, b), Math.max(a, b)];
};

// ─── Email ───────────────────────────────────────────────────────────────────

export function EmailTier({ clientId, slug, value, strategy, canEdit }: { clientId: string; slug: string; value: EmailTierValue; strategy: boolean; canEdit: boolean }) {
  const c = value.custom ?? {};
  const sprintUntil = typeof c.sprint_until === "string" && value.key === "custom" ? c.sprint_until : null;
  const inSetup = Boolean(value.setupStart) && monthsSince(value.setupStart!) < 3 && monthsSince(value.setupStart!) >= -6;
  const current = strategy ? STRATEGY : inSetup ? "setup" : sprintUntil ? "sprint" : (value.key ?? "");
  const [open, setOpen] = useState<null | "setup" | "custom" | "sprint">(null);
  const [start, setStart] = useState(value.setupStart?.slice(0, 7) ?? thisMonth());
  const [after, setAfter] = useState<Ongoing>(value.key && ["basic", "silver", "gold"].includes(value.key) ? (value.key as Ongoing) : "basic");
  const [sprintAfter, setSprintAfter] = useState<Ongoing | "none">(typeof c.after === "string" && ["basic", "silver", "gold"].includes(c.after) ? (c.after as Ongoing) : "none");
  const [until, setUntil] = useState(sprintUntil ?? "");
  const r = (max: unknown, min: unknown) => (max == null ? "" : min != null && Number(min) < Number(max) ? `${min}-${max}` : String(max));
  const [custom, setCustom] = useState({ campaigns: r(c.campaigns, c.campaigns_min), sms: r(c.sms, c.sms_min), flows: c.flows == null ? "" : String(c.flows), flowEmails: r(c.flow_emails, c.flow_emails_min) });
  const { pending, error, run, shown, saved } = useSave();

  const numbers = [custom.campaigns && `${custom.campaigns} campaigns`, custom.sms && `${custom.sms} SMS`, custom.flows && `${custom.flows} flows`, custom.flowEmails && `${custom.flowEmails} flow emails`].filter(Boolean).join(", ");
  const tierName = (k: string | null | undefined) => EMAIL_TIERS.find((t) => t.key === k)?.label ?? null;
  const summary = strategy
    ? "Strategy only, no copy or design: no allotment or requests"
    : inSetup
      ? `From ${monthLabel(value.setupStart!)}, month ${monthsSince(value.setupStart!) + 1} of 3, then ${tierName(value.key) ?? "Basic"}`
      : sprintUntil
        ? `Until ${dayLabel(sprintUntil)}: ${numbers || "no numbers yet"}${tierName(c.after as string) ? `, then ${tierName(c.after as string)}` : ", then nothing"}`
        : value.key === "custom"
          ? `${numbers || "No numbers yet"} a month`
          : null;

  if (!canEdit) return <span className="text-xs text-muted">{summary ?? (tierName(value.key) ? `${tierName(value.key)} · ${EMAIL_TIERS.find((t) => t.key === value.key)!.text}` : "No tier set")}</span>;

  const groups: MenuGroup[] = [
    {
      title: "Getting started",
      items: [
        { value: "setup", label: "3-Month Initial Setup", detail: "Month 1 Foundation, month 2 Expansion, month 3 Ongoing, then a tier", price: "$1,000/mo", more: true },
        { value: "sprint", label: "Sprint", detail: "A set scope until a day (a 1-month sprint, a migration), then a tier or nothing", more: true },
      ],
    },
    { title: "Ongoing", items: EMAIL_TIERS.map((t) => ({ value: t.key, label: t.label, detail: t.text, price: t.price })) },
    {
      title: "Their own",
      items: [
        { value: "custom", label: "Custom numbers", detail: "Each pool set by hand, one number or a range", more: true },
        { value: STRATEGY, label: "Strategy only", detail: "No copy or design: no allotment, no requests" },
      ],
    },
  ];

  const pick = (v: string) => {
    if (v === "setup" || v === "custom" || v === "sprint") return setOpen(v);
    setOpen(null);
    if (v === STRATEGY) return run(() => setStrategyOnly(clientId, slug, "email-marketing", true), undefined, STRATEGY);
    if (v) run(() => setEmailTier(clientId, slug, { tier: v as Ongoing }), undefined, v);
  };
  const pools = () => {
    const [cMin, cMax] = range(custom.campaigns);
    const [sMin, sMax] = range(custom.sms);
    const [fMin, fMax] = range(custom.flowEmails);
    return { campaigns: cMax, campaigns_min: cMin, sms: sMax, sms_min: sMin, flows: custom.flows ? Number(custom.flows) : null, flow_emails: fMax, flow_emails_min: fMin };
  };
  const numberBoxes = (
    <>
      <Num label="Campaigns" value={custom.campaigns} onChange={(v) => setCustom((x) => ({ ...x, campaigns: v }))} />
      <Num label="SMS" value={custom.sms} onChange={(v) => setCustom((x) => ({ ...x, sms: v }))} />
      <Num label="Flows" value={custom.flows} onChange={(v) => setCustom((x) => ({ ...x, flows: v }))} />
      <Num label="Flow emails" value={custom.flowEmails} onChange={(v) => setCustom((x) => ({ ...x, flowEmails: v }))} />
    </>
  );
  const cancel = (
    <button type="button" onClick={() => setOpen(null)} className="min-h-10 px-1 text-[11px] text-faint hover:text-fg md:min-h-0">
      Cancel
    </button>
  );

  return (
    <span className="grid gap-2">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <TierMenu label="Email tier" value={open ?? shown ?? current} groups={groups} onPick={pick} disabled={pending} empty="Pick a tier" />
        <Status pending={pending} saved={saved && !open} error={error} />
      </span>
      {!open && summary && <span className="text-[11px] leading-snug text-faint">{summary}</span>}
      {open === "setup" && (
        <Panel note="Month 1 Foundation (3 flows, 15 flow emails), month 2 Expansion (2 flows, 10 flow emails, 3 campaigns, 2 SMS), month 3 Ongoing (1 flow or 5 optimization emails, 5 campaigns, 2 SMS). A client SOW that says otherwise wins.">
          <label className="flex items-center gap-1.5 text-[11px] text-faint">
            Starts
            <input type="month" value={start} onChange={(e) => setStart(e.target.value)} className={dateBox} />
          </label>
          <Pills label="Then" value={after} options={EMAIL_TIERS.map((t) => ({ value: t.key, label: t.label }))} onChange={setAfter} />
          <button type="button" disabled={pending || !start} onClick={() => run(() => setEmailTier(clientId, slug, { tier: "setup", start, after }), () => setOpen(null), "setup")} className={btn}>
            Save
          </button>
          {cancel}
        </Panel>
      )}
      {open === "sprint" && (
        <Panel note="What the sprint holds each month, as one number or a range (3-5). It ends on its day: the client moves to the tier picked, or holds no allotment.">
          <label className="flex items-center gap-1.5 text-[11px] text-faint">
            Until
            <input type="date" value={until} min={today()} onChange={(e) => setUntil(e.target.value)} className={dateBox} />
          </label>
          {numberBoxes}
          <Pills label="Then" value={sprintAfter} options={[{ value: "none", label: "Nothing" }, ...EMAIL_TIERS.map((t) => ({ value: t.key, label: t.label }))]} onChange={setSprintAfter} />
          <button type="button" disabled={pending || !until} onClick={() => run(() => setEmailTier(clientId, slug, { tier: "sprint", until, custom: pools(), after: sprintAfter === "none" ? null : sprintAfter }), () => setOpen(null), "sprint")} className={btn}>
            Start sprint
          </button>
          {cancel}
        </Panel>
      )}
      {open === "custom" && (
        <Panel note="A month each, as one number or a range (3-5). Leave flows empty to count flows without a cap.">
          {numberBoxes}
          <button type="button" disabled={pending} onClick={() => run(() => setEmailTier(clientId, slug, { tier: "custom", custom: pools() }), () => setOpen(null), "custom")} className={btn}>
            Save
          </button>
          {cancel}
        </Panel>
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
  pool = null,
}: {
  clientId: string;
  slug: string;
  creative: { label: string | null; active: boolean; until: string | null; key?: string | null };
  packages: { key: string; label: string; images: number; videos: number }[];
  strategy: boolean;
  canEdit: boolean;
  /** Draws from another client's allotment (a location sharing its parent's) */
  pool?: { current: string | null; options: { id: string; name: string }[] } | null;
}) {
  const poolName = pool?.current ? (pool.options.find((o) => o.id === pool.current)?.name ?? "another client") : null;
  const current = strategy ? STRATEGY : poolName ? "pool" : creative.active && creative.until ? "sprint" : creative.active ? (creative.key ?? "custom") : "";
  const [open, setOpen] = useState<null | "custom" | "sprint" | "pool">(null);
  const [poolPick, setPoolPick] = useState(pool?.current ?? "");
  const [images, setImages] = useState("");
  const [videos, setVideos] = useState("");
  const [until, setUntil] = useState("");
  const [sprintKey, setSprintKey] = useState(packages[0]?.key ?? "custom");
  const { pending, error, run, shown, saved } = useSave();
  const both = (i: number, v: number) => [i && `${i} images`, v && `${v} videos`].filter(Boolean).join(" + ") || "no allotment";
  const summary = strategy ? "Strategy only, no design: no allotment or briefs" : poolName ? `Shares ${poolName}'s allotment` : creative.label ? `${creative.label}${creative.until ? ` (sprint until ${dayLabel(creative.until)})` : ""}` : "No package set";

  if (!canEdit) return <span className="text-xs text-muted">{summary}</span>;

  const groups: MenuGroup[] = [
    { title: "Packages", items: packages.map((pk) => ({ value: pk.key, label: pk.label, detail: `${both(pk.images, pk.videos)} a month` })) },
    {
      title: "Their own",
      items: [
        { value: "sprint", label: "Sprint", detail: current === "sprint" ? summary : "A package or numbers until a day", more: true },
        { value: "custom", label: "Custom numbers", detail: current === "custom" && creative.label ? creative.label : "Images and videos a month, set by hand", more: true },
        { value: "pool", label: "Shares another client's allotment", detail: poolName ? `Shares ${poolName}'s` : "A location drawing from its parent's", more: true },
        { value: STRATEGY, label: "Strategy only", detail: "No design: no allotment, no briefs" },
      ],
    },
  ];

  const pick = (v: string) => {
    if (v === "custom" || v === "sprint" || v === "pool") return setOpen(v);
    setOpen(null);
    if (v === STRATEGY) return run(() => setStrategyOnly(clientId, slug, "creative", true), undefined, STRATEGY);
    if (v) run(() => setCreativeTier(clientId, slug, { tier: "package", key: v }), undefined, v);
  };

  return (
    <span className="grid gap-2">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <TierMenu label="Creative package" value={open ?? shown ?? current} groups={groups} onPick={pick} disabled={pending} empty={creative.label && current === "" ? summary : "Pick a package"} />
        <Status pending={pending} saved={saved && !open} error={error} />
      </span>
      {(current === STRATEGY || current === "sprint" || current === "custom" || current === "pool") && !open && <span className="text-[11px] leading-snug text-faint">{summary}</span>}
      {open && (
        <Panel note={open === "sprint" ? "It ends on its day and the client holds no creative allotment after it, unless a package is picked again." : undefined}>
          {open === "sprint" && (
            <>
              <label className="flex items-center gap-1.5 text-[11px] text-faint">
                Until
                <input type="date" value={until} min={today()} onChange={(e) => setUntil(e.target.value)} className={dateBox} />
              </label>
              <Pills label="Package" value={sprintKey} options={[...packages.map((pk) => ({ value: pk.key, label: pk.label })), { value: "custom", label: "Custom" }]} onChange={setSprintKey} />
            </>
          )}
          {open === "pool" && (
            <label className="flex items-center gap-1.5 text-[11px] text-faint">
              Draws from
              <select value={poolPick} onChange={(e) => setPoolPick(e.target.value)} className="min-h-10 max-w-[220px] rounded-[8px] border border-line bg-bg px-2 text-xs text-fg md:min-h-8">
                <option value="">Its own allotment</option>
                {(pool?.options ?? []).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {open !== "pool" && (open === "custom" || sprintKey === "custom") && (
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
                  open === "pool"
                    ? setAllotmentPool(clientId, slug, poolPick || null)
                    : open === "custom"
                    ? setCreativeTier(clientId, slug, { tier: "custom", images: Number(images) || 0, videos: Number(videos) || 0 })
                    : setCreativeTier(clientId, slug, { tier: "sprint", until, key: sprintKey === "custom" ? null : sprintKey, images: Number(images) || 0, videos: Number(videos) || 0 }),
                () => setOpen(null),
                open ?? undefined,
              )
            }
            className={btn}
          >
            {open === "sprint" ? "Start sprint" : "Save"}
          </button>
          <button type="button" onClick={() => setOpen(null)} className="min-h-10 px-1 text-[11px] text-faint hover:text-fg md:min-h-0">
            Cancel
          </button>
        </Panel>
      )}
      {error && <span className="text-[11px] text-bad">{error}</span>}
    </span>
  );
}

// ─── Social ──────────────────────────────────────────────────────────────────

export type SocialTierValue = {
  key: string | null;
  custom: Record<string, number | string | null> | null;
  /** The platforms picked by hand (null: the tier's own) */
  platforms: string[] | null;
  extraVideos: number;
  allotment: SocialAllotment | null;
};

/** The platforms the client posts on, as toggles: they decide which platforms' numbers are read and scored */
function PlatformPicks({ value, tierKey, own, canEdit, onSave, pending }: { value: SocialPlatformKey[]; tierKey: string | null; own: boolean; canEdit: boolean; onSave: (next: SocialPlatformKey[] | null) => void; pending: boolean }) {
  const added = addedPlatforms(value, tierKey);
  const toggle = (k: SocialPlatformKey) => {
    const next = value.includes(k) ? value.filter((x) => x !== k) : [...value, k];
    if (next.length) onSave(next);
  };
  const unread = value.filter((k) => !SOCIAL_PLATFORM_OPTIONS.find((p) => p.key === k)?.read);
  return (
    <span className="grid gap-1">
      <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
        Posts on
        <span role="group" aria-label="Platforms the client posts on" className="inline-flex flex-wrap gap-1">
          {SOCIAL_PLATFORM_OPTIONS.map((p) => {
            const on = value.includes(p.key);
            return (
              <button
                key={p.key}
                type="button"
                role="checkbox"
                aria-checked={on}
                disabled={!canEdit || pending || (on && value.length === 1)}
                onClick={() => toggle(p.key)}
                title={p.label}
                className={`min-h-9 rounded-full border px-2.5 text-[11px] transition-colors md:min-h-6 ${on ? "border-brand/40 bg-brand/10 font-medium text-fg" : "border-line text-faint hover:border-faint hover:text-fg"} disabled:cursor-default ${!canEdit && !on ? "hidden" : ""}`}
              >
                {p.short}
              </button>
            );
          })}
        </span>
        {canEdit && own && (
          <button type="button" disabled={pending} onClick={() => onSave(null)} className="min-h-9 px-1 text-[11px] text-faint underline-offset-2 hover:text-fg hover:underline md:min-h-0">
            Tier&apos;s own
          </button>
        )}
      </span>
      {(added > 0 || unread.length > 0) && (
        <span className="text-[11px] leading-snug text-faint">
          {added > 0 && `${added} platform${added === 1 ? "" : "s"} beyond the tier (add-on, $${ADDON_PRICE}/mo each). `}
          {unread.length > 0 && `${unread.map((k) => SOCIAL_PLATFORM_OPTIONS.find((p) => p.key === k)!.label).join(", ")} not read yet: only Facebook and Instagram numbers are pulled and scored.`}
        </span>
      )}
    </span>
  );
}

/** This cycle against the allotment: each pool used/cap with a thin bar, in progress and published, and the pace */
export function SocialMeter({ a }: { a: SocialAllotment | null }) {
  const pools = socialPools(a);
  if (!a || !pools.length) return null;
  const pace = socialPace(a);
  const p = socialAllotmentPace(a);
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const tone = pace.group === "behind" ? "text-warn" : pace.group === "over" ? "text-bad" : "text-ok";
  const paceText = pace.group === "behind" ? `Behind: ${p ? `${pct(p.used)} used, ${pct(p.elapsed)} of the cycle gone` : "under pace"}` : pace.group === "over" ? "Over the allotment" : "On pace";
  return (
    <span className="grid gap-1.5 rounded-[12px] border border-line/80 bg-ink/[0.02] px-2.5 py-2">
      <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-[10.5px] uppercase tracking-[0.12em] text-faint">
        <span>{a.cycle ? `This cycle · ${dayLabel(a.cycle.start).replace(/, \d{4}$/, "")} to ${dayLabel(a.cycle.end).replace(/, \d{4}$/, "")}` : "This cycle"}</span>
        <span className={`normal-case tracking-normal ${tone}`}>{paceText}</span>
      </span>
      <span className="grid grid-cols-2 gap-x-3 gap-y-1.5 sm:grid-cols-4">
        {pools.map((x) => (
          <span key={x.key} className="grid gap-0.5">
            <span className="flex items-baseline justify-between gap-1 text-[11px]">
              <span className="text-faint">{x.label}</span>
              <span className="tabular text-fg">
                {x.used}
                <span className="text-faint">/{x.range}</span>
              </span>
            </span>
            <span aria-hidden className="h-1 overflow-hidden rounded-full bg-ink/[0.08]">
              <span className={`block h-full rounded-full ${x.over ? "bg-bad" : "bg-brand"}`} style={{ width: `${Math.min(100, (x.used / Math.max(1, x.cap)) * 100)}%` }} />
            </span>
            {(x.progress > 0 || (x.done > 0 && x.done !== x.used)) && (
              <span className="text-[10.5px] text-faint">
                {[x.progress && `${x.progress} in progress`, x.done !== x.used && `${x.done} published`].filter(Boolean).join(" · ")}
              </span>
            )}
          </span>
        ))}
      </span>
    </span>
  );
}

export function SocialTier({ clientId, slug, value, strategy, canEdit }: { clientId: string; slug: string; value: SocialTierValue; strategy: boolean; canEdit: boolean }) {
  const c = value.custom ?? {};
  const sprintUntil = value.key === "custom" && typeof c.sprint_until === "string" && c.sprint_until ? c.sprint_until : null;
  const current = strategy ? STRATEGY : sprintUntil ? "sprint" : (value.key ?? "");
  const [open, setOpen] = useState<null | "custom" | "sprint">(null);
  const r = (max: unknown, min: unknown) => (max == null ? "" : min != null && Number(min) < Number(max) ? `${min}-${max}` : String(max));
  const [custom, setCustom] = useState({ posts: r(c.posts, c.posts_min), statics: r(c.statics, c.statics_min), videos: r(c.videos, c.videos_min), stories: r(c.stories, c.stories_min) });
  const [until, setUntil] = useState(sprintUntil ?? "");
  const [after, setAfter] = useState<SocialTierKey | "none">(isSocialTier(c.after) ? c.after : "none");
  const [platforms, setPlatforms] = useState<{ list: string[] | null } | null>(null);
  const [extra, setExtra] = useState<number | null>(null);
  const { pending, error, run, shown, saved } = useSave();
  const tierKey = shown && isSocialTier(shown) ? shown : isSocialTier(value.key) ? value.key : null;
  const ownPlatforms = platforms ? platforms.list : value.platforms;
  const list = platformsFor(ownPlatforms, tierKey);
  const extraVideos = extra ?? value.extraVideos;

  const numbers = [custom.posts && `${custom.posts} posts`, custom.statics && `${custom.statics} statics`, custom.videos && `${custom.videos} video/reels`, custom.stories && `${custom.stories} IG stories`].filter(Boolean).join(", ");
  const tier = socialTier(tierKey);
  const tierName = (k: unknown) => socialTier(typeof k === "string" ? k : null)?.label ?? null;
  const summary = strategy
    ? "Strategy only, no posts made: no allotment or requests"
    : sprintUntil
      ? `Until ${dayLabel(sprintUntil)}: ${numbers || "no numbers yet"}${tierName(c.after) ? `, then ${tierName(c.after)}` : ", then nothing"}`
      : value.key === "custom"
        ? `${numbers || "No numbers yet"} a month`
        : tier
          ? `${tierText({ ...tier, videos: tier.videos + extraVideos })} a month · ${tier.extras} · ${tier.minimumMonths}-month minimum`
          : null;

  const pools = (): Partial<SocialCustom> => {
    const [pMin, pMax] = parseRange(custom.posts);
    const [sMin, sMax] = parseRange(custom.statics);
    const [vMin, vMax] = parseRange(custom.videos);
    const [tMin, tMax] = parseRange(custom.stories);
    return { posts: pMax, posts_min: pMin, statics: sMax, statics_min: sMin, videos: vMax, videos_min: vMin, stories: tMax, stories_min: tMin };
  };

  if (!canEdit)
    return (
      <span className="grid gap-1.5">
        <span className="text-xs text-muted">{strategy ? summary : tier && current === tier.key ? `${tier.label} · ${tier.price}/mo` : (summary ?? "No tier set")}</span>
        {current && current !== STRATEGY && current !== "sprint" && current !== "custom" && summary && <span className="text-[11px] leading-snug text-faint">{summary}</span>}
        {!strategy && <PlatformPicks value={list} tierKey={tierKey} own={Boolean(ownPlatforms)} canEdit={false} onSave={() => {}} pending={false} />}
        {!strategy && <SocialMeter a={value.allotment} />}
      </span>
    );

  const groups: MenuGroup[] = [
    { title: "Tiers", items: SOCIAL_TIERS.map((t) => ({ value: t.key, label: t.label, detail: `${tierText(t)} · ${t.platforms.map((k) => SOCIAL_PLATFORM_OPTIONS.find((p) => p.key === k)!.short).join(", ")}`, price: `${t.price}${t.key === "platinum" ? "" : "/mo"}` })) },
    {
      title: "Their own",
      items: [
        { value: "sprint", label: "Sprint", detail: current === "sprint" && summary ? summary : "A set scope until a day, then a tier or nothing", more: true },
        { value: "custom", label: "Custom numbers", detail: current === "custom" && summary ? summary : "Each pool set by hand, one number or a range", more: true },
        { value: STRATEGY, label: "Strategy only", detail: "No posts made: no allotment, no requests" },
      ],
    },
  ];

  const pick = (v: string) => {
    if (v === "custom" || v === "sprint") return setOpen(v);
    setOpen(null);
    if (v === STRATEGY) return run(() => setStrategyOnly(clientId, slug, "social-media", true), undefined, STRATEGY);
    if (isSocialTier(v)) run(() => setSocialTier(clientId, slug, { tier: v }), undefined, v);
  };
  const numberBoxes = (
    <>
      <Num label="Posts" value={custom.posts} onChange={(v) => setCustom((x) => ({ ...x, posts: v }))} />
      <Num label="Statics" value={custom.statics} onChange={(v) => setCustom((x) => ({ ...x, statics: v }))} />
      <Num label="Video/reels" value={custom.videos} onChange={(v) => setCustom((x) => ({ ...x, videos: v }))} />
      <Num label="IG stories" value={custom.stories} onChange={(v) => setCustom((x) => ({ ...x, stories: v }))} />
    </>
  );
  const cancel = (
    <button type="button" onClick={() => setOpen(null)} className="min-h-10 px-1 text-[11px] text-faint hover:text-fg md:min-h-0">
      Cancel
    </button>
  );
  const shownNow = open ?? shown ?? current;
  const onTier = isSocialTier(shownNow);

  return (
    <span className="grid gap-2">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <TierMenu label="Social tier" value={shownNow} groups={groups} onPick={pick} disabled={pending} empty="Pick a tier" />
        <Status pending={pending} saved={saved && !open} error={error} />
      </span>
      {!open && summary && <span className="text-[11px] leading-snug text-faint">{summary}</span>}
      {!open && onTier && (
        <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
          Added video/reels
          <span className="inline-flex items-center rounded-full border border-line bg-bg">
            <button type="button" aria-label="One fewer added video" disabled={pending || extraVideos <= 0} onClick={() => { const n = extraVideos - 1; setExtra(n); run(() => setSocialExtraVideos(clientId, slug, n)); }} className="h-9 w-9 text-muted hover:text-fg disabled:opacity-40 md:h-6 md:w-6">
              −
            </button>
            <span className="tabular min-w-5 text-center text-fg">{extraVideos}</span>
            <button type="button" aria-label="One more added video" disabled={pending || extraVideos >= 60} onClick={() => { const n = extraVideos + 1; setExtra(n); run(() => setSocialExtraVideos(clientId, slug, n)); }} className="h-9 w-9 text-muted hover:text-fg disabled:opacity-40 md:h-6 md:w-6">
              +
            </button>
          </span>
          {extraVideos > 0 && <span>${(extraVideos * ADDON_PRICE).toLocaleString("en-US")}/mo add-on</span>}
        </span>
      )}
      {open === "sprint" && (
        <Panel note="What the sprint holds each month, as one number or a range (3-5). It ends on its day: the client moves to the tier picked, or holds no social allotment.">
          <label className="flex items-center gap-1.5 text-[11px] text-faint">
            Until
            <input type="date" value={until} min={today()} onChange={(e) => setUntil(e.target.value)} className={dateBox} />
          </label>
          {numberBoxes}
          <Pills label="Then" value={after} options={[{ value: "none", label: "Nothing" }, ...SOCIAL_TIERS.map((t) => ({ value: t.key, label: t.label }))]} onChange={setAfter} />
          <button type="button" disabled={pending || !until} onClick={() => run(() => setSocialTier(clientId, slug, { tier: "sprint", until, custom: pools(), after: after === "none" ? null : after }), () => setOpen(null), "sprint")} className={btn}>
            Start sprint
          </button>
          {cancel}
        </Panel>
      )}
      {open === "custom" && (
        <Panel note="A month each, as one number or a range (3-5). Leave a pool empty when they don't buy it.">
          {numberBoxes}
          <button type="button" disabled={pending} onClick={() => run(() => setSocialTier(clientId, slug, { tier: "custom", custom: pools() }), () => setOpen(null), "custom")} className={btn}>
            Save
          </button>
          {cancel}
        </Panel>
      )}
      {current !== STRATEGY && shown !== STRATEGY && (
        <PlatformPicks
          value={list}
          tierKey={tierKey}
          own={Boolean(ownPlatforms)}
          canEdit
          pending={pending}
          onSave={(next) => {
            setPlatforms({ list: next });
            run(() => setSocialPlatforms(clientId, slug, next));
          }}
        />
      )}
      {current !== STRATEGY && shown !== STRATEGY && <SocialMeter a={value.allotment} />}
      {error && <span className="text-[11px] text-bad">{error}</span>}
    </span>
  );
}
