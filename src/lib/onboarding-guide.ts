import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { metaConfigured, metaGraph } from "@/lib/context/meta";
import { sendEmail } from "@/lib/email";
import { type Guide, type GoogleStep, type MetaStep } from "@/lib/onboarding-guide-types";
import { servicesOf } from "@/lib/services";
import { siteUrl } from "@/lib/site";

// A new client's onboarding guide in their portal, sent the moment they enroll: Meta access (Kaizen's business as a
// partner on their ad account, Page, Instagram and pixel, and our team as admin), their Google Ads account ID, their
// assets (into their Drive folder) and the style and pacing they want. Access is checked against Meta and our Google
// manager account, never taken on trust. "Let's do it on the call" flags the team; after the onboarding call, the
// access is checked again and anything still missing goes to the team with what the call said.

export type AccessSetting = { bmId: string | null; adminEmails: string[] };

/** Kaizen's Business Manager ID and the address clients add as admin (Settings → onboarding access) */
export async function accessSetting(admin: SupabaseClient): Promise<AccessSetting> {
  const { data } = await admin.from("app_settings").select("value").eq("key", "onboarding_access").maybeSingle();
  const v = (data?.value ?? {}) as Partial<AccessSetting>;
  return { bmId: v.bmId?.trim() || null, adminEmails: (v.adminEmails ?? []).filter(Boolean) };
}

export async function loadGuide(admin: SupabaseClient, clientId: string): Promise<Guide> {
  const { data } = await admin.from("client_onboarding").select("meta, google, assets, style").eq("client_id", clientId).maybeSingle();
  return { meta: (data?.meta ?? {}) as MetaStep, google: (data?.google ?? {}) as GoogleStep, assets: (data?.assets ?? {}) as Guide["assets"], style: (data?.style ?? {}) as Guide["style"] };
}

