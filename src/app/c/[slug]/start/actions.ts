"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { getViewer } from "@/lib/auth";
import { PACING, STYLES, type GoogleStep, type MetaStep, type StyleStep } from "@/lib/onboarding-guide-types";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// The client's side of their onboarding guide: Meta access done (checked), Google Ads ID sent, assets shared, the look
// picked, and "let's do it on the call". A team member can do the same while testing (marked as such).

async function load(slug: string) {
  const viewer = await getViewer();
  if (!adminConfigured()) return { error: "The portal isn't set up yet." } as const;
  const admin = createAdminClient();
  const { data: client } = await admin.from("clients").select("id, name, slug, portal_live").eq("slug", slug).maybeSingle();
  if (!client || (viewer.kind === "contact" && (!client.portal_live || !viewer.brands.some((b) => b.slug === slug)))) return { error: "Not found." } as const;
  const by = viewer.kind === "contact" ? (viewer.fullName ?? viewer.email) : `${viewer.fullName} (team, testing)`;
  const guide = await import("@/lib/onboarding-guide");
  return { admin, client, by, contactId: viewer.kind === "contact" ? viewer.id : null, guide } as const;
}
const done = (slug: string) => {
  revalidatePath(`/c/${slug}/start`);
  revalidatePath(`/c/${slug}`);
};

/** "I've done both": saved, then checked against Meta right away */
export async function metaDone(slug: string, typed: string): Promise<{ ok: true; step: MetaStep } | { ok: false; error: string }> {
  const l = await load(slug);
  if ("error" in l) return { ok: false, error: l.error! };
  const g = await l.guide.loadGuide(l.admin, l.client.id);
  const id = typed.replace(/\D/g, "");
  await l.guide.saveStep(l.admin, l.client.id, "meta", { ...g.meta, status: g.meta.status === "verified" ? "verified" : "done", at: new Date().toISOString(), by: l.by, typed: id || g.meta.typed || null });
  const step = await l.guide.checkMeta(l.admin, l.client.id);
  if (step.status !== "verified") await l.guide.tellGuideTeam(l.admin, l.client.id, "says Meta access is shared", `${l.by} says they've added Kaizen as a partner and our team as admin. ${step.note ?? "We can't see it yet"}: it's checked again every 30 minutes.`, `meta-done:${l.client.id}`, "normal");
  done(slug);
  return { ok: true, step };
}

/** "Let's do it on the call": the team hears it now, and after the call the access is checked */
export async function onTheCall(slug: string, which: "meta" | "google", note: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const l = await load(slug);
  if ("error" in l) return { ok: false, error: l.error! };
  const g = await l.guide.loadGuide(l.admin, l.client.id);
  await l.guide.saveStep(l.admin, l.client.id, which, { ...g[which], status: "on_call", at: new Date().toISOString(), by: l.by, note: note.trim().slice(0, 600) || null });
  await l.guide.tellGuideTeam(l.admin, l.client.id, `wants to set up ${which === "meta" ? "Meta" : "Google Ads"} access on the onboarding call`, `${l.by}${note.trim() ? `: "${note.trim().slice(0, 400)}"` : " would rather do it together on the call"}. Cover it on the onboarding call; afterwards the app checks the access and flags anything still missing.`, `on-call:${which}:${l.client.id}`, "critical");
  done(slug);
  return { ok: true };
}

