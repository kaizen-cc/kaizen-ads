"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { getViewer } from "@/lib/auth";
import type { Reactions, Section } from "@/lib/presentation-types";
import { SECTIONS } from "@/lib/presentation-types";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// What the client says about how we see them, from their portal: a verdict on each part, answers, how we launch, and
// approving it. A team member can do the same while testing (marked as such).

type Result = { ok: true; reactions: Reactions } | { ok: false; error: string };

async function load(slug: string) {
  const viewer = await getViewer();
  if (!adminConfigured()) return { error: "The portal isn't set up yet." } as const;
  const admin = createAdminClient();
  const { data: client } = await admin.from("clients").select("id, name, slug, portal_live").eq("slug", slug).maybeSingle();
  if (!client) return { error: "Not found." } as const;
  if (viewer.kind === "contact" && (!client.portal_live || !viewer.brands.some((b) => b.slug === slug))) return { error: "Not found." } as const;
  const { data: p } = await admin.from("client_presentations").select("status, reactions").eq("client_id", client.id).maybeSingle();
  if (!p || !["sent", "approved"].includes(p.status as string)) return { error: "There's nothing to look at yet." } as const;
  const by = viewer.kind === "contact" ? (viewer.fullName ?? viewer.email) : `${viewer.fullName} (team, testing)`;
  return { admin, client, reactions: (p.reactions ?? {}) as Reactions, approved: p.status === "approved", by, contactId: viewer.kind === "contact" ? viewer.id : null } as const;
}

async function save(slug: string, change: (r: Reactions, by: string, at: string) => Reactions): Promise<Result> {
  const l = await load(slug);
  if ("error" in l) return { ok: false, error: l.error! };
  if (l.approved) return { ok: false, error: "It's already approved." };
  const reactions = change(l.reactions, l.by, new Date().toISOString());
  await l.admin.from("client_presentations").update({ reactions, updated_at: new Date().toISOString() }).eq("client_id", l.client.id);
  revalidatePath(`/c/${slug}/plan`);
  return { ok: true, reactions };
}

export async function reactPart(slug: string, section: Section, verdict: "right" | "off", note: string) {
  if (!(SECTIONS as readonly string[]).includes(section)) return { ok: false as const, error: "Not found." };
  if (verdict === "off" && !note.trim()) return { ok: false as const, error: "Say what you'd change, so we can fix it." };
  return save(slug, (r, by, at) => ({ ...r, sections: { ...r.sections, [section]: { verdict, note: note.trim().slice(0, 4000), at, by } } }));
}

export async function answerQuestion(slug: string, question: string, answer: string) {
  return save(slug, (r, by, at) => ({ ...r, answers: { ...r.answers, [question.slice(0, 500)]: { answer: answer.trim().slice(0, 4000), at, by } } }));
}

export async function chooseLaunch(slug: string, choice: "engagement_first" | "wait") {
  if (!["engagement_first", "wait"].includes(choice)) return { ok: false as const, error: "Not found." };
  return save(slug, (r, by, at) => ({ ...r, launch: { choice, at, by } }));
}

/** Approved: the team hears it (with what they marked not quite, their answers and how they want to launch). */
export async function approvePlan(slug: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const l = await load(slug);
  if ("error" in l) return { ok: false, error: l.error! };
  if (l.approved) return { ok: true };
  if (!l.reactions.launch) return { ok: false, error: "Pick how you'd like us to get you live first (part 6)." };
  const now = new Date().toISOString();
  await l.admin.from("client_presentations").update({ status: "approved", approved_at: now, approved_by: l.contactId, updated_at: now }).eq("client_id", l.client.id);
  const off = Object.entries(l.reactions.sections ?? {}).filter(([, v]) => v?.verdict === "off");
  const [{ data: buyers }, { data: leads }] = await Promise.all([
    l.admin.from("client_assignments").select("profile_id").eq("client_id", l.client.id).eq("role", "meta_buyer"),
    l.admin.from("profiles").select("id").eq("is_active", true).eq("is_lead", true),
  ]);
  const ids = [...new Set([...(buyers ?? []).map((b) => b.profile_id as string), ...(leads ?? []).map((x) => x.id as string)])];
  const launch = l.reactions.launch.choice === "engagement_first" ? "Go live within 48 hours with an engagement campaign" : "Wait for the conversion creative before launching";
  if (ids.length)
    await l.admin.from("notifications").upsert(
      ids.map((id) => ({
        profile_id: id,
        kind: "onboarding",
        title: `${l.client.name} approved how we see them`,
        body: [`${l.by}: ${launch}.`, off.length ? `Not quite on ${off.map(([k]) => k).join(", ")}: their notes are on the presentation.` : "Spot on everywhere they reacted."].join(" "),
        href: `/clients/${l.client.slug}/brand-bible/presentation`,
        client_id: l.client.id,
        key: `presentation-approved:${l.client.id}`,
        priority: "critical",
      })),
      { onConflict: "profile_id,key", ignoreDuplicates: true },
    );
  // Their first ads are being picked from the moment they approve (the page shows it)
  if (l.reactions.launch.choice === "engagement_first") await l.admin.from("engagement_launches").upsert({ client_id: l.client.id, status: "finding", updated_at: now });
  // Folded into the Bible, the team told, and the first round written, after the answer
  const admin = l.admin;
  const clientId = l.client.id;
  after(async () => {
    const { afterApproval } = await import("@/lib/plan-chat");
    await afterApproval(admin, clientId).catch((e) => console.error("[plan] after approval failed:", e instanceof Error ? e.message : e));
  });
  revalidatePath(`/c/${slug}/plan`);
  return { ok: true };
}

