import Link from "next/link";
import { tintFor } from "@/lib/colors";
import type { Freshness } from "@/lib/dates";
import { SLOTS, type SlotRole } from "@/lib/roles";
import { AssignSelect, type Option } from "./assign-select";

export type ClientCard = {
  id: string;
  name: string;
  slug: string;
  status: string;
  whiteLabel: boolean;
  packageLabel: string | null;
  images: { used: number; cap: number };
  videos: { used: number; cap: number };
  inFlight: number;
  contacts: number;
  live: { meta: Freshness["tone"] | null; slack: Freshness["tone"] | null; drive: Freshness["tone"] | null };
  assigned: Record<SlotRole, Option | null>;
};

const DOT = { ok: "bg-ok shadow-[0_0_0_3px_var(--ok-soft)]", warn: "bg-warn", off: "bg-faint/50" } as const;

function Meter({ label, used, cap }: { label: string; used: number; cap: number }) {
  const over = used > cap;
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-faint">{label}</span>
        <span className="tabular">
          <span className={over ? "text-bad" : "text-fg"}>{used}</span>
          <span className="text-faint"> / {cap}</span>
        </span>
      </div>
      <span className="h-1 overflow-hidden rounded-full bg-surface-2">
        <span className={`block h-full rounded-full ${over ? "bg-bad" : "bg-brand"}`} style={{ width: `${cap ? Math.min(100, (used / cap) * 100) : used ? 100 : 0}%` }} />
      </span>
    </div>
  );
}

function Light({ label, tone }: { label: string; tone: Freshness["tone"] | null }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] ${tone ? "text-muted" : "text-faint/70"}`} title={tone ? `${label}: ${tone === "ok" ? "live" : tone === "warn" ? "behind" : "not synced yet"}` : `${label}: not linked`}>
      <span className={`h-1.5 w-1.5 rounded-full ${tone ? DOT[tone] : "border border-faint/50"}`} />
      {label}
    </span>
  );
}

/** Creative clients as cards: package, allotment, what's in flight, live connections, and the team. */
export function ClientGrid({ cards, slotOptions, canEdit }: { cards: ClientCard[]; slotOptions: Record<SlotRole, Option[]>; canEdit: boolean }) {
  return (
    <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {cards.map((c) => {
        const tint = tintFor(c.name);
        return (
          <li
            key={c.id}
            className={`group relative grid content-start gap-5 overflow-hidden rounded-[14px] border border-line bg-surface p-5 transition-colors hover:border-faint/70 ${c.status === "paused" ? "opacity-60" : ""}`}
          >
            {/* A wash of the client's color along the top */}
            <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-24 opacity-[0.10]" style={{ background: `linear-gradient(180deg, ${tint}, transparent)` }} />

            <div className="relative flex items-start gap-3">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[10px] font-heading text-lg" style={{ background: `${tint}26`, color: tint }}>
                {c.name.replace(/[^A-Za-z0-9]/g, "").slice(0, 1).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <Link href={`/clients/${c.slug}`} className="block truncate font-heading text-[17px] leading-snug hover:text-brand-text">
                  {c.name}
                </Link>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-faint">
                  <span className="text-muted">{c.packageLabel ?? "Creative"}</span>
                  {c.status !== "active" && <span className="capitalize">· {c.status}</span>}
                  {c.whiteLabel && <span>· White label</span>}
                </p>
              </div>
              <Link
                href={`/board?client=${c.slug}`}
                className={`shrink-0 rounded-full px-2.5 py-1 text-xs tabular transition-colors ${c.inFlight ? "bg-brand-soft text-brand-text hover:bg-brand/25" : "bg-surface-2 text-faint hover:text-fg"}`}
                title="Open on the board"
              >
                {c.inFlight ? `${c.inFlight} in flight` : "Nothing in flight"}
              </Link>
            </div>

            <div className="relative grid grid-cols-2 gap-4">
              <Meter label="Images" used={c.images.used} cap={c.images.cap} />
              <Meter label="Videos" used={c.videos.used} cap={c.videos.cap} />
            </div>

            <div className="relative flex flex-wrap items-center gap-x-4 gap-y-1">
              <Light label="Meta" tone={c.live.meta} />
              <Light label="Slack" tone={c.live.slack} />
              <Light label="Drive" tone={c.live.drive} />
            </div>

            <dl className="relative grid gap-0.5 border-t border-line pt-4">
              {SLOTS.map((s) => (
                <div key={s.value} className="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-2">
                  <dt className="text-xs text-faint">{s.label}</dt>
                  <dd className="min-w-0">
                    <AssignSelect clientId={c.id} slot={s.value} label={s.label} current={c.assigned[s.value]} options={slotOptions[s.value]} canEdit={canEdit} />
                  </dd>
                </div>
              ))}
            </dl>

            <div className="relative -mt-1 flex items-center justify-between text-xs">
              {c.contacts ? (
                <span className="text-faint">
                  {c.contacts} client contact{c.contacts === 1 ? "" : "s"}
                </span>
              ) : (
                <Link href={`/clients/${c.slug}`} className="text-warn hover:underline">
                  No client contacts yet
                </Link>
              )}
              <Link href={`/clients/${c.slug}`} className="text-muted opacity-0 transition-opacity hover:text-fg group-hover:opacity-100 focus:opacity-100">
                Open →
              </Link>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export type OtherClient = { id: string; name: string; slug: string; status: string; whiteLabel: boolean; buyer: string | null };

/** Clients not on a creative package: the upsell list. */
export function UpsellList({ clients }: { clients: OtherClient[] }) {
  return (
    <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {clients.map((c) => {
        const tint = tintFor(c.name);
        return (
          <li key={c.id}>
            <Link
              href={`/clients/${c.slug}`}
              className="flex items-center gap-3 rounded-[10px] border border-line bg-surface px-4 py-3 transition-colors hover:border-faint/70"
            >
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[8px] text-sm font-semibold" style={{ background: `${tint}1f`, color: tint }}>
                {c.name.replace(/[^A-Za-z0-9]/g, "").slice(0, 1).toUpperCase()}
              </span>
              <span className="grid min-w-0 flex-1">
                <span className="truncate text-sm">{c.name}</span>
                <span className="truncate text-xs text-faint">
                  <span className="capitalize">{c.status}</span>
                  {c.whiteLabel && " · White label"}
                  {c.buyer && ` · ${c.buyer}`}
                </span>
              </span>
              <span className="shrink-0 text-[11px] text-faint">No package</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
