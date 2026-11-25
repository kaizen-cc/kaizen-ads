import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { cadenceText, expectedFlow, groupFlows, isFlowType, isSilent, slugFromRecipients, SWIPE_DOMAIN, SWIPE_LOCAL, triggerOf, type FlowType } from "./core";

// The swipe bot's server side (the cron's "swipe" step every 15 minutes; the browser runner that signs brands up and
// triggers their flows is scripts/swipe-runner.mjs on GitHub Actions):
//   checkMailbox  the swipe@ alias resolved to the Workspace user it lives on (Admin Directory), that mailbox checked for
//                 auto-forwarding (the runner signs nothing up while it forwards), and a "Swipe" label made (gmail.modify)
//                 when that scope is granted; the result is kept in app_settings.swipe for the runner and the report
//   ingestSwipe   every new email to swipe+<brand>@: brand, sender, subject, preheader, received_at, its trigger and the
//                 hours since, flow type / offer / CTA / SMS ask (Haiku), the HTML and a screenshot in Storage; labelled
//                 Swipe and taken out of the inbox when allowed; grouped into flows with step numbers and timing
//   swipeHealth   a brand that has sent nothing 14 days after signing up is flagged silent; brands that need a human
//                 signup (a CAPTCHA, no form) become one item for the email lead (deduped against reality)

type Admin = SupabaseClient;
export const SWIPE_ALIAS = `${SWIPE_LOCAL}@${SWIPE_DOMAIN}`;
const READ = "https://www.googleapis.com/auth/gmail.readonly";
const MODIFY = "https://www.googleapis.com/auth/gmail.modify";
const DIRECTORY = "https://www.googleapis.com/auth/admin.directory.user.readonly";
const BUCKET = "swipe";

export type SwipeStatus = { mailbox: string | null; forwarding: { enabled: boolean; to: string | null } | null; modify: boolean; label_id: string | null; checked_at: string; error: string | null };

async function gget<T>(token: string, url: string, params: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${url}${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ""}`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!res.ok) throw new Error(`Google said ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

export async function swipeStatus(admin: Admin): Promise<SwipeStatus | null> {
  const { data } = await admin.from("app_settings").select("value").eq("key", "swipe").maybeSingle();
  return (data?.value as SwipeStatus | null) ?? null;
}

/** Where the swipe@ alias lives, whether it forwards, whether we may label (kept in app_settings.swipe) */
export async function checkMailbox(admin: Admin): Promise<SwipeStatus> {
  const { googleConfigured, googleTokenFor } = await import("@/lib/context/google");
  const now = new Date().toISOString();
  const out: SwipeStatus = { mailbox: null, forwarding: null, modify: false, label_id: null, checked_at: now, error: null };
  try {
    if (!googleConfigured()) throw new Error("Google isn't connected");
    const adminUser = process.env.GOOGLE_ADMIN_USER || process.env.GOOGLE_DRIVE_USER;
    if (!adminUser) throw new Error("No Workspace admin set (GOOGLE_ADMIN_USER)");
    // users.get resolves an alias to its primary user
    const dir = await googleTokenFor(adminUser, DIRECTORY);
    const u = await gget<{ primaryEmail: string }>(dir, `https://admin.googleapis.com/admin/directory/v1/users/${encodeURIComponent(SWIPE_ALIAS)}`);
    out.mailbox = u.primaryEmail.toLowerCase();
    const read = await googleTokenFor(out.mailbox, READ);
    const fw = await gget<{ enabled?: boolean; emailAddress?: string }>(read, "https://gmail.googleapis.com/gmail/v1/users/me/settings/autoForwarding");
    out.forwarding = { enabled: Boolean(fw.enabled), to: fw.emailAddress ?? null };
    try {
      const mod = await googleTokenFor(out.mailbox, MODIFY);
      const labels = await gget<{ labels?: { id: string; name: string }[] }>(mod, "https://gmail.googleapis.com/gmail/v1/users/me/labels");
      let label = (labels.labels ?? []).find((l) => l.name === "Swipe");
      if (!label) {
        const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/labels", { method: "POST", headers: { authorization: `Bearer ${mod}`, "content-type": "application/json" }, body: JSON.stringify({ name: "Swipe", labelListVisibility: "labelShow", messageListVisibility: "show" }) });
        if (res.ok) label = (await res.json()) as { id: string; name: string };
      }
      out.modify = Boolean(label);
      out.label_id = label?.id ?? null;
    } catch {
      out.modify = false;
    }
  } catch (e) {
    out.error = e instanceof Error ? e.message.slice(0, 300) : String(e);
  }
  await admin.from("app_settings").upsert({ key: "swipe", value: out }, { onConflict: "key" });
  return out;
}

type Part = { mimeType?: string; headers?: { name: string; value: string }[]; body?: { data?: string }; parts?: Part[] };
const b64 = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
function htmlOf(p: Part): string | null {
  if (p.mimeType === "text/html" && p.body?.data) return b64(p.body.data);
  for (const c of p.parts ?? []) {
    const h = htmlOf(c);
    if (h) return h;
  }
  return null;
}
const header = (p: Part, name: string) => p.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;
/** The preheader: the hidden first text of the email, else the start of its text */
export function preheaderOf(html: string, snippet: string | null): string {
  const hidden = /<(?:div|span|p)[^>]*(?:display:\s*none|max-height:\s*0|opacity:\s*0)[^>]*>([^<]{8,240})</i.exec(html)?.[1];
  return (hidden ?? snippet ?? "").replace(/&nbsp;|‌|͏|&zwnj;/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
}

/** The email's links (buttons and product links first), for the runner to open one before browsing */
export function linksOf(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href="(https?:[^"]+)"/gi)) {
    const u = m[1].replace(/&amp;/g, "&");
    if (/unsubscribe|preferences|manage|privacy|terms|facebook\.com|instagram\.com|tiktok\.com|twitter\.com|x\.com|youtube\.com|pinterest\.com|mailto:/i.test(u)) continue;
    if (!out.includes(u)) out.push(u);
    if (out.length >= 10) break;
  }
  return out;
}