export async function saveStep(admin: SupabaseClient, clientId: string, step: keyof Guide, value: object) {
  await admin.from("client_onboarding").upsert({ client_id: clientId, [step]: value, updated_at: new Date().toISOString() });
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Can we see their Meta assets yet? Their ad account and Page shared with our business (matched by the ID they typed, or
 * their name), and our system user given them so the app can work on them.
 */
export async function checkMeta(admin: SupabaseClient, clientId: string): Promise<MetaStep> {
  const [{ data: c }, g, { bmId }] = await Promise.all([admin.from("clients").select("name, meta_ad_account_id").eq("id", clientId).single(), loadGuide(admin, clientId), accessSetting(admin)]);
  const step: MetaStep = { ...g.meta, checkedAt: new Date().toISOString() };
  if (!c || !metaConfigured() || !bmId) {
    await saveStep(admin, clientId, "meta", step);
    return step;
  }
  type P<T> = { data: T[] };
  const [accounts, pages] = await Promise.all([
    metaGraph<P<{ id: string; account_id: string; name: string }>>(`${bmId}/client_ad_accounts`, { fields: "account_id,name", limit: "500" }).catch(() => ({ data: [] })),
    metaGraph<P<{ id: string; name: string }>>(`${bmId}/client_pages`, { fields: "name", limit: "500" }).catch(() => ({ data: [] })),
  ]);
  const want = (step.typed ?? c.meta_ad_account_id ?? "").replace(/\D/g, "");
  const named = (x: { name: string }) => norm(x.name).includes(norm(c.name as string)) || (norm(x.name).length >= 5 && norm(c.name as string).includes(norm(x.name)));
  const account = (want && accounts.data.find((a) => a.account_id === want)) || accounts.data.filter(named)[0] || null;
  const page = pages.data.filter(named)[0] ?? null;
  if (account) {
    step.account = account.account_id;
    step.accountName = account.name;
    if (!c.meta_ad_account_id) await admin.from("clients").update({ meta_ad_account_id: account.account_id }).eq("id", clientId);
  }
  if (page) {
    step.page = page.id;
    step.pageName = page.name;
  }
  if (account && page) {
    // Our system user on both, so launches and reads work (a business admin's token can; otherwise the team does it)
    const me = await metaGraph<{ id: string }>("me", {}).catch(() => null);
    const assigned = me
      ? await Promise.all([
          metaGraph(`act_${account.account_id}/assigned_users`, { user: me.id, tasks: JSON.stringify(["MANAGE", "ADVERTISE", "ANALYZE"]), business: bmId }, "POST").then(() => true).catch(() => false),
          metaGraph(`${page.id}/assigned_users`, { user: me.id, tasks: JSON.stringify(["MANAGE", "CREATE_CONTENT", "MODERATE", "ADVERTISE", "ANALYZE"]), business: bmId }, "POST").then(() => true).catch(() => false),
        ])
      : [false, false];
    step.status = "verified";
    step.note = assigned.every(Boolean) ? null : "Shared with us; assign them to the Kaizen system user in Business Settings so the app can launch";
  } else if (step.status === "verified") step.status = "done";
  step.note = step.status === "verified" ? step.note : account ? "We can see the ad account but not the Page yet" : page ? "We can see the Page but not the ad account yet" : null;
  await saveStep(admin, clientId, "meta", step);
  return step;
}

/** Is their Google Ads account under our manager account yet? If it was only sent, the invite goes out once. */
export async function checkGoogle(admin: SupabaseClient, clientId: string): Promise<GoogleStep> {
  const g = await loadGuide(admin, clientId);
  const step: GoogleStep = { ...g.google, checkedAt: new Date().toISOString() };
  if (!step.account) return step;
  const { googleAdsConfigured, managedAccounts, inviteToManager } = await import("@/lib/context/google-ads");
  if (!googleAdsConfigured()) return step;
  const id = step.account.replace(/\D/g, "");
  const seen = await managedAccounts().catch(() => []);
  if (seen.some((a) => a.id === id)) {
    step.status = "verified";
    step.note = null;
  } else if (step.status === "sent") {
    try {
      await inviteToManager(id);
      step.status = "invited";
      step.note = "Invite sent from Kaizen's manager account: accept it in Google Ads (Admin, Access and security, Managers)";
    } catch (e) {
      step.note = `Couldn't send the invite from our manager account (${e instanceof Error ? e.message.slice(0, 120) : "Google refused"}): the team sends it`;
      await tellTeam(admin, clientId, "send the Google Ads invite", `They sent their Google Ads ID ${step.account}. Send the link request from our manager account; the app couldn't.`, `google-invite:${clientId}`, "critical");
    }
  }
  await saveStep(admin, clientId, "google", step);
  return step;
}

/** The client's buyer, their team and the leads */
async function tellTeam(admin: SupabaseClient, clientId: string, what: string, body: string, key: string, priority: "critical" | "normal") {
  const [{ data: c }, { data: assigned }, { data: leads }] = await Promise.all([
    admin.from("clients").select("name, slug").eq("id", clientId).single(),
    admin.from("client_assignments").select("profile_id").eq("client_id", clientId).in("role", ["meta_buyer", "google_buyer"]),
    admin.from("profiles").select("id").eq("is_active", true).eq("is_lead", true),
  ]);
  const ids = [...new Set([...(assigned ?? []).map((a) => a.profile_id as string), ...(leads ?? []).map((l) => l.id as string)])];
  if (!c || !ids.length) return;
  await admin.from("notifications").upsert(
    ids.map((id) => ({ profile_id: id, kind: "onboarding", title: `${c.name}: ${what}`.slice(0, 200), body: body.slice(0, 1000), href: `/clients/${c.slug}`, client_id: clientId, key, priority })),
    { onConflict: "profile_id,key", ignoreDuplicates: true },
  );
}
export { tellTeam as tellGuideTeam };

export { setupSteps } from "@/lib/client-emails";

/** The welcome, at enrollment: their portal opened, an email to each contact and a post in their Slack channel */
export async function welcomeClient(admin: SupabaseClient, clientId: string) {
  const { data: o } = await admin.from("client_onboarding").select("welcomed_at").eq("client_id", clientId).maybeSingle();
  if (o?.welcomed_at) return "already";
  // Not to real clients until the portal is launched to them (the sandbox always)
  if (!(await (await import("@/lib/client-outreach")).autoOutreach(admin, clientId))) return "held";
  const { data: c } = await admin.from("clients").select("name, slug, portal_live, slack_channel_id, services, services_extra, services_removed").eq("id", clientId).single();
  if (!c) return "missing";
  // Not until Kaizen's Business Manager ID is set: the Meta step would have nothing to give them
  if (!(await accessSetting(admin)).bmId) return "no business id";
  const { clientRecipients, logClientEmail, setupSteps, welcomeEmail } = await import("@/lib/client-emails");
  const contacts = await clientRecipients(admin, clientId);
  if (!contacts.length && !c.slack_channel_id) return "no contact";
  if (!c.portal_live) await admin.from("clients").update({ portal_live: true, portal_live_at: new Date().toISOString() }).eq("id", clientId);
  const link = `${siteUrl()}/c/${c.slug}/start`;
  // Only the steps for what they buy from us
  const steps = setupSteps(servicesOf(c));
  const sent: string[] = [];
  let mail: ReturnType<typeof welcomeEmail> | null = null;
  for (const x of contacts) {
    const m = welcomeEmail({ brand: c.name as string, slug: c.slug as string, steps, first: x.first });
    mail ??= m;
    const r = await sendEmail({ to: x.email, ...m }).catch(() => null);
    if (r?.ok) sent.push(x.email);
  }
  if (mail) await logClientEmail(admin, { clientId, kind: "welcome", ...mail, to: sent });
  if (process.env.SLACK_BOT_TOKEN && c.slack_channel_id)
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel: c.slack_channel_id, text: `Welcome to Kaizen! 🎉 ${steps.length} quick steps so we can start building:\n${steps.map((st) => `• ${st.title}`).join("\n")}\n<${link}|Start setup →>`, unfurl_links: false }),
    }).catch(() => null);
  await admin.from("client_onboarding").upsert({ client_id: clientId, welcomed_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  return "sent";
}

/**
 * After a new client's onboarding call ("onboarding" in the title, else their first call after enrolling): access is
 * checked again, and what's still missing goes to the team with what the call said, so nothing waits on a guess.
 */
export async function afterOnboardingCall(admin: SupabaseClient, clientId: string, call: { id: string; title: string; at: string; summary: string }) {
  const { inNewFlow } = await import("@/lib/presentation-types");
  const [{ data: c }, { data: o }] = await Promise.all([admin.from("clients").select("created_at, reonboarded_at, status, services, services_extra, services_removed").eq("id", clientId).single(), admin.from("client_onboarding").select("call_checked_at").eq("client_id", clientId).maybeSingle()]);
  if (!c || c.status !== "onboarding" || !inNewFlow(c) || o?.call_checked_at) return;
  const start = (c.reonboarded_at ?? c.created_at) as string;
  if (call.at < start) return;
  if (!/onboard/i.test(call.title)) {
    const { count } = await admin.from("client_calls").select("id", { count: "exact", head: true }).eq("client_id", clientId).gte("occurred_at", start).lt("occurred_at", call.at);
    if (count) return; // not their first call since enrolling
  }
  const meta = await checkMeta(admin, clientId);
  const google = servicesOf(c).includes("google-ads") ? await checkGoogle(admin, clientId) : null;
  await admin.from("client_onboarding").upsert({ client_id: clientId, call_checked_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  const missing = [meta.status !== "verified" && `Meta access (${meta.note ?? "we can't see their ad account and Page yet"})`, google && google.status !== "verified" && `Google Ads (${google.account ? `ID ${google.account}, ${google.note ?? "not linked yet"}` : "no account ID yet"})`].filter(Boolean) as string[];
  if (!missing.length) return;
  await tellTeam(admin, clientId, "access still missing after the onboarding call", `After "${call.title}" we still don't have: ${missing.join("; ")}. What the call said: ${call.summary.slice(0, 500)}`, `access-after-call:${clientId}`, "critical");
}

/** Every 10 minutes: clients still waiting on access are checked again (each at most every 30 minutes) */
export async function keepGuides(admin: SupabaseClient) {
  // New clients not welcomed yet (no contact when they enrolled, or the welcome didn't run)
  const { FLOW_START } = await import("@/lib/presentation-types");
  const { data: fresh } = await admin.from("clients").select("id, client_onboarding(welcomed_at)").eq("status", "onboarding").is("archived_at", null).or(`created_at.gte.${FLOW_START},reonboarded_at.gte.${FLOW_START}`).limit(50);
  for (const c of fresh ?? []) {
    const o = (c.client_onboarding as unknown as { welcomed_at: string | null }[] | { welcomed_at: string | null } | null) ?? null;
    const welcomed = Array.isArray(o) ? o[0]?.welcomed_at : o?.welcomed_at;
    if (!welcomed) await welcomeClient(admin, c.id as string);
  }
  const { data } = await admin.from("client_onboarding").select("client_id, meta, google, clients!inner(status, services)").eq("clients.status", "onboarding").limit(100);
  const stale = (iso?: string) => !iso || Date.now() - Date.parse(iso) > 30 * 60_000;
  let checked = 0;
  for (const o of data ?? []) {
    const meta = (o.meta ?? {}) as MetaStep;
    const google = (o.google ?? {}) as GoogleStep;
    if (["done", "on_call"].includes(meta.status ?? "") && stale(meta.checkedAt)) {
      const before = meta.status;
      const now = await checkMeta(admin, o.client_id as string);
      if (now.status === "verified" && before !== "verified") await tellTeam(admin, o.client_id as string, "Meta access is in", `${now.accountName ?? now.account} and ${now.pageName ?? "their Page"} are shared with Kaizen.${now.note ? ` ${now.note}.` : ""}`, `meta-verified:${o.client_id}`, "normal");
      checked++;
    }
    if (["sent", "invited", "on_call"].includes(google.status ?? "") && google.account && stale(google.checkedAt)) {
      await checkGoogle(admin, o.client_id as string);
      checked++;
    }
  }
  return checked;
}

/** Their uploads into the client's Drive folder ("Client uploads"), when Kaizen's Google service account may write */
export async function filesToDrive(admin: SupabaseClient, clientId: string, files: { path: string; name: string; mime: string }[]) {
  const { data: c } = await admin.from("clients").select("drive_folder_id").eq("id", clientId).single();
  const user = process.env.GOOGLE_DRIVE_USER;
  if (!c?.drive_folder_id || !user || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return "kept here" as const;
  try {
    const { JWT } = await import("google-auth-library");
    const key = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) as { client_email: string; private_key: string };
    const token = (await new JWT({ email: key.client_email, key: key.private_key, scopes: ["https://www.googleapis.com/auth/drive"], subject: user }).getAccessToken()).token!;
    const auth = { authorization: `Bearer ${token}` };
    const q = encodeURIComponent(`'${c.drive_folder_id}' in parents and name = 'Client uploads' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
    const found = (await (await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id)`, { headers: auth })).json()) as { files?: { id: string }[] };
    let folder = found.files?.[0]?.id;
    if (!folder) {
      const made = await fetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ name: "Client uploads", mimeType: "application/vnd.google-apps.folder", parents: [c.drive_folder_id] }) });
      if (!made.ok) throw new Error(`Drive ${made.status}`);
      folder = ((await made.json()) as { id: string }).id;
    }
    for (const f of files) {
      const { data } = await admin.storage.from("client-docs").download(f.path);
      if (!data) continue;
      const boundary = `kaizen${Math.random().toString(36).slice(2)}`;
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\ncontent-type: application/json\r\n\r\n${JSON.stringify({ name: f.name, parents: [folder] })}\r\n--${boundary}\r\ncontent-type: ${f.mime || "application/octet-stream"}\r\n\r\n`),
        Buffer.from(await data.arrayBuffer()),
        Buffer.from(`\r\n--${boundary}--`),
      ]);
      const up = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true", { method: "POST", headers: { ...auth, "content-type": `multipart/related; boundary=${boundary}` }, body });
      if (!up.ok) throw new Error(`Drive upload ${up.status}`);
    }
    return "saved" as const;
  } catch (e) {
    console.error("[guide] Drive upload failed (is Drive write allowed for the service account?):", e instanceof Error ? e.message : e);
    return "kept here" as const;
  }
}

/** Unbranded winners from other clients in their industry, to point at ("more like this") */
export async function industryExamples(admin: SupabaseClient, clientId: string) {
  const { data: c } = await admin.from("clients").select("industry, vertical_id").eq("id", clientId).single();
  if (!c?.industry) return [];
  const { data: peers } = await admin.from("clients").select("id").eq("industry", c.industry).neq("id", clientId).limit(200);
  const ids = (peers ?? []).map((p) => p.id as string);
  if (!ids.length) return [];
  const { data } = await admin.from("hall_of_fame").select("ad_id, creative, beat_by").in("client_id", ids).gt("expires_at", new Date().toISOString()).order("beat_by", { ascending: false }).limit(40);
  return (data ?? [])
    .map((h) => {
      const cr = (h.creative ?? {}) as { image?: string; poster?: string; video?: string };
      return { id: h.ad_id as string, image: cr.poster ?? cr.image ?? null, video: Boolean(cr.video) };
    })
    .filter((x): x is { id: string; image: string; video: boolean } => Boolean(x.image))
    .slice(0, 12);
}
