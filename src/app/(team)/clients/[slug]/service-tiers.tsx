"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { setCreativeTier, setEmailTier, setStrategyOnly } from "./tier-actions";

// The tier pickers in the Services panel, the one place every service's tier is set (owner, Nov 19 2026):
//   Email: 3-Month Initial Setup (its start month, then the ongoing tier), a Sprint (its own numbers until a day, then
//          a tier or nothing), Basic, Silver, Gold, Custom (each pool's numbers), or Strategy only, no deliverables.
//   Creative: a package, Custom (images and videos a month), a sprint until a day, or Strategy only.
//   Any other service: Strategy only, no deliverables, beside its tier.
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

type MenuItem = { value: string; label: string; detail?: string; price?: string; more?: boolean };
type MenuGroup = { title: string; items: MenuItem[] };

/** The tier menu: the current tier as a quiet button, and a panel of grouped rows (what each holds, its price) */
function TierMenu({ label, value, groups, onPick, disabled, empty }: { label: string; value: string; groups: MenuGroup[]; onPick: (v: string) => void; disabled?: boolean; empty: string }) {
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
  const { pending, error, run, shown, saved } = useSave();
  const both = (i: number, v: number) => [i && `${i} images`, v && `${v} videos`].filter(Boolean).join(" + ") || "no allotment";
  const summary = strategy ? "Strategy only, no design: no allotment or briefs" : creative.label ? `${creative.label}${creative.until ? ` (sprint until ${dayLabel(creative.until)})` : ""}` : "No package set";

  if (!canEdit) return <span className="text-xs text-muted">{summary}</span>;

  const groups: MenuGroup[] = [
    { title: "Packages", items: packages.map((pk) => ({ value: pk.key, label: pk.label, detail: `${both(pk.images, pk.videos)} a month` })) },
    {
      title: "Their own",
      items: [
        { value: "sprint", label: "Sprint", detail: current === "sprint" ? summary : "A package or numbers until a day", more: true },
        { value: "custom", label: "Custom numbers", detail: current === "custom" && creative.label ? creative.label : "Images and videos a month, set by hand", more: true },
        { value: STRATEGY, label: "Strategy only", detail: "No design: no allotment, no briefs" },
      ],
    },
  ];

  const pick = (v: string) => {
    if (v === "custom" || v === "sprint") return setOpen(v);
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
      {(current === STRATEGY || current === "sprint" || current === "custom") && !open && <span className="text-[11px] leading-snug text-faint">{summary}</span>}
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

// ─── Any service ─────────────────────────────────────────────────────────────

/** Strategy only, no deliverables: on (no allotment, alerts or requests for it) or back to deliverables */
export function StrategyToggle({ clientId, slug, service, on, canEdit }: { clientId: string; slug: string; service: string; on: boolean; canEdit: boolean }) {
  const { pending, error, run, shown } = useSave();
  const isOn = shown == null ? on : shown === "on";
  if (!canEdit) return on ? <span className="text-xs text-muted">Strategy only, no deliverables</span> : null;
  return (
    <span className="inline-flex items-center gap-2">
      <label className="inline-flex min-h-10 cursor-pointer items-center gap-1.5 text-[11px] text-faint hover:text-fg md:min-h-0">
        <input type="checkbox" checked={isOn} disabled={pending} onChange={(e) => { const next = e.target.checked; run(() => setStrategyOnly(clientId, slug, service, next), undefined, next ? "on" : "off"); }} className="h-3.5 w-3.5 accent-[var(--color-brand,#c8102e)]" />
        Strategy only, no deliverables
      </label>
      {error && <span className="text-[11px] text-bad">{error}</span>}
    </span>
  );
}
