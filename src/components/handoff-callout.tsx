import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";

// On a buyer's home: accounts just handed to them, each with its handoff (ready to read, or being written). Stays
// until they've opened it, then a week as a quieter link.

type Row = { id: string; kind: string; status: string; created_at: string; seen_at: string | null; doc: { headline?: string } | null; clients: { name: string } | null; from: { full_name: string } | null };

const weekAgo = () => new Date(Date.now() - 7 * 86_400_000).toISOString();

export async function HandoffCallout({ db, me }: { db: SupabaseClient; me: string }) {
  const since = weekAgo();
  const { data } = await db
    .from("account_handoffs")
    .select("id, kind, status, created_at, seen_at, doc, clients(name), from:profiles!account_handoffs_from_id_fkey(full_name)")
    .eq("to_id", me)
    .or(`seen_at.is.null,created_at.gte.${since}`)
    .order("created_at", { ascending: false })
    .limit(6);
  const rows = (data ?? []) as unknown as Row[];
  if (!rows.length) return null;
  const fresh = rows.filter((r) => !r.seen_at);
  return (
    <section className="grid gap-4 rounded-[20px] border border-line bg-surface p-5 md:p-6">
      <div className="grid gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-brand-text">Handoff</span>
        <h2 className="font-heading text-xl">
          {fresh.length ? `${fresh.length} ${fresh.length === 1 ? "account is" : "accounts are"} yours now` : "Accounts handed to you this week"}
        </h2>
        <p className="text-sm text-muted">Everything about each client up to now, in one doc you can save as a PDF, with a chat to ask what it doesn&apos;t cover.</p>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {rows.map((r) => (
          <Link
            key={r.id}
            href={`/handoff/${r.id}`}
            className={`group grid gap-1 rounded-[14px] border px-4 py-3 transition-colors ${r.seen_at ? "border-line hover:border-faint" : "border-brand/40 bg-brand-soft/20 hover:border-brand/70"}`}
          >
            <span className="flex items-center justify-between gap-3">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium">{r.clients?.name}</span>
                {r.kind === "comeback" && <span className="shrink-0 rounded-full bg-ok-soft px-2 py-0.5 text-[10px] text-ok">Back live</span>}
              </span>
              <span className={`shrink-0 text-[11px] ${r.status === "ready" ? (r.seen_at ? "text-faint" : "text-brand-text") : r.status === "failed" ? "text-bad" : "text-muted"}`}>
                {r.status === "ready" ? (r.seen_at ? "Read" : "Ready to read →") : r.status === "failed" ? "Needs a retry" : "Being written…"}
              </span>
            </span>
            <span className="line-clamp-2 text-xs text-muted">{r.doc?.headline ?? (r.kind === "comeback" ? "Where we left it and how to pick it back up" : r.from ? `From ${r.from.full_name}` : "Newly assigned to you")}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
