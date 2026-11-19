import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { seatJob } from "@/lib/handoff-roles";

// On someone's home: accounts just handed to them (any seat), each with its handoff (ready to read, or being written),
// staying until they've opened it, then a week as a quieter link. And accounts they're handing over: the checklist of
// what to pass on, until it's all ticked off (two weeks at most).

type Row = { id: string; kind: string; role: string | null; status: string; created_at: string; seen_at: string | null; doc: { headline?: string } | null; clients: { name: string } | null; from: { full_name: string } | null };
type Out = { id: string; role: string | null; checklist: unknown[] | null; doc: { handOver?: string[] } | null; clients: { name: string } | null; to: { full_name: string } | null };

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

export async function HandoffCallout({ db, me }: { db: SupabaseClient; me: string }) {
  const [{ data }, { data: going }] = await Promise.all([
    db
      .from("account_handoffs")
      .select("id, kind, role, status, created_at, seen_at, doc, clients(name), from:profiles!account_handoffs_from_id_fkey(full_name)")
      .eq("to_id", me)
      .or(`seen_at.is.null,created_at.gte.${daysAgo(7)}`)
      .order("created_at", { ascending: false })
      .limit(6),
    db
      .from("account_handoffs")
      .select("id, role, checklist, doc, clients(name), to:profiles!account_handoffs_to_id_fkey(full_name)")
      .eq("from_id", me)
      .eq("status", "ready")
      .gte("created_at", daysAgo(14))
      .order("created_at", { ascending: false })
      .limit(12),
  ]);
  const rows = (data ?? []) as unknown as Row[];
  const out = ((going ?? []) as unknown as Out[]).filter((o) => (o.doc?.handOver?.length ?? 0) > (o.checklist ?? []).length);
  if (!rows.length && !out.length) return null;
  const fresh = rows.filter((r) => !r.seen_at);
  return (
    <section className="grid gap-4 rounded-[20px] border border-line bg-surface p-5 md:p-6">
      {rows.length > 0 && (
        <>
          <div className="grid gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-brand-text">Handoff</span>
            <h2 className="font-heading text-xl">
              {fresh.length ? `${fresh.length} ${fresh.length === 1 ? "account is" : "accounts are"} yours now` : "Accounts handed to you this week"}
            </h2>
            <p className="text-sm text-muted">Everything outstanding on each client, what they&apos;ve said and what to tell them, in one doc you can save as a PDF, with a chat to ask what it doesn&apos;t cover.</p>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {rows.map((r) => (
              <Link
                key={r.id}
                href={`/handoff/${r.id}`}
                className={`group grid min-w-0 gap-1 rounded-[14px] border px-4 py-3 transition-colors ${r.seen_at ? "border-line hover:border-faint" : "border-brand/40 bg-brand-soft/20 hover:border-brand/70"}`}
              >
                <span className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium">{r.clients?.name}</span>
                    {r.kind === "comeback" ? <span className="shrink-0 rounded-full bg-ok-soft px-2 py-0.5 text-[10px] text-ok">Back live</span> : r.role && r.role !== "meta_buyer" ? <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] text-muted">{seatJob(r.role).label}</span> : null}
                  </span>
                  <span className={`shrink-0 text-[11px] ${r.status === "ready" ? (r.seen_at ? "text-faint" : "text-brand-text") : r.status === "failed" ? "text-bad" : "text-muted"}`}>
                    {r.status === "ready" ? (r.seen_at ? "Read" : "Ready to read →") : r.status === "failed" ? "Needs a retry" : "Being written…"}
                  </span>
                </span>
                <span className="line-clamp-2 text-xs text-muted">{r.doc?.headline ?? (r.kind === "comeback" ? "Where we left it and how to pick it back up" : r.from ? `From ${r.from.full_name}` : "Newly assigned to you")}</span>
              </Link>
            ))}
          </div>
        </>
      )}
      {out.length > 0 && (
        <div className="grid gap-2">
          <div className="grid gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-brand-text">Handing over</span>
            <p className="text-sm text-muted">What to pass on before you step away, so nothing drops for the client.</p>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {out.map((o) => (
              <Link key={o.id} href={`/handoff/${o.id}`} className="grid min-w-0 gap-1 rounded-[14px] border border-line px-4 py-3 transition-colors hover:border-faint">
                <span className="flex items-center justify-between gap-3">
                  <span className="truncate font-medium">{o.clients?.name}</span>
                  <span className="shrink-0 text-[11px] text-brand-text">
                    {(o.checklist ?? []).length} of {o.doc?.handOver?.length ?? 0} done →
                  </span>
                </span>
                <span className="truncate text-xs text-muted">
                  {seatJob(o.role ?? "meta_buyer").label} · to {o.to?.full_name ?? "the new person"}
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