const CLASSIFY = {
  type: "object",
  additionalProperties: false,
  required: ["flow_type", "offer", "cta", "sms_ask", "summary"],
  properties: { flow_type: { type: "string", enum: ["welcome", "browse", "cart", "checkout", "winback", "campaign", "transactional", "other"] }, offer: { type: "string" }, cta: { type: "string" }, sms_ask: { type: "boolean" }, summary: { type: "string" } },
};

/** New swipe emails in, stored and classified; at most `max` a run */
export async function ingestSwipe(admin: Admin, { max = 40, budgetMs = 240_000 }: { max?: number; budgetMs?: number } = {}) {
  const started = Date.now();
  const st = (await swipeStatus(admin)) ?? (await checkMailbox(admin));
  if (!st.mailbox) return { skipped: st.error ?? "The swipe mailbox isn't resolved yet" };
  const { googleTokenFor } = await import("@/lib/context/google");
  const token = await googleTokenFor(st.mailbox, st.modify ? MODIFY : READ);
  const list = await gget<{ messages?: { id: string }[] }>(token, "https://gmail.googleapis.com/gmail/v1/users/me/messages", { q: `to:${SWIPE_LOCAL}+* OR deliveredto:${SWIPE_ALIAS} newer_than:60d`, maxResults: "100", includeSpamTrash: "true" });
  const ids = (list.messages ?? []).map((m) => m.id);
  if (!ids.length) return { new: 0 };
  const { data: have } = await admin.from("swipe_emails").select("gmail_id").in("gmail_id", ids);
  const seen = new Set((have ?? []).map((r) => r.gmail_id as string));
  const todo = ids.filter((id) => !seen.has(id)).slice(0, max);
  const { data: brands } = await admin.from("swipe_brands").select("id, slug, name, signed_up_at, browsed_at, carted_at, checkout_at, emails, status");
  const bySlug = new Map(((brands ?? []) as { id: string; slug: string; name: string; signed_up_at: string | null; browsed_at: string | null; carted_at: string | null; checkout_at: string | null; emails: number; status: string }[]).map((b) => [b.slug, b]));
  const { renderEmailShot } = await import("@/lib/channel-reports/email-shots");
  let stored = 0;
  for (const id of todo) {
    if (Date.now() - started > budgetMs) break;
    const m = await gget<{ id: string; internalDate: string; snippet?: string; labelIds?: string[]; payload: Part }>(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`, { format: "full" });
    const p = m.payload;
    const slug = slugFromRecipients(header(p, "Delivered-To"), header(p, "To"), header(p, "X-Original-To"), header(p, "Cc"));
    const brand = slug ? bySlug.get(slug) ?? null : null;
    const receivedAt = new Date(Number(m.internalDate)).toISOString();
    const html = htmlOf(p) ?? `<pre>${(m.snippet ?? "").replace(/</g, "&lt;")}</pre>`;
    const subject = header(p, "Subject") ?? "";
    const trig = brand ? triggerOf(receivedAt, { signup: brand.signed_up_at, browse: brand.browsed_at, cart: brand.carted_at, checkout: brand.checkout_at }) : { kind: null, hours: null };
    // Haiku reads the email: which flow it belongs to, the offer, the CTA, an SMS opt-in ask
    const text = html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").slice(0, 5000);
    const c = await askJson<{ flow_type: string; offer: string; cta: string; sms_ask: boolean; summary: string }>({
      agent: "email_desk",
      label: "swipe email classify",
      override: { model: "haiku", effort: "low" },
      bare: true,
      schema: CLASSIFY,
      maxTokens: 600,
      system: "You classify a brand's marketing email for an email agency's swipe file. flow_type: welcome (after a signup), browse (after viewing products), cart (left items in the cart), checkout (started checkout), winback, campaign (a broadcast/newsletter), transactional, other. offer: the discount or incentive in a few words, or \"\". cta: the main button text. sms_ask: does it ask to join SMS. summary: one line on the angle.",
      prompt: `Subject: ${subject}\nArrived ${trig.hours != null ? `${trig.hours}h after the bot's last action (${trig.kind}, expected flow: ${expectedFlow[trig.kind!]})` : "with no bot action before it"}.\n\n${text}`,
    }).catch(() => ({ flow_type: trig.kind ? expectedFlow[trig.kind] : "other", offer: "", cta: "", sms_ask: false, summary: "" }));
    const flow: FlowType = isFlowType(c.flow_type) ? c.flow_type : "other";
    const folder = slug ?? "unmatched";
    const htmlPath = `${folder}/${id}.html`;
    await admin.storage.from(BUCKET).upload(htmlPath, Buffer.from(html), { contentType: "text/html", upsert: true });
    const shot = await renderEmailShot(html).catch(() => null);
    const shotPath = shot ? `${folder}/${id}.jpg` : null;
    if (shot) await admin.storage.from(BUCKET).upload(shotPath!, shot, { contentType: "image/jpeg", upsert: true });
    await admin.from("swipe_emails").insert({
      brand_id: brand?.id ?? null,
      gmail_id: id,
      to_address: header(p, "Delivered-To") ?? header(p, "To"),
      sender: header(p, "From"),
      subject: subject.slice(0, 500),
      preheader: preheaderOf(html, m.snippet ?? null),
      received_at: receivedAt,
      trigger_kind: trig.kind,
      offset_hours: trig.hours,
      flow_type: flow,
      offer: c.offer.slice(0, 300) || null,
      cta: c.cta.slice(0, 120) || null,
      sms_ask: c.sms_ask,
      summary: c.summary.slice(0, 400) || null,
      html_path: htmlPath,
      shot_path: shotPath,
      links: linksOf(html),
    });
    stored++;
    if (brand) {
      brand.emails += 1;
      await admin.from("swipe_brands").update({ last_email_at: receivedAt, emails: brand.emails, status: brand.status === "retired" ? "retired" : "active", updated_at: new Date().toISOString() }).eq("id", brand.id);
    }
    // Out of the inbox, under Swipe (only when the mailbox lets us modify)
    if (st.modify && st.label_id)
      await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/modify`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ addLabelIds: [st.label_id], removeLabelIds: ["INBOX"] }) }).catch(() => undefined);
  }
  const flows = await regroup(admin);
  return { new: stored, flows };
}

