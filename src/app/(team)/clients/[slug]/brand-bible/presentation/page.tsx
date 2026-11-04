import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { inNewFlow, type Deck, type Reactions } from "@/lib/presentation-types";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { PresentationAdmin, type Version } from "./presentation-admin";

// The client presentation, the team's side: exactly what the client will see, where it stands (writing, ready, held,
// sent, opened, approved), and sending, holding, changing or rewriting it. A new version written after the one with
// the client (from a rebuilt Bible) is shown beside it (?version=<id>), and older drafts are kept as history.

export const maxDuration = 300;

/** How long a presentation usually takes to write: the AI's usual time for it, plus the swipe file and saving */
async function expectedMs() {
  if (!adminConfigured()) return 60_000;
  const { data } = await createAdminClient().from("ai_runs").select("ms").like("label", "client presentation %").eq("ok", true).order("created_at", { ascending: false }).limit(20);
  const ms = (data ?? []).map((r) => r.ms as number).filter((n) => n > 0);
  return ms.length ? Math.round((ms.reduce((a, b) => a + b, 0) / ms.length) * 1.25 + 15_000) : 60_000;
}

export default async function PresentationPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ version?: string }> }) {
  await requireStaff();
  const [{ slug }, { version }] = await Promise.all([params, searchParams]);
  const supabase = await createClient();
  const { data: client } = await supabase.from("clients").select("id, name, slug, status, kaizen_id, created_at, reonboarded_at").eq("slug", slug).maybeSingle();
  if (!client) notFound();
  const [{ data: p }, { data: b }, { data: versions }, expected] = await Promise.all([
    supabase.from("client_presentations").select("status, deck, reactions, without_intake, drafted_at, send_after, sent_at, sent_to, viewed_at, approved_at, error, started_at, bible_version").eq("client_id", client.id).maybeSingle(),
    supabase.from("client_brand_bibles").select("markdown, version").eq("client_id", client.id).maybeSingle(),
    supabase.from("client_presentation_versions").select("id, status, deck, without_intake, bible_version, error, started_at, drafted_at").eq("client_id", client.id).order("started_at", { ascending: false }).limit(12),
    expectedMs(),
  ]);
  const list: Version[] = (versions ?? []).map((v) => ({
    id: v.id as string,
    status: v.status as Version["status"],
    deck: (v.deck ?? null) as Deck | null,
    withoutIntake: Boolean(v.without_intake),
    bibleVersion: (v.bible_version as string | null) ?? null,
    error: (v.error as string | null) ?? null,
    startedAt: v.started_at as string,
    draftedAt: (v.drafted_at as string | null) ?? null,
  }));
  return (
    <PresentationAdmin
      client={{ id: client.id, name: client.name, slug: client.slug, kaizenId: client.kaizen_id ?? null }}
      hasBible={Boolean(b?.markdown)}
      bibleVersion={(b?.version as string | null) ?? null}
      // Only a new client in the new onboarding is sent on its own; everyone else's is sent by a person
      autoSend={client.status === "onboarding" && inNewFlow(client)}
      expectedMs={expected}
      versions={list}
      showing={list.find((v) => v.id === version && v.deck) ?? null}
      p={
        p
          ? {
              status: p.status as "writing" | "draft" | "held" | "sent" | "approved" | "failed",
              deck: (p.deck ?? null) as Deck | null,
              reactions: (p.reactions ?? {}) as Reactions,
              sendAfter: p.send_after,
              sentAt: p.sent_at,
              sentTo: (p.sent_to ?? []) as string[],
              viewedAt: p.viewed_at,
              approvedAt: p.approved_at,
              error: p.error,
              withoutIntake: Boolean(p.without_intake),
              startedAt: p.started_at,
              draftedAt: p.drafted_at,
              bibleVersion: (p.bible_version as string | null) ?? null,
            }
          : null
      }
    />
  );
}
