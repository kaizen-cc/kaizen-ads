import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { dueLabel, mixLine } from "@/lib/brief-drafting-core";
import { KIND_LABEL } from "@/lib/suggestion-kinds";

/**
 * The client's current brief, at the top of the Whole business Overview: the most urgent one the system drafted for
 * them and nobody has decided yet, with its real reason. Only the people who approve briefs see it (their own access
 * reads it); nothing shows when nothing waits.
 */
export async function CurrentBrief({ clientId }: { clientId: string }) {
  const db = await createClient();
  const { loadReady } = await import("@/lib/brief-drafting");
  const groups = await loadReady(db, { clientId, limit: 10 }).catch(() => []);
  const items = groups[0]?.items ?? [];
  const s = items[0];
  if (!s?.drafted) return null;
  const d = s.drafted;
  const today = new Date().toISOString().slice(0, 10);
  const due = dueLabel(d.deadline, today);
  return (
    <Link href={`/requests/new?approve=${s.id}`} className="group grid gap-2 rounded-[16px] border border-line bg-surface p-4 transition-colors hover:border-faint md:p-5">
      <span className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs uppercase tracking-[0.14em] text-faint">Current brief · ready to approve</span>
        <span className="rounded-full bg-ink/[0.06] px-2 py-0.5 text-[11px] text-muted">{KIND_LABEL[s.kind]}</span>
        {due && <span className="rounded-full bg-bad-soft px-2 py-0.5 text-[11px] font-medium text-bad">{due}</span>}
        {d.pace?.over && <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[11px] text-warn">Over this week&apos;s share</span>}
      </span>
      <span className="font-heading text-[19px] leading-snug">{s.draft.title}</span>
      {d.citation && <span className="line-clamp-2 text-sm text-muted">{d.citation.source === "call" || d.citation.source === "slack" || d.citation.source === "email" ? <>&ldquo;{d.citation.quote}&rdquo;</> : d.citation.quote}</span>}
      <span className="flex flex-wrap items-center justify-between gap-2 text-xs text-faint">
        <span>
          {d.mix ? mixLine(d.mix) : ""}
          {items.length > 1 ? ` · ${items.length - 1} more waiting` : ""}
        </span>
        <span className="text-fg transition-transform group-hover:translate-x-0.5">Review →</span>
      </span>
    </Link>
  );
}
