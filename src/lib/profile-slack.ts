import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { slack, slackConfigured } from "@/lib/context/slack";
import { parseSlackUser, reimportPatch, seedPatch, type ProfileFields, type SlackField, type SlackPerson } from "@/lib/profile";

// Profiles and Slack. The first time a person is set up, their picture, name, title and status are copied from their Slack
// profile into Kaizen OS (only into fields that are empty). After that the two never touch each other: what's edited
// in Kaizen OS stays in Kaizen OS (nothing is ever written to Slack), and a change in Slack never overwrites Kaizen OS,
// except a field the person pulls again on purpose with "Import from Slack".

export const AVATAR_BUCKET = "avatars";

/** Their Slack user, found by work email (users.lookupByEmail; the member list when that scope isn't granted) */
export async function findSlackUser(email: string): Promise<SlackPerson | null> {
  try {
    const r = await slack<{ user?: unknown }>("users.lookupByEmail", { email });
    return parseSlackUser(r);
  } catch (e) {
    const why = e instanceof Error ? e.message : "";
    if (/users_not_found/.test(why)) return null;
    // Without users:read.email: read the member list and match the email there
  }
  let cursor = "";
  for (let page = 0; page < 10; page++) {
    const r = await slack<{ members?: { id: string; deleted?: boolean; is_bot?: boolean; profile?: { email?: string } }[]; response_metadata?: { next_cursor?: string } }>("users.list", { limit: "200", ...(cursor ? { cursor } : {}) });
    const hit = (r.members ?? []).find((m) => !m.deleted && !m.is_bot && m.profile?.email?.toLowerCase() === email.toLowerCase());
    if (hit) return parseSlackUser({ user: hit });
    cursor = r.response_metadata?.next_cursor ?? "";
    if (!cursor) break;
  }
  return null;
}

/** A Slack user by id (users.info), for the per-field re-import */
async function slackUserById(id: string): Promise<SlackPerson | null> {
  const r = await slack<{ user?: unknown }>("users.info", { user: id });
  return parseSlackUser(r);
}

/** Copies Slack's picture into Kaizen OS's storage (so it doesn't depend on Slack's link); falls back to Slack's own link */
async function copyImage(admin: SupabaseClient, profileId: string, url: string): Promise<string> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    const type = (res.headers.get("content-type") ?? "").split(";")[0];
    if (!res.ok || !["image/jpeg", "image/png", "image/webp"].includes(type)) return url;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length || bytes.length > 2_000_000) return url;
    const path = `${profileId}/slack-${Date.now()}.${type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg"}`;
    const { error } = await admin.storage.from(AVATAR_BUCKET).upload(path, bytes, { contentType: type, upsert: true });
    if (error) return url;
    return admin.storage.from(AVATAR_BUCKET).getPublicUrl(path).data.publicUrl;
  } catch {
    return url;
  }
}

/**
 * The one-time seed from Slack. It claims the profile first (profile_seeded_at, only while it's still empty), so two tabs
 * can't both run it, then fills what's empty. Nothing happens, and nothing is marked, when Slack isn't connected or
 * can't be read (it tries again the next time), so a person is never left "seeded" with nothing.
 */
export async function seedProfileFromSlack(admin: SupabaseClient, profileId: string): Promise<"seeded" | "already" | "skipped"> {
  if (!slackConfigured()) return "skipped";
  const { data: p } = await admin.from("profiles").select("email, display_name, title, bio, avatar_url, start_date, profile_seeded_at").eq("id", profileId).maybeSingle();
  if (!p) return "skipped";
  if (p.profile_seeded_at) return "already";
  let person: SlackPerson | null;
  try {
    person = await findSlackUser(String(p.email));
  } catch (e) {
    console.error("[profile seed]", e instanceof Error ? e.message : e);
    return "skipped";
  }
  const image = person?.image ? await copyImage(admin, profileId, person.image) : null;
  const patch = seedPatch(p as Partial<ProfileFields> & { profile_seeded_at: string | null }, person, image);
  if (patch === null) return "already";
  // Claim and fill in one write that only lands while nobody has seeded this profile yet
  const { data: claimed } = await admin
    .from("profiles")
    .update({ ...patch, profile_seeded_at: new Date().toISOString(), ...(person?.id ? { slack_user_id: person.id } : {}) })
    .eq("id", profileId)
    .is("profile_seeded_at", null)
    .select("id");
  return claimed?.length ? "seeded" : "already";
}

/** One field pulled from Slack again, because the person asked: replaces just that field (null: Slack has nothing for it) */
export async function reimportFromSlack(admin: SupabaseClient, profileId: string, field: SlackField): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  if (!slackConfigured()) return { ok: false, error: "Slack isn't connected." };
  const { data: p } = await admin.from("profiles").select("email, slack_user_id").eq("id", profileId).maybeSingle();
  if (!p) return { ok: false, error: "Couldn't find your profile." };
  let person: SlackPerson | null;
  try {
    person = p.slack_user_id ? await slackUserById(String(p.slack_user_id)) : await findSlackUser(String(p.email));
  } catch {
    return { ok: false, error: "Couldn't reach Slack. Try again in a moment." };
  }
  if (!person) return { ok: false, error: "Couldn't find you in Slack." };
  const image = field === "avatar_url" && person.image ? await copyImage(admin, profileId, person.image) : null;
  const patch = reimportPatch(field, person, image);
  if (!patch) return { ok: false, error: "Slack has nothing for that yet." };
  const { error } = await admin.from("profiles").update({ ...patch, ...(person.id ? { slack_user_id: person.id } : {}) }).eq("id", profileId);
  if (error) return { ok: false, error: "Couldn't save that." };
  return { ok: true, value: String(Object.values(patch)[0]) };
}
