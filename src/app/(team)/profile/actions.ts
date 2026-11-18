"use server";

import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/auth";
import { cleanEdit, isSlackField } from "@/lib/profile";
import { AVATAR_BUCKET, reimportFromSlack } from "@/lib/profile-slack";
import { createAdminClient } from "@/lib/supabase/admin";

// A person's own profile: name, title, bio, start date and picture. Only ever the signed-in person's own row (the same
// way the theme and the assistant's look are saved), written with the server's rights because their session can't
// update profiles directly. Nothing here is ever sent to Slack.

type Fail = { ok: false; error: string };
const NEEDS_MIGRATION = "Profiles need a database update first.";
const fail = (message: string): Fail => ({ ok: false, error: /display_name|title|bio|start_date|slack_user_id|profile_seeded/.test(message) ? NEEDS_MIGRATION : "Couldn't save that. Try again." });

function refresh() {
  revalidatePath("/profile/[id]", "page");
  revalidatePath("/team");
}

/** Saves one or more profile fields (display name, title, bio, start date) */
export async function saveProfile(input: { display_name?: string | null; title?: string | null; bio?: string | null; start_date?: string | null }): Promise<{ ok: true } | Fail> {
  const me = await requireStaff();
  const edit = cleanEdit(input);
  if (!edit.ok) return edit;
  if (!Object.keys(edit.patch).length) return { ok: true };
  const { error } = await createAdminClient().from("profiles").update(edit.patch).eq("id", me.id);
  if (error) return fail(error.message);
  refresh();
  return { ok: true };
}

const TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/** Sets their picture from an uploaded image (the browser sends it already cropped square and sized down) */
export async function uploadAvatar(form: FormData): Promise<{ ok: true; url: string } | Fail> {
  const me = await requireStaff();
  const file = form.get("file");
  if (!(file instanceof File) || !TYPES[file.type]) return { ok: false, error: "Pick a JPG, PNG or WebP picture." };
  if (file.size > 2 * 1024 * 1024) return { ok: false, error: "That picture is over 2 MB." };
  const admin = createAdminClient();
  const path = `${me.id}/${Date.now()}.${TYPES[file.type]}`;
  const { error } = await admin.storage.from(AVATAR_BUCKET).upload(path, new Uint8Array(await file.arrayBuffer()), { contentType: file.type, upsert: true });
  if (error) return { ok: false, error: "Couldn't upload the picture. Try again." };
  const url = admin.storage.from(AVATAR_BUCKET).getPublicUrl(path).data.publicUrl;
  const { error: saveError } = await admin.from("profiles").update({ avatar_url: url }).eq("id", me.id);
  if (saveError) return fail(saveError.message);
  // Older pictures of theirs aren't kept
  const { data: old } = await admin.storage.from(AVATAR_BUCKET).list(me.id, { limit: 100 });
  const stale = (old ?? []).map((o) => `${me.id}/${o.name}`).filter((p) => p !== path);
  if (stale.length) await admin.storage.from(AVATAR_BUCKET).remove(stale);
  refresh();
  return { ok: true, url };
}

/** Takes their picture away (back to initials) */
export async function removeAvatar(): Promise<{ ok: true } | Fail> {
  const me = await requireStaff();
  const admin = createAdminClient();
  const { error } = await admin.from("profiles").update({ avatar_url: null }).eq("id", me.id);
  if (error) return fail(error.message);
  const { data: old } = await admin.storage.from(AVATAR_BUCKET).list(me.id, { limit: 100 });
  if (old?.length) await admin.storage.from(AVATAR_BUCKET).remove(old.map((o) => `${me.id}/${o.name}`));
  refresh();
  return { ok: true };
}

/** Pulls one field from Slack again, on purpose (the only time Slack changes what's in Kaizen OS after the first setup) */
export async function importFromSlack(field: string): Promise<{ ok: true; value: string } | Fail> {
  const me = await requireStaff();
  if (!isSlackField(field)) return { ok: false, error: "That can't be imported." };
  const r = await reimportFromSlack(createAdminClient(), me.id, field);
  if (r.ok) refresh();
  return r;
}
