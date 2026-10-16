import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { loadPlaybook, playbookExamples } from "@/lib/playbooks";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { parentNames, type Benchmark } from "@/lib/verticals";
import { PlaybookView } from "../../playbook-view";
import { PlaybookActions } from "./playbook-actions";

export const metadata: Metadata = { title: "Playbook" };
export const maxDuration = 300;

/** A sub-vertical's playbook, for the team (names shown, links to the ads). */
export default async function PlaybookPage({ params }: PageProps<"/ideas/playbook/[id]">) {
  const { id } = await params;
  const me = await requireStaff();
  const db = adminConfigured() ? createAdminClient() : await createClient();
  const { data: sub } = await db.from("verticals").select("id, name, benchmarks, parent_id").eq("id", id).maybeSingle();
  if (!sub) notFound();
  const parent = (await parentNames(db, [sub.parent_id])).get(sub.parent_id) ?? null;
  const playbook = await loadPlaybook(db, id);
  const lead = me.isExec || me.isLead;
  const back = (
    <Link href="/ideas?tab=verticals" className="text-sm text-muted hover:text-fg">
      ← Verticals
    </Link>
  );
  if (!playbook?.avatars.length)
    return (
      <div className="mx-auto grid max-w-5xl gap-6">
        {back}
        <div className="grid place-items-center gap-3 rounded-[16px] border border-dashed border-line px-6 py-16 text-center">
          <p className="font-medium">{sub.name}: the playbook isn&apos;t written yet</p>
          <p className="max-w-md text-sm text-muted">
            It&apos;s built from this sub-vertical&apos;s client strategies, our Hall of Fame and market ads live 30+ days. The AI writes a couple every hour as those come in.
          </p>
          {lead && <PlaybookActions subId={id} canRebuild canShare={false} />}
        </div>
      </div>
    );
  const examples = await playbookExamples(db, playbook);
  return (
    <div className="grid gap-6">
      <div className="mx-auto w-full max-w-6xl">{back}</div>
      <PlaybookView
        title={sub.name}
        parent={parent}
        playbook={playbook}
        examples={examples}
        named
        benchmarks={(sub.benchmarks ?? []) as Benchmark[]}
        actions={<PlaybookActions subId={id} canRebuild={lead} />}
      />
    </div>
  );
}
