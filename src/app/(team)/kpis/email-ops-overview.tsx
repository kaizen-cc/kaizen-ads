import Link from "next/link";
import { activeSprints, latestAudits, loadSuggestions } from "@/lib/email-ops/load";
import { createClient } from "@/lib/supabase/server";
import { EmailOpsSuggestions } from "../clients/[slug]/email-ops-suggestions";

// For the email Overview and the Email board: what the audits and sprints say across the person's clients (worst score
// first), and the campaign ideas waiting on someone. `clients` is the list the page already scopes to the person; the
// reads here go through their own session, so RLS limits them to the clients they can see either way.

const BAND = { bad: "text-bad", watch: "text-warn", good: "text-ok" } as const;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });

export async function EmailOpsOverview({ clients }: { clients: { id: string; name: string; slug: string }[] }) {
  const ids = clients.map((c) => c.id);
  const db = await createClient();
  const [audits, sprints, suggestions] = await Promise.all([latestAudits(db, ids), activeSprints(db, ids), loadSuggestions(db, ids, 40)]);
  const rows = clients
    .map((c) => ({ c, a: audits.get(c.id) ?? null, s: sprints.get(c.id) ?? null }))
    .filter((r) => r.a && (r.a.status !== "ready" || r.a.band !== "good" || r.s))
    .sort((x, y) => (x.a?.score ?? 101) - (y.a?.score ?? 101));
  const open = suggestions.filter((s) => s.status === "new" || s.status === "in_motion");
  if (!rows.length && !open.length) return null;
  return (
    <div className="grid gap-8">
      {rows.length > 0 && (
        <section className="grid gap-3">
          <h2 className="font-heading text-xl">Audits and sprints</h2>
          <ul className="grid gap-2">
            {rows.map(({ c, a, s }) => (
              <li key={c.id}>
                <Link href={s ? `/kpis/email-sprint/${s.id}` : `/kpis/email-audit/${a!.id}`} className="grid min-h-11 gap-1 rounded-[16px] border border-line bg-surface px-4 py-3 hover:border-faint md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                  <span className="grid min-w-0 gap-0.5">
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-heading">{c.name}</span>
                      {a?.status === "ready" && <span className={`font-display tabular ${a.band ? BAND[a.band] : ""}`}>{a.score}</span>}
                      {a?.status === "running" && <span className="text-[12px] text-muted">auditing…</span>}
                      {a?.status === "failed" && <span className="text-[12px] text-bad">audit didn&apos;t finish</span>}
                    </span>
                    <span className="truncate text-[12.5px] text-muted">{a?.headline ?? ""}</span>
                  </span>
                  <span className="text-[12px] text-faint">{s ? `Sprint: ${s.done} of ${s.moves} done · next check ${day(s.nextCheckAt)}` : a ? `${a.done} of ${a.actions} moves ticked · ${day(a.createdAt)}` : ""}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {open.length > 0 && <EmailOpsSuggestions suggestions={suggestions} showClient title="Campaign ideas across your clients" />}
    </div>
  );
}