/** Their Google Ads account ID: saved, and our manager account's invite sent */
export async function googleSend(slug: string, id: string): Promise<{ ok: true; step: GoogleStep } | { ok: false; error: string }> {
  const l = await load(slug);
  if ("error" in l) return { ok: false, error: l.error! };
  const n = id.replace(/\D/g, "");
  if (n.length !== 10) return { ok: false, error: "A Google Ads ID is 10 digits, like 123-456-7890 (top right in Google Ads)." };
  const pretty = `${n.slice(0, 3)}-${n.slice(3, 6)}-${n.slice(6)}`;
  await l.guide.saveStep(l.admin, l.client.id, "google", { status: "sent", account: pretty, at: new Date().toISOString(), by: l.by });
  const step = await l.guide.checkGoogle(l.admin, l.client.id);
  await l.guide.tellGuideTeam(l.admin, l.client.id, `sent their Google Ads ID ${pretty}`, step.status === "verified" ? "It's already under our manager account." : step.status === "invited" ? "The link request went out from our manager account; they accept it in Google Ads." : (step.note ?? "Send the link request from our manager account."), `google-sent:${l.client.id}`, "normal");
  done(slug);
  return { ok: true, step };
}

const safe = (name: string) => name.replace(/[^\w.-]+/g, "-").slice(-80);

export async function assetSlots(slug: string, files: { name: string; bytes: number }[]): Promise<{ ok: true; slots: { path: string; token: string }[] } | { ok: false; error: string }> {
  const l = await load(slug);
  if ("error" in l) return { ok: false, error: l.error! };
  if (files.length > 30) return { ok: false, error: "Up to 30 files at a time." };
  if (files.some((f) => f.bytes > 200_000_000)) return { ok: false, error: "Files up to 200 MB (share a link for anything bigger)." };
  const slots: { path: string; token: string }[] = [];
  for (const f of files) {
    const path = `${l.client.id}/assets/${crypto.randomUUID()}-${safe(f.name)}`;
    const { data, error } = await l.admin.storage.from("client-docs").createSignedUploadUrl(path);
    if (error || !data) return { ok: false, error: "Uploads aren't working right now. Try again in a minute." };
    slots.push({ path, token: data.token });
  }
  return { ok: true, slots };
}

/** Their assets: files (uploaded) and links, filed on their client page and copied into their Drive folder */
export async function assetsShared(slug: string, files: { path: string; name: string; mime: string; bytes: number }[], links: string[]): Promise<{ ok: true } | { ok: false; error: string }> {
  const l = await load(slug);
  if ("error" in l) return { ok: false, error: l.error! };
  const mine = files.filter((f) => f.path.startsWith(`${l.client.id}/`)).slice(0, 30);
  const urls = [...new Set(links.map((u) => u.trim()).filter((u) => /^https?:\/\/\S+$/i.test(u)))].slice(0, 12);
  if (!mine.length && !urls.length) return { ok: false, error: "Add a file or paste a link first." };
  const rows = [
    ...mine.map((f) => ({ client_id: l.client.id, kind: "file", name: f.name.slice(0, 200), path: f.path, mime: f.mime || null, bytes: f.bytes, via: "portal", uploaded_by_contact: l.contactId })),
    ...urls.map((u) => ({ client_id: l.client.id, kind: "link", name: u.slice(0, 300), url: u, via: "portal", uploaded_by_contact: l.contactId })),
  ];
  const { data: docs } = await l.admin.from("client_documents").insert(rows).select("id");
  const g = await l.guide.loadGuide(l.admin, l.client.id);
  await l.guide.saveStep(l.admin, l.client.id, "assets", { ...g.assets, files: (g.assets.files ?? 0) + mine.length, links: (g.assets.links ?? 0) + urls.length, at: new Date().toISOString(), by: l.by });
  const admin = l.admin;
  const clientId = l.client.id as string;
  const name = l.client.name as string;
  after(async () => {
    // Read and summarized for the team and the agents, and copied into their Drive folder
    const { summarizeDocs } = await import("@/lib/client-docs");
    await summarizeDocs(admin, clientId, (docs ?? []).map((d) => d.id as string)).catch(() => null);
    const drive = mine.length ? await l.guide.filesToDrive(admin, clientId, mine) : null;
    const now = await l.guide.loadGuide(admin, clientId);
    if (drive) await l.guide.saveStep(admin, clientId, "assets", { ...now.assets, drive });
    await l.guide.tellGuideTeam(admin, clientId, "shared their assets", `${mine.length ? `${mine.length} file${mine.length === 1 ? "" : "s"}${drive === "saved" ? " (in their Drive folder, Client uploads)" : ""}` : ""}${mine.length && urls.length ? " and " : ""}${urls.length ? `${urls.length} link${urls.length === 1 ? "" : "s"}` : ""}, on ${name}'s page under documents.`, `assets:${clientId}:${new Date().toISOString().slice(0, 13)}`, "normal");
  });
  done(slug);
  return { ok: true };
}