/** Rebuilds the flows from the emails (step numbers, the timing between steps, the offers) */
export async function regroup(admin: Admin) {
  const { data } = await admin.from("swipe_emails").select("id, brand_id, flow_type, received_at, offset_hours, trigger_kind, offer").not("brand_id", "is", null).order("received_at").limit(5000);
  const rows = (data ?? []) as { id: string; brand_id: string; flow_type: FlowType; received_at: string; offset_hours: number | null; trigger_kind: string | null; offer: string | null }[];
  const groups = groupFlows(rows.map((r) => ({ id: r.id, brand: r.brand_id, type: r.flow_type, at: r.received_at, trigger: r.trigger_kind })));
  let n = 0;
  for (const g of groups) {
    const first = rows.find((r) => r.id === g.ids[0]);
    const offers = [...new Set(g.ids.map((id) => rows.find((r) => r.id === id)?.offer).filter(Boolean))].join(" · ").slice(0, 400) || null;
    const { data: f } = await admin.from("swipe_flows").upsert({ brand_id: g.brand, flow_type: g.type, started_at: g.startedAt, steps: g.ids.length, cadence: cadenceText(g.gapsHours, first?.offset_hours ?? null), offers, updated_at: new Date().toISOString() }, { onConflict: "brand_id,flow_type,started_at" }).select("id").single();
    if (!f) continue;
    for (let i = 0; i < g.ids.length; i++) await admin.from("swipe_emails").update({ flow_id: f.id, step: i + 1 }).eq("id", g.ids[i]);
    n++;
  }
  return n;
}

