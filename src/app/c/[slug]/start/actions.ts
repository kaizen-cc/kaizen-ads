"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { getViewer } from "@/lib/auth";
import { EMAIL_PLATFORMS, GOOGLE_TOOLS, PACING, STEP_LABELS, STYLES, WEBSITE_PLATFORMS, googleTools, type EmailStep, type GoogleStep, type GoogleTool, type MetaStep, type OwnExample, type StyleStep, type ToolStep, type TrackingPick, type TrackingStep, type WebsiteStep } from "@/lib/onboarding-guide-types";
import type { HelpStep } from "@/lib/setup-help";
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
export async function onTheCall(slug: string, which: HelpStep, note: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const l = await load(slug);
  if ("error" in l) return { ok: false, error: l.error! };
  if (!(which in STEP_LABELS)) return { ok: false, error: "Not found." };
  const g = await l.guide.loadGuide(l.admin, l.client.id);
  const at = new Date().toISOString();
  const saved = note.trim().slice(0, 600) || null;
  if (which === "tools") {
    // Every Google tool they still have to share
    const has = await l.guide.guideHas(l.admin, l.client.id);
    for (const t of googleTools(g, has)) if (!["done", "na"].includes(g[t].status ?? "")) await l.guide.saveStep(l.admin, l.client.id, t, { ...g[t], status: "on_call", at, by: l.by, note: saved });
  } else await l.guide.saveStep(l.admin, l.client.id, which, { ...g[which], status: "on_call", at, by: l.by, note: saved });
  const name = which === "meta" ? "Meta" : which === "google" ? "Google Ads" : STEP_LABELS[which];
  await l.guide.tellGuideTeam(l.admin, l.client.id, `wants to set up ${name} access on the onboarding call`, `${l.by}${note.trim() ? `: "${note.trim().slice(0, 400)}"` : " would rather do it together on the call"}. Cover it on the onboarding call; afterwards the app checks the access and flags anything still missing.`, `on-call:${which}:${l.client.id}`, "critical");
  // The CS team's brief for the call, with everything they tried
  const admin = l.admin;
  const clientId = l.client.id as string;
  const why = `${l.by} saved ${which === "meta" ? "Meta access" : name} for the onboarding call${note.trim() ? `: "${note.trim().slice(0, 200)}"` : ""}`;
  after(async () => {
    const { prepareCall } = await import("@/lib/call-prep");
    await prepareCall(admin, clientId, why).catch((e) => console.error("[call-prep] on call", e));
  });
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
    if (drive) await l.guide.saveStep(admin, clientId, "assets", { ...now.assets, drive: drive.drive, driveNote: drive.note });
    // Where the files went, and if Drive didn't take them, why (so someone moves them by hand)
    await l.guide.tellGuideTeam(admin, clientId, "shared their assets", `${mine.length ? `${mine.length} file${mine.length === 1 ? "" : "s"}${drive?.drive === "saved" ? " (in their Drive folder, Client uploads)" : ""}` : ""}${mine.length && urls.length ? " and " : ""}${urls.length ? `${urls.length} link${urls.length === 1 ? "" : "s"}` : ""}, on ${name}'s page under documents.${drive?.note ? ` Not in Drive: ${drive.note}.` : ""}`, `assets:${clientId}:${new Date().toISOString().slice(0, 13)}`, drive && drive.drive !== "saved" ? "critical" : "normal");
  });
  done(slug);
  return { ok: true };
}

/** Their own examples (ads or posts they love): upload slots in their folder */
export async function styleSlots(slug: string, files: { name: string; bytes: number }[]): Promise<{ ok: true; slots: { path: string; token: string }[] } | { ok: false; error: string }> {
  const l = await load(slug);
  if ("error" in l) return { ok: false, error: l.error! };
  if (files.length > 8) return { ok: false, error: "Up to 8 examples at a time." };
  if (files.some((f) => f.bytes > 100_000_000)) return { ok: false, error: "Examples up to 100 MB (share a link for anything bigger)." };
  const slots: { path: string; token: string }[] = [];
  for (const f of files) {
    const path = `${l.client.id}/style-examples/${crypto.randomUUID()}-${safe(f.name)}`;
    const { data, error } = await l.admin.storage.from("client-docs").createSignedUploadUrl(path);
    if (error || !data) return { ok: false, error: "Uploads aren't working right now. Try again in a minute." };
    slots.push({ path, token: data.token });
  }
  return { ok: true, slots };
}