/** The look they want: styles, pacing, the examples they liked and a note, for the creative team's first round */
export async function saveStyle(slug: string, style: StyleStep): Promise<{ ok: true } | { ok: false; error: string }> {
  const l = await load(slug);
  if ("error" in l) return { ok: false, error: l.error! };
  const styles = (style.styles ?? []).filter((k) => STYLES.some((x) => x.key === k)).slice(0, 8);
  const pacing = PACING.some((x) => x.key === style.pacing) ? style.pacing! : null;
  const liked = (style.liked ?? []).filter((x) => /^https:\/\/\S+$/.test(x.image)).slice(0, 12).map((x) => ({ image: x.image, label: String(x.label ?? "").slice(0, 80) }));
  if (!styles.length && !pacing && !liked.length && !style.note?.trim()) return { ok: false, error: "Pick at least one look first." };
  await l.guide.saveStep(l.admin, l.client.id, "style", { styles, pacing, liked, note: (style.note ?? "").trim().slice(0, 1500), at: new Date().toISOString(), by: l.by });
  done(slug);
  return { ok: true };
}

/** Screenshots and files for the help chat: signed upload slots in the client's own folder */
export async function helpSlots(slug: string, files: { name: string; bytes: number }[]): Promise<{ ok: true; slots: { path: string; token: string }[] } | { ok: false; error: string }> {
  const l = await load(slug);
  if ("error" in l) return { ok: false, error: l.error! };
  if (files.length > 6) return { ok: false, error: "Up to 6 files at a time." };
  if (files.some((f) => f.bytes > 25_000_000)) return { ok: false, error: "Screenshots and files up to 25 MB." };
  const slots: { path: string; token: string }[] = [];
  for (const f of files) {
    const path = `${l.client.id}/setup-help/${crypto.randomUUID()}-${safe(f.name)}`;
    const { data, error } = await l.admin.storage.from("client-docs").createSignedUploadUrl(path);
    if (error || !data) return { ok: false, error: "Uploads aren't working right now. Try again in a minute." };
    slots.push({ path, token: data.token });
  }
  return { ok: true, slots };
}

/** Their question in the setup guide, answered for what's on their screen */
export async function askHelp(slug: string, step: "meta" | "google", text: string, files: { path: string; name: string; mime: string; bytes: number }[]) {
  const l = await load(slug);
  if ("error" in l) return { ok: false as const, error: l.error! };
  if (!text.trim() && !files.length) return { ok: false as const, error: "Ask something or share a screenshot first." };
  try {
    const { askSetupHelp } = await import("@/lib/setup-help");
    const turns = await askSetupHelp(l.admin, l.client.id, step, { name: l.by, contactId: l.contactId }, { text, files });
    return { ok: true as const, turns };
  } catch (e) {
    const { AiUnavailable } = await import("@/lib/ai");
    return { ok: false as const, error: e instanceof AiUnavailable ? e.message : "Something went wrong. Try again in a moment." };
  }
}

/** Saved for the onboarding call from the help chat: the team hears what they were stuck on */
export async function helpToCall(slug: string, step: "meta" | "google") {
  const l = await load(slug);
  if ("error" in l) return { ok: false as const, error: l.error! };
  const { helpSummary } = await import("@/lib/setup-help");
  return onTheCall(slug, step, await helpSummary(l.admin, l.client.id, step));
}
