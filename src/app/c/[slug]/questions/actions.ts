"use server";

import { revalidatePath } from "next/cache";
import { getViewer } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// The client answers their brand plan's questions from the portal (a team member testing is marked as such)

async function load(slug: string) {
  const viewer = await getViewer();
  if (!adminConfigured()) return { error: "The portal isn't set up yet." } as const;
  const admin = createAdminClient();
  const { data: client } = await admin.from("clients").select("id, slug, portal_live").eq("slug", slug).maybeSingle();
  if (!client) return { error: "Not found." } as const;
  if (viewer.kind === "contact" && (!client.portal_live || !viewer.brands.some((b) => b.slug === slug))) return { error: "Not found." } as const;
  if (viewer.kind === "staff") {
    const { createClient } = await import("@/lib/supabase/server");
    const { data: mine } = await (await createClient()).from("clients").select("id").eq("id", client.id).maybeSingle();
    if (!mine) return { error: "Not found." } as const;
  }
  const by = viewer.kind === "contact" ? (viewer.fullName ?? viewer.email) : `${viewer.fullName} (team, testing)`;
  return { admin, clientId: client.id as string, by } as const;
}

export async function answerQuestion(slug: string, id: string, text: string) {
  const l = await load(slug);
  if ("error" in l) return { ok: false as const, error: l.error! };
  const { data: q } = await l.admin.from("bible_questions").select("stage").eq("id", id).eq("client_id", l.clientId).maybeSingle();
  if (!q || q.stage !== "client") return { ok: false as const, error: "That one's already with our team." };
  const { discussQuestion } = await import("@/lib/bible-questions");
  const r = await discussQuestion(l.admin, l.clientId, id, { text, by: l.by, via: "client" });
  revalidatePath(`/c/${slug}/questions`);
  return r;
}

/** "I don't know": it goes to the right person on our team */
export async function dontKnow(slug: string, id: string) {
  const l = await load(slug);
  if ("error" in l) return { ok: false as const, error: l.error! };
  const { data: q } = await l.admin.from("bible_questions").select("stage").eq("id", id).eq("client_id", l.clientId).maybeSingle();
  if (!q || q.stage !== "client") return { ok: true as const };
  const { passOn } = await import("@/lib/bible-questions");
  await passOn(l.admin, l.clientId, id, l.by);
  revalidatePath(`/c/${slug}/questions`);
  return { ok: true as const };
}
