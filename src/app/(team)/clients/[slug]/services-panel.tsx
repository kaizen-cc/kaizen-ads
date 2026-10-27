"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { SERVICES } from "@/lib/services";
import { addServiceTier, setClientService, setServiceTier } from "./actions";

// What the client buys, at a glance: every service Kaizen sells, lit when they have it, with its tier. Kaizen Track's
// services come in on their own (and end there); execs and leads add the rest here and pick each one's tier, adding a
// tier when a new one is sold. Creative's tier is its creative package, set on the Creative tab.

export type Tier = { id: string; service: string; label: string; includes: string | null };

const ICON: Record<string, string> = {
  "facebook-ads": "M14 8h3V4h-3a4 4 0 0 0-4 4v2H8v4h2v6h4v-6h3l1-4h-4V8z",
  "google-ads": "M12 4l8 14H4z M9 18l3-5",
  "tiktok-ads": "M14 4v10a3 3 0 1 1-3-3 M14 4c0 2.5 2 4.5 4.5 4.5",
  creative: "M4 16l4-4 3 3 5-6 4 5 M4 5h16v14H4z",
  "email-marketing": "M4 6h16v12H4z M4 7l8 6 8-6",
  "web-design": "M4 5h16v14H4z M4 9h16 M7 7h.01 M9.5 7h.01",
  "social-media": "M7 12a2 2 0 1 0 0 .01 M17 7a2 2 0 1 0 0 .01 M17 17a2 2 0 1 0 0 .01 M8.8 11l6.4-3 M8.8 13l6.4 3",
  crm: "M8 9a3 3 0 1 0 0 .01 M3 19c0-3 2.5-5 5-5s5 2 5 5 M16 8h5 M16 12h5 M18 16h3",
};

export function ServiceIcon({ slug, className = "" }: { slug: string; className?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d={ICON[slug] ?? "M12 12h.01"} />
    </svg>
  );
}

