import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import { loadWatch, WATCH_GROUP, type WatchFlag } from "@/lib/account-watch/load";

// The account watch on the Overview: the exec Overview leads with what's billed and idle (retention and refunds first),
// a buyer's or head's desk gets a Watch tab with their own lines' flags. Everything opens the Account watch page.

const DOT = { critical: "bg-bad", warn: "bg-warn", info: "bg-brand" } as const;

function Rows({ flags }: { flags: WatchFlag[] }) {
  return (
    <ul className="grid gap-px overflow-hidden rounded-[18px] border border-line bg-line">
      {flags.map((f) => (
        <li key={f.id}>
          <Link href={`/watch?tab=${WATCH_GROUP[f.kind] ?? "idle"}&client=${f.slug}`} className="flex min-h-11 items-start gap-3 bg-surface px-4 py-3 hover:bg-surface-2">
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[f.severity]}`} />
            <span className="grid min-w-0">
              <span className="truncate font-heading text-[15px]">{f.client}</span>
              <span className="text-[13px] text-muted">{f.title}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Account watch flags as a titled list (a creative lead's Today: flags on clients without a row of their own) */
export function WatchList({ flags }: { flags: WatchFlag[] }) {
  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-heading text-xl">
          Account watch <span className="tabular text-[15px] text-faint">{flags.length}</span>
        </h2>
        <Link href="/watch" className="inline-flex min-h-11 items-center text-sm text-muted hover:text-fg md:min-h-0">
          All of it →
        </Link>
      </div>
      <Rows flags={flags.slice(0, 12)} />
    </section>
  );
}

/** The exec Overview: billed but idle, critical first, above the rest */
export async function WatchCallout({ db, me }: { db: SupabaseClient; me: Staff }) {
  const { flags } = await loadWatch(db, me).catch(() => ({ flags: [] as WatchFlag[] }));
  const shown = flags.filter((f) => f.severity === "critical");
  if (!shown.length) return null;
  const idle = shown.filter((f) => f.kind === "idle").length;
  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-heading text-xl">
          Account watch <span className="tabular text-[15px] text-bad">{shown.length}</span>
        </h2>
        <Link href="/watch" className="inline-flex min-h-11 items-center text-sm text-muted hover:text-fg md:min-h-0">
          {idle ? `${idle} billed with nothing happening` : "Open"} →
        </Link>
      </div>
      <Rows flags={shown.slice(0, 6)} />
    </section>
  );
}

/** A buyer's or head's desk tab: their own lines' open flags */
export async function watchTab(db: SupabaseClient, me: { id: string; role: string; isExec: boolean; isLead: boolean }) {
  const { flags } = await loadWatch(db, me).catch(() => ({ flags: [] as WatchFlag[] }));
  const mine = flags.filter((f) => f.kind !== "unrecognized" || me.isExec);
  return {
    tab: { id: "watch", label: "Watch", count: mine.length, tone: mine.some((f) => f.severity === "critical") ? ("bad" as const) : ("warn" as const) },
    panel: mine.length ? (
      <section className="grid gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-heading text-xl">Account watch</h2>
          <Link href="/watch" className="inline-flex min-h-11 items-center text-sm text-muted hover:text-fg md:min-h-0">
            All of it →
          </Link>
        </div>
        <Rows flags={mine.slice(0, 30)} />
      </section>
    ) : (
      <section className="grid justify-items-start gap-2 rounded-[20px] border border-dashed border-line p-6">
        <p className="font-heading text-lg">Nothing to watch</p>
        <p className="text-sm text-muted">Every account you&apos;re on is moving, touched lately and spending steadily.</p>
      </section>
    ),
  };
}