/**
 * The look they want: styles, pacing, the examples they liked, their own examples (links, or files they just uploaded:
 * given a year-long link so the creative team and briefs can open them) and a note, for the creative team's first round
 */
export async function saveStyle(slug: string, style: StyleStep & { uploaded?: { path: string; name: string; mime: string }[] }): Promise<{ ok: true } | { ok: false; error: string }> {
  const l = await load(slug);
  if ("error" in l) return { ok: false, error: l.error! };
  const styles = (style.styles ?? []).filter((k) => STYLES.some((x) => x.key === k)).slice(0, 8);
  const pacing = PACING.some((x) => x.key === style.pacing) ? style.pacing! : null;
  const liked = (style.liked ?? []).filter((x) => /^https:\/\/\S+$/.test(x.image)).slice(0, 12).map((x) => ({ image: x.image, label: String(x.label ?? "").slice(0, 80) }));
  const g = await l.guide.loadGuide(l.admin, l.client.id);
  // Kept: links they pasted, and files already saved (only ones we gave them)
  const had = new Set((g.style.own ?? []).map((x) => x.url));
  const kept: OwnExample[] = (style.own ?? [])
    .filter((x) => (x.kind === "link" ? /^https?:\/\/\S+$/i.test(x.url) : had.has(x.url)))
    .map((x) => ({ kind: x.kind, url: x.url.trim().slice(0, 1000), name: String(x.name ?? "").slice(0, 120) || "Example", video: Boolean(x.video) }));
  const fresh: OwnExample[] = [];
  for (const f of (style.uploaded ?? []).filter((f) => f.path.startsWith(`${l.client.id}/style-examples/`)).slice(0, 8)) {
    const { data } = await l.admin.storage.from("client-docs").createSignedUrl(f.path, 365 * 24 * 3600);
    if (data?.signedUrl) fresh.push({ kind: "file", url: data.signedUrl, name: f.name.slice(0, 120), video: /^video\//.test(f.mime) });
  }
  const own = [...kept, ...fresh].slice(0, 16);
  if (!styles.length && !pacing && !liked.length && !own.length && !style.note?.trim()) return { ok: false, error: "Pick at least one look first." };
  await l.guide.saveStep(l.admin, l.client.id, "style", { styles, pacing, liked, own, note: (style.note ?? "").trim().slice(0, 1500), at: new Date().toISOString(), by: l.by });
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
export async function askHelp(slug: string, step: HelpStep, text: string, files: { path: string; name: string; mime: string; bytes: number }[]) {
  const l = await load(slug);
  if ("error" in l) return { ok: false as const, error: l.error! };
  if (!text.trim() && !files.length) return { ok: false as const, error: "Ask something or share a screenshot first." };
  try {
    const { askSetupHelp } = await import("@/lib/setup-help");
    const { turns, blocker } = await askSetupHelp(l.admin, l.client.id, step, { name: l.by, contactId: l.contactId }, { text, files });
    // A big issue: the CS team gets the brief for the call, after the client has their answer
    if (blocker) {
      const admin = l.admin;
      const clientId = l.client.id as string;
      after(async () => {
        const { recordBlocker } = await import("@/lib/call-prep");
        await recordBlocker(admin, clientId, { step, ...blocker }).catch((e) => console.error("[call-prep] blocker", e));
      });
    }
    return { ok: true as const, turns };
  } catch (e) {
    const { AiUnavailable } = await import("@/lib/ai");
    return { ok: false as const, error: e instanceof AiUnavailable ? e.message : "Something went wrong. Try again in a moment." };
  }
}

/** Saved for the onboarding call from the help chat: the team hears what they were stuck on */
export async function helpToCall(slug: string, step: HelpStep) {
  const l = await load(slug);
  if ("error" in l) return { ok: false as const, error: l.error! };
  const { helpSummary } = await import("@/lib/setup-help");
  return onTheCall(slug, step, await helpSummary(l.admin, l.client.id, step));
}

/** How they sell, as they tell us: decides Merchant Center (selling online) and the Business Profile (a location) */
export async function saveBusiness(slug: string, b: { ecommerce?: boolean | null; location?: boolean | null }): Promise<{ ok: true } | { ok: false; error: string }> {
  const l = await load(slug);
  if ("error" in l) return { ok: false, error: l.error! };
  const g = await l.guide.loadGuide(l.admin, l.client.id);
  const next = { ...g.business, at: new Date().toISOString(), by: l.by };
  if (typeof b.ecommerce === "boolean") next.ecommerce = b.ecommerce;
  if (typeof b.location === "boolean") next.location = b.location;
  await l.guide.saveStep(l.admin, l.client.id, "business", next);
  done(slug);
  return { ok: true };
}

/** A Google tool: they added our address ("done", with its ID if they have it), don't have one (we set it up on the call), or it doesn't apply */
export async function toolStep(slug: string, tool: GoogleTool, status: "done" | "none" | "na", id = ""): Promise<{ ok: true; step: ToolStep } | { ok: false; error: string }> {
  const l = await load(slug);
  if ("error" in l) return { ok: false, error: l.error! };
  const t = GOOGLE_TOOLS.find((x) => x.key === tool);
  if (!t) return { ok: false, error: "Not found." };
  const at = new Date().toISOString();
  const step: ToolStep = status === "none" ? { status: "on_call", none: true, at, by: l.by } : status === "na" ? { status: "na", at, by: l.by } : { status: "done", id: id.trim().slice(0, 60) || null, at, by: l.by };
  await l.guide.saveStep(l.admin, l.client.id, tool, step);
  const { techEmail } = await l.guide.accessSetting(l.admin);
  if (status === "done") await l.guide.tellGuideTeam(l.admin, l.client.id, `added Kaizen to ${t.name}`, `${l.by} says ${techEmail ?? "our tech address"} is invited${step.id ? ` (${step.id})` : ""}. Accept the invite and check the access.`, `${tool}-done:${l.client.id}`, "normal");
  if (status === "none") await l.guide.tellGuideTeam(l.admin, l.client.id, `has no ${t.name} yet`, `${l.by} doesn't have ${t.name}. Set it up with them on the onboarding call.`, `${tool}-none:${l.client.id}`, "critical");
  done(slug);
  return { ok: true, step };
}

const shopifyStore = (v: string) => {
  const m = v.trim().toLowerCase().match(/([a-z0-9][a-z0-9-]*)\.myshopify\.com/) ?? v.trim().toLowerCase().match(/admin\.shopify\.com\/store\/([a-z0-9-]+)/);
  return m ? `${m[1]}.myshopify.com` : /^[a-z0-9][a-z0-9-]*$/.test(v.trim().toLowerCase()) ? `${v.trim().toLowerCase()}.myshopify.com` : null;
};

/**
 * Their website: the platform, then on Shopify their collaborator request code and store address (the team sends the
 * collaborator request from Kaizen's Shopify Partners account), elsewhere our tech address invited as an admin. "none":
 * no website yet, talked through on the call.
 */
export async function websiteStep(slug: string, w: { platform: string; status: "done" | "none"; url?: string; code?: string; store?: string; other?: string }): Promise<{ ok: true; step: WebsiteStep } | { ok: false; error: string }> {
  const l = await load(slug);
  if ("error" in l) return { ok: false, error: l.error! };
  const at = new Date().toISOString();
  if (w.status === "none") {
    const step: WebsiteStep = { status: "on_call", none: true, at, by: l.by };
    await l.guide.saveStep(l.admin, l.client.id, "website", step);
    await l.guide.tellGuideTeam(l.admin, l.client.id, "has no website yet", `${l.by} says they don't have a website yet. Talk it through on the onboarding call.`, `website-none:${l.client.id}`, "critical");
    done(slug);
    return { ok: true, step };
  }
  const known = WEBSITE_PLATFORMS.find((x) => x.key === w.platform);
  if (!known) return { ok: false, error: "Pick your website platform first." };
  const url = (w.url ?? "").trim().slice(0, 300) || null;
  if (known.key === "shopify") {
    const code = (w.code ?? "").replace(/\D/g, "");
    const store = shopifyStore(w.store ?? "");
    if (code.length !== 4) return { ok: false, error: "The collaborator request code is 4 digits (Settings › Users and permissions › Collaborators)." };
    if (!store) return { ok: false, error: "Your store address ends in .myshopify.com (Settings › Domains)." };
    const step: WebsiteStep = { status: "done", platform: "shopify", code, store, url, at, by: l.by };
    await l.guide.saveStep(l.admin, l.client.id, "website", step);
    await l.guide.tellGuideTeam(l.admin, l.client.id, "sent their Shopify collaborator code", `Store ${store}, collaborator request code ${code}. In Shopify Partners: Stores › Add store › Request access (collaborator), enter the store address and the code. They accept it in Shopify. Both are on their client page.`, `website-shopify:${l.client.id}:${code}`, "critical");
    done(slug);
    return { ok: true, step };
  }
  const name = known.key === "other" ? (w.other ?? "").trim().slice(0, 60) || "another platform" : known.name;
  const step: WebsiteStep = { status: "done", platform: known.key === "other" ? name : known.key, url, at, by: l.by };
  await l.guide.saveStep(l.admin, l.client.id, "website", step);
  const { techEmail } = await l.guide.accessSetting(l.admin);
  await l.guide.tellGuideTeam(l.admin, l.client.id, `added Kaizen to their ${name} website`, `${l.by} says ${techEmail ?? "our tech address"} is invited as an admin${url ? ` on ${url}` : ""}. Accept the invite and check the access.`, `website-done:${l.client.id}`, "normal");
  done(slug);
  return { ok: true, step };
}

/** Their email or SMS platform: Klaviyo adds our Klaviyo address, everything else our tech address, as an admin */
export async function emailStep(slug: string, e: { platform: string; status: "done" | "none"; other?: string }): Promise<{ ok: true; step: EmailStep } | { ok: false; error: string }> {
  const l = await load(slug);
  if ("error" in l) return { ok: false, error: l.error! };
  const at = new Date().toISOString();
  if (e.status === "none") {
    const step: EmailStep = { status: "on_call", none: true, at, by: l.by };
    await l.guide.saveStep(l.admin, l.client.id, "email", step);
    await l.guide.tellGuideTeam(l.admin, l.client.id, "has no email platform yet", `${l.by} doesn't use an email platform yet. Pick and set one up with them on the onboarding call.`, `email-none:${l.client.id}`, "critical");
    done(slug);
    return { ok: true, step };
  }
  const known = EMAIL_PLATFORMS.find((x) => x.key === e.platform);
  if (!known) return { ok: false, error: "Pick your email platform first." };
  const name = known.key === "other" ? (e.other ?? "").trim().slice(0, 60) || "another platform" : known.name;
  const step: EmailStep = { status: "done", platform: known.key === "other" ? name : known.key, at, by: l.by };
  await l.guide.saveStep(l.admin, l.client.id, "email", step);
  const a = await l.guide.accessSetting(l.admin);
  const who = known.key === "klaviyo" ? a.klaviyoEmail : a.techEmail;
  await l.guide.tellGuideTeam(l.admin, l.client.id, `added Kaizen to ${name}`, `${l.by} says ${who ?? "our address"} is invited as an admin. Accept the invite and check the access.`, `email-done:${l.client.id}`, "normal");
  done(slug);
  return { ok: true, step };
}

/** Every pick added: done; the rest waiting on the call: on_call */
const trackingStatus = (picks: TrackingPick[], notSure: boolean): TrackingStep["status"] =>
  notSure ? "on_call" : !picks.length ? "todo" : picks.every((x) => x.status === "done") ? "done" : picks.every((x) => x.status !== "todo") ? "on_call" : "todo";

/**
 * Where their orders, bookings or leads live: the platforms they use (or "not sure", for the call), then each one
 * added (our tech address invited) or saved for the call. The tracking team hears what they use and what it needs
 * from each, on the client page, as a critical notice and by email to the tech inbox.
 */
export async function trackingStep(slug: string, op: { picks: string[]; other?: string; notSure?: boolean } | { done: string } | { call: string }): Promise<{ ok: true; step: TrackingStep } | { ok: false; error: string }> {
  const l = await load(slug);
  if ("error" in l) return { ok: false, error: l.error! };
  const { trackingPlatform, OTHER_NEEDS } = await import("@/lib/tracking-platforms");
  const g = await l.guide.loadGuide(l.admin, l.client.id);
  const at = new Date().toISOString();
  if ("picks" in op) {
    const picks: TrackingPick[] = [];
    // Ones already added (or saved for the call) keep where they stand
    const had = new Map((g.tracking.picks ?? []).map((x) => [x.key, x]));
    for (const key of [...new Set(op.picks)].slice(0, 8)) {
      const p = trackingPlatform(key);
      // One that can't add a user is set up with the tracking team on the call
      if (p) picks.push(had.get(key) ?? { key, name: p.name, status: p.invite === "call" ? "on_call" : "todo", at, by: l.by });
      else if (key.startsWith("other:") && had.has(key)) picks.push(had.get(key)!);
    }
    const other = (op.other ?? "").trim().slice(0, 80);
    const otherKey = `other:${other.toLowerCase()}`;
    if (other && !picks.some((x) => x.key === otherKey)) picks.push(had.get(otherKey) ?? { key: otherKey, name: other, status: "todo", at, by: l.by });
    if (!picks.length && !op.notSure) return { ok: false, error: "Pick what you use, or tap \"Not sure\"." };
    const step: TrackingStep = { status: trackingStatus(picks, Boolean(op.notSure)), picks, notSure: Boolean(op.notSure), at, by: l.by };
    await l.guide.saveStep(l.admin, l.client.id, "tracking", step);
    const lines = picks.map((x) => `${x.name}: ${x.status === "on_call" ? "can't add a user, so a report export or connection on the call" : "they'll invite our tech address"}. Needs: ${trackingPlatform(x.key)?.needs ?? OTHER_NEEDS}.`);
    const body = op.notSure ? `${l.by} isn't sure where their orders, bookings or leads are recorded. Find out on the onboarding call.` : `${l.by} uses ${picks.map((x) => x.name).join(", ")}. ${lines.join(" ")}`;
    await l.guide.tellGuideTeam(l.admin, l.client.id, op.notSure ? "isn't sure how they track orders, bookings or leads" : `tracks sales in ${picks.map((x) => x.name).join(", ")}`, body, `tracking:${l.client.id}:${at.slice(0, 16)}`, "critical");
    // And to the tech inbox, where the tracking work happens
    const { techEmail } = await l.guide.accessSetting(l.admin);
    if (techEmail) {
      const { sendEmail } = await import("@/lib/email");
      const { siteUrl } = await import("@/lib/site");
      const link = `${siteUrl()}/clients/${l.client.slug}`;
      await sendEmail({ to: techEmail, subject: `${l.client.name}: where their orders, bookings or leads live`, text: `${body}\n\n${link}`, html: `<div style="font:14px/1.55 Helvetica,Arial,sans-serif;color:#222;max-width:560px"><p style="font-weight:700;font-size:16px;margin:0 0 8px">${l.client.name}: tracking platforms</p>${(op.notSure ? [body] : [`${l.by} uses ${picks.map((x) => x.name).join(", ")}.`, ...lines]).map((x) => `<p style="margin:0 0 6px">${x.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]!)}</p>`).join("")}<a href="${link}" style="color:#b21e2c">Open the client in Kaizen Ads →</a></div>` }).catch(() => null);
    }
    done(slug);
    return { ok: true, step };
  }
  const key = "done" in op ? op.done : op.call;
  const picks = (g.tracking.picks ?? []).map((x) => (x.key === key ? { ...x, status: ("done" in op ? "done" : "on_call") as TrackingPick["status"], at, by: l.by } : x));
  const pick = picks.find((x) => x.key === key);
  if (!pick) return { ok: false, error: "Not found." };
  const step: TrackingStep = { ...g.tracking, picks, status: trackingStatus(picks, Boolean(g.tracking.notSure)) };
  await l.guide.saveStep(l.admin, l.client.id, "tracking", step);
  const { techEmail } = await l.guide.accessSetting(l.admin);
  await l.guide.tellGuideTeam(l.admin, l.client.id, "done" in op ? `added Kaizen to ${pick.name}` : `wants to connect ${pick.name} on the call`, "done" in op ? `${l.by} says ${techEmail ?? "our tech address"} is invited to ${pick.name}. Accept it and set up the tracking.` : `${l.by} would rather connect ${pick.name} with the tracking team on the onboarding call.`, `tracking-${"done" in op ? "done" : "call"}:${l.client.id}:${key}`, "done" in op ? "normal" : "critical");
  done(slug);
  return { ok: true, step };
}