/** Silent brands flagged; brands that need a human signup become one item for the email lead */
export async function swipeHealth(admin: Admin) {
  const { data: brands } = await admin.from("swipe_brands").select("id, name, website, status, signed_up_at, emails, note");
  let silent = 0;
  for (const b of (brands ?? []) as { id: string; name: string; status: string; signed_up_at: string | null; emails: number }[])
    if (b.status === "subscribed" && isSilent(b)) {
      await admin.from("swipe_brands").update({ status: "silent", note: "Nothing arrived 14 days after signing up", updated_at: new Date().toISOString() }).eq("id", b.id);
      silent++;
    }
  const needs = ((brands ?? []) as { name: string; website: string; status: string; note: string | null }[]).filter((b) => b.status === "needs_human");
  let item: string | null = null;
  if (needs.length) {
    const { data: lead } = await admin.from("profiles").select("id").eq("role", "head_of_email").eq("is_active", true).limit(1).maybeSingle();
    if (lead) {
      const { createItemIfNew } = await import("@/lib/reality-check");
      const week = new Date().toISOString().slice(0, 10);
      const r = await createItemIfNew(admin, {
        owner_id: lead.id as string,
        client_id: null,
        title: `Sign the swipe file up to ${needs.length} brand${needs.length === 1 ? "" : "s"} by hand`,
        detail: `The swipe bot stopped at a CAPTCHA or couldn't find a signup form. Sign up with each brand's swipe address (swipe+<brand>@${SWIPE_DOMAIN}), then ask your assistant to mark it subscribed:\n${needs.map((b) => `- ${b.name} (${b.website})${b.note ? `: ${b.note}` : ""}`).join("\n")}`,
        source_ref: `swipe-needs-human:${week}`,
      });
      item = r.state;
    }
  }
  return { silent, needs_human: needs.length, item };
}

/** The whole step */
export async function runSwipe(admin: Admin) {
  const st = await swipeStatus(admin);
  const fresh = st && Date.now() - Date.parse(st.checked_at) < 3_600_000 ? st : await checkMailbox(admin);
  if (!fresh.mailbox) return { mailbox: null, error: fresh.error };
  const ingest = await ingestSwipe(admin).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
  const health = await swipeHealth(admin).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
  return { mailbox: fresh.mailbox, forwarding: fresh.forwarding, modify: fresh.modify, ingest, health };
}