export function ServicesPanel({
  clientId,
  slug,
  track,
  extra,
  tiers: allTiers,
  chosen,
  creative,
  canEdit,
}: {
  clientId: string;
  slug: string;
  track: string[];
  extra: string[];
  tiers: Tier[];
  chosen: Record<string, string>; // service → tier id
  creative: { label: string | null; active: boolean; until: string | null };
  canEdit: boolean;
}) {
  const router = useRouter();
  const [mine, setMine] = useState(() => new Set([...track, ...extra]));
  const [tiers, setTiers] = useState(allTiers);
  const [picked, setPicked] = useState(chosen);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const on = SERVICES.filter((s) => mine.has(s.slug));
  const off = SERVICES.filter((s) => !mine.has(s.slug));

  const toggle = (service: string, next: boolean) =>
    start(async () => {
      setError(null);
      setMine((m) => {
        const n = new Set(m);
        if (next) n.add(service);
        else n.delete(service);
        return n;
      });
      const r = await setClientService(clientId, slug, service, next);
      if (!r.ok) {
        setError(r.error);
        setMine((m) => {
          const n = new Set(m);
          if (next) n.delete(service);
          else n.add(service);
          return n;
        });
      } else router.refresh();
    });

  const pickTier = (service: string, tierId: string | null) =>
    start(async () => {
      setError(null);
      const before = picked[service];
      setPicked((p) => {
        const n = { ...p };
        if (tierId) n[service] = tierId;
        else delete n[service];
        return n;
      });
      const r = await setServiceTier(clientId, slug, service, tierId);
      if (!r.ok) {
        setError(r.error);
        setPicked((p) => ({ ...p, ...(before ? { [service]: before } : {}) }));
      }
    });

  return (
    <div className="grid gap-4">
      {on.length === 0 ? (
        <p className="rounded-[12px] border border-dashed border-line px-4 py-5 text-center text-sm text-faint">No services on file. Kaizen Track doesn&apos;t have this client{canEdit ? "; add what they buy below." : "."}</p>
      ) : (
        <ul className="grid gap-2">
          {on.map((s) => {
            const fromTrack = track.includes(s.slug);
            return (
              <li key={s.slug} className="flex flex-wrap items-center gap-3 rounded-[14px] border border-line bg-gradient-to-r from-ink/[0.035] to-transparent px-3.5 py-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-brand/15 text-brand-text">
                  <ServiceIcon slug={s.slug} />
                </span>
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {s.label}
                    <span className={`rounded-full px-1.5 py-px text-[10px] font-normal ${fromTrack ? "bg-surface-2 text-faint" : "bg-warn-soft text-warn"}`}>{fromTrack ? "Track" : "Added here"}</span>
                  </span>
                  {s.slug === "creative" ? (
                    <span className="text-xs text-muted">
                      {creative.label ? `${creative.label} package${creative.until ? ` until ${creative.until}` : ""}` : "No package set"}
                      {" · "}
                      <Link href={`/clients/${slug}?tab=creative`} className="text-faint underline-offset-2 hover:text-fg hover:underline">
                        {creative.label ? "change" : "set it"} on Creative
                      </Link>
                    </span>
                  ) : (
                    <TierPick
                      service={s.slug}
                      tiers={tiers.filter((t) => t.service === s.slug)}
                      value={picked[s.slug] ?? null}
                      canEdit={canEdit}
                      onPick={(id) => pickTier(s.slug, id)}
                      onAdded={(t) => {
                        setTiers((all) => [...all, t]);
                        pickTier(s.slug, t.id);
                      }}
                    />
                  )}
                </span>
                {canEdit && !fromTrack && (
                  <button type="button" onClick={() => toggle(s.slug, false)} disabled={pending} className="min-h-11 px-2 text-xs text-faint hover:text-fg md:min-h-0 md:px-0">
                    Remove
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {canEdit && off.length > 0 && (
        <div className="grid gap-2">
          <p className="text-[11px] uppercase tracking-[0.14em] text-faint">Not on</p>
          <div className="flex flex-wrap gap-1.5">
            {off.map((s) => (
              <button
                key={s.slug}
                type="button"
                disabled={pending}
                onClick={() => toggle(s.slug, true)}
                className="inline-flex h-11 items-center gap-1.5 rounded-full border border-dashed border-line px-3.5 text-xs md:h-8 md:px-3 text-faint transition-colors hover:border-faint hover:text-fg disabled:opacity-50"
              >
                <ServiceIcon slug={s.slug} className="h-3.5 w-3.5" />
                {s.short}
                <span className="text-[13px] leading-none">+</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {!canEdit && off.length > 0 && on.length > 0 && <p className="text-xs text-faint">Not on: {off.map((s) => s.short).join(", ")}</p>}
      {error && <p className="text-xs text-bad">{error}</p>}
    </div>
  );
}

/** A service's tier: pick one, or (execs and leads) add a new one as it's sold. */
function TierPick({ service, tiers, value, canEdit, onPick, onAdded }: { service: string; tiers: Tier[]; value: string | null; canEdit: boolean; onPick: (id: string | null) => void; onAdded: (t: Tier) => void }) {
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [includes, setIncludes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const current = tiers.find((t) => t.id === value);

  if (!canEdit) return <span className="text-xs text-muted">{current ? `${current.label}${current.includes ? ` · ${current.includes}` : ""}` : "No tier set"}</span>;

  if (adding)
    return (
      <span className="grid gap-1.5 pt-1">
        <span className="flex flex-wrap gap-1.5">
          <input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Tier name, e.g. Growth" className="h-11 w-full rounded-[8px] border border-line bg-bg px-2.5 text-xs outline-none focus:border-brand/60 md:h-8 md:w-36" />
          <input value={includes} onChange={(e) => setIncludes(e.target.value)} placeholder="What it includes" className="h-11 min-w-0 flex-1 rounded-[8px] border border-line bg-bg px-2.5 text-xs outline-none focus:border-brand/60 md:h-8" />
        </span>
        <span className="flex items-center gap-2">
          <button
            type="button"
            disabled={pending || !label.trim()}
            onClick={() =>
              start(async () => {
                const r = await addServiceTier(service, label, includes);
                if (!r.ok) return setError(r.error);
                onAdded({ ...r.tier, service });
                setAdding(false);
                setLabel("");
                setIncludes("");
              })
            }
            className="h-10 rounded-full bg-fg px-4 text-[11px] font-medium text-bg disabled:opacity-50 md:h-7 md:px-3"
          >
            {pending ? "Adding…" : "Add tier"}
          </button>
          <button type="button" onClick={() => setAdding(false)} className="min-h-10 px-1 text-[11px] text-faint hover:text-fg md:min-h-0 md:px-0">
            Cancel
          </button>
          {error && <span className="text-[11px] text-bad">{error}</span>}
        </span>
      </span>
    );

  return (
    <span className="relative inline-flex max-w-full items-center">
      <select
        value={value ?? ""}
        onChange={(e) => (e.target.value === "__new" ? setAdding(true) : onPick(e.target.value || null))}
        className="max-w-full cursor-pointer appearance-none truncate bg-transparent pr-5 text-xs text-muted outline-none hover:text-fg max-md:min-h-10"
      >
        <option value="">{tiers.length ? "Pick a tier" : "No tiers yet"}</option>
        {tiers.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
            {t.includes ? ` · ${t.includes}` : ""}
          </option>
        ))}
        <option value="__new">+ New tier…</option>
      </select>
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" className="pointer-events-none absolute right-0 text-faint" aria-hidden>
        <path d="M6 9l6 6 6-6" />
      </svg>
    </span>
  );
}
