import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import type { Deck, Reactions } from "@/lib/presentation-types";
import { createClient } from "@/lib/supabase/server";
import { PresentationAdmin } from "./presentation-admin";

// The client presentation, the team's side: exactly what the client will see, where it stands (ready, held, sent,
// opened, approved), and sending, holding, changing or rewriting it.

export const maxDuration = 300;

export default async function PresentationPage({ params }: { params: Promise<{ slug: string }> }) {
  await requireStaff();
  const { slug } = await params;
  const supabase = await createClient();
  const { data: client } = await supabase.from("clients").select("id, name, slug, status").eq("slug", slug).maybeSingle();
  if (!client) notFound();
  const [{ data: p }, { data: b }] = await Promise.all([
    supabase.from("client_presentations").select("status, deck, reactions, drafted_at, send_after, sent_at, sent_to, viewed_at, approved_at, error, started_at").eq("client_id", client.id).maybeSingle(),
    supabase.from("client_brand_bibles").select("markdown").eq("client_id", client.id).maybeSingle(),
  ]);
  return (
    <PresentationAdmin
      client={{ id: client.id, name: client.name, slug: client.slug }}
      hasBible={Boolean(b?.markdown)}
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
            }
          : null
      }
    />
  );
}