const safe = (name: string) => name.replace(/[^\w.-]+/g, "-").slice(-80);

/** Where the client's files (and voice messages) go: signed upload slots in the client's own folder */
export async function planUploadSlots(slug: string, files: { name: string; bytes: number }[]): Promise<{ ok: true; slots: { path: string; token: string }[] } | { ok: false; error: string }> {
  const l = await load(slug);
  if ("error" in l) return { ok: false, error: l.error! };
  if (files.length > 6) return { ok: false, error: "Up to six files at a time." };
  if (files.some((f) => f.bytes > 50_000_000)) return { ok: false, error: "Files up to 50 MB." };
  const slots: { path: string; token: string }[] = [];
  for (const f of files) {
    const path = `${l.client.id}/portal/${crypto.randomUUID()}-${safe(f.name)}`;
    const { data, error } = await l.admin.storage.from("client-docs").createSignedUploadUrl(path);
    if (error || !data) return { ok: false, error: "Uploads aren't working right now. Try again in a minute." };
    slots.push({ path, token: data.token });
  }
  return { ok: true, slots };
}

/** A message in the conversation: text, files already uploaded, or a voice message (its WAV, uploaded, is transcribed) */
export async function talkPlan(slug: string, text: string, files: { path: string; name: string; mime: string; bytes: number }[], voicePath: string | null) {
  const l = await load(slug);
  if ("error" in l) return { ok: false as const, error: l.error! };
  if (l.approved) return { ok: false as const, error: "It's already approved: the team has it from here." };
  let words = text.trim().slice(0, 8000);
  if (voicePath) {
    if (!voicePath.startsWith(`${l.client.id}/`)) return { ok: false as const, error: "Not found." };
    const { data } = await l.admin.storage.from("client-docs").download(voicePath);
    if (!data) return { ok: false as const, error: "The voice message didn't upload. Try again." };
    try {
      const { transcribe } = await import("@/lib/transcribe");
      const lines = await transcribe(Buffer.from(await data.arrayBuffer()));
      words = lines.map((x) => x.text).join(" ").trim();
    } catch {
      return { ok: false as const, error: "We couldn't make out the voice message. Try again, or type it." };
    }
    if (!words) return { ok: false as const, error: "We couldn't hear anything in that one. Try again a little closer to the mic." };
  }
  if (!words && !files.length) return { ok: false as const, error: "Write something first." };
  try {
    const { talkPlan: talk } = await import("@/lib/plan-chat");
    const r = await talk(l.admin, l.client.id, { name: l.by, contactId: l.contactId }, { text: words, files, voice: Boolean(voicePath) });
    return { ok: true as const, chat: r.chat, reactions: r.reactions };
  } catch (e) {
    const { AiUnavailable } = await import("@/lib/ai");
    return { ok: false as const, error: e instanceof AiUnavailable ? e.message : "Something went wrong. Try again in a moment." };
  }
}

/** The client keeps the posts for their first ads (all, or some): built, paused, for the buyer to turn on */
export async function confirmPosts(slug: string, chosen: string[]): Promise<{ ok: true } | { ok: false; error: string }> {
  const viewer = await getViewer();
  if (!adminConfigured()) return { ok: false, error: "The portal isn't set up yet." };
  const admin = createAdminClient();
  const { data: client } = await admin.from("clients").select("id, portal_live").eq("slug", slug).maybeSingle();
  if (!client || (viewer.kind === "contact" && (!client.portal_live || !viewer.brands.some((b) => b.slug === slug)))) return { ok: false, error: "Not found." };
  const { data: l } = await admin.from("engagement_launches").select("status, posts").eq("client_id", client.id).maybeSingle();
  if (!l || l.status !== "proposed") return { ok: false, error: "These are already with the team." };
  const ids = new Set(((l.posts ?? []) as { id: string }[]).map((p) => p.id));
  const keep = chosen.filter((x) => ids.has(x));
  if (!keep.length) return { ok: false, error: "Keep at least one post, or tell us in the conversation what you'd rather run." };
  const by = viewer.kind === "contact" ? (viewer.fullName ?? viewer.email) : `${viewer.fullName} (team)`;
  await admin.from("engagement_launches").update({ status: "confirmed", chosen: keep, confirmed_at: new Date().toISOString(), confirmed_by: by, updated_at: new Date().toISOString() }).eq("client_id", client.id);
  const clientId = client.id as string;
  after(async () => {
    const { buildEngagement } = await import("@/lib/engagement-launch");
    await buildEngagement(admin, clientId);
  });
  revalidatePath(`/c/${slug}/plan`);
  return { ok: true };
}
