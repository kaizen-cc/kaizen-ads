import "server-only";
import type { Staff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { addressOf, FLOW_LABEL, isFlowType, slugOf } from "@/lib/swipe/core";
import { num, str, type AiTool } from "./types";

// The swipe file, for the assistant, every agent call and Kaizen AI (registered in src/lib/kaizen-ai/extensions.ts):
//   swipe_flows        the best brands' real email flows (welcome, browse, cart, checkout, winback, campaigns) by vertical,
//                      type or brand: steps, cadence, offers, each email's subject and a screenshot link
//   swipe_brands       the brands followed and where each stands (subscribed, active, needs a human signup, silent)
//   swipe_add_brand    execs and the email lead: follow a brand (it's signed up by the runner on its next pass)
//   swipe_subscribed   after a human signed a brand up by hand (a CAPTCHA stopped the bot): it's followed from now
// The emails arrive in the swipe@ mailbox and are read in by the cron's swipe step (src/lib/swipe/server.ts).

const mayManage = (u: Staff) => Boolean(u.isExec || u.role === "head_of_email" || u.role === "email_strategist");

const flows: AiTool = {
  name: "swipe_flows",
  description:
    "Anyone: real email flows from the brands Kaizen follows (the swipe file: welcome, browse abandon, cart abandon, checkout abandon, winback and campaigns, captured as they arrived). Filter by vertical (\"skincare\", \"apparel\", \"med spa\"), flow_type (welcome, browse, cart, checkout, winback, campaign) or brand. Each flow with its steps, cadence (\"3 emails: right away, +1 day, +3 days\"), offers, and each email's subject, CTA, SMS ask and a screenshot link (opens in a new tab). Use it for \"show me the best cart-abandon flows in skincare\" and to cite real examples in email briefs.",
  input_schema: { type: "object", properties: { vertical: { type: "string" }, flow_type: { type: "string", enum: ["welcome", "browse", "cart", "checkout", "winback", "campaign", "transactional"] }, brand: { type: "string" }, limit: { type: "number" } }, additionalProperties: false },
  run: async (_user: Staff, input, chat) => {
    const db = await createClient();
    let bq = db.from("swipe_brands").select("id, name, slug, vertical, website, status");
    const v = str(input.vertical);
    const b = str(input.brand);
    if (v) bq = bq.ilike("vertical", `%${v.replace(/[%_]/g, "")}%`);
    if (b) bq = bq.or(`name.ilike.%${b.replace(/[%_,]/g, "")}%,slug.eq.${slugOf(b)}`);
    const { data: brands } = await bq.limit(200);
    const ids = (brands ?? []).map((x) => x.id as string);
    if (!ids.length) return { ok: true, flows: [], note: "No brands in the swipe file match that yet." };
    let fq = db.from("swipe_flows").select("id, brand_id, flow_type, started_at, steps, cadence, offers").in("brand_id", ids).order("steps", { ascending: false }).limit(Math.max(1, Math.min(12, num(input.limit) ?? 6)));
    if (isFlowType(input.flow_type)) fq = fq.eq("flow_type", input.flow_type);
    const { data: fl } = await fq;
    if (!(fl ?? []).length) return { ok: true, flows: [], note: "Nothing captured for that yet (the bot signs brands up and triggers their flows over a few days)." };
    const { data: emails } = await db.from("swipe_emails").select("flow_id, step, subject, preheader, offer, cta, sms_ask, offset_hours, shot_path").in("flow_id", (fl ?? []).map((f) => f.id as string)).order("step");
    const admin = createAdminClient();
    const paths = (emails ?? []).map((e) => e.shot_path as string | null).filter((p): p is string => Boolean(p));
    const { data: signed } = paths.length ? await admin.storage.from("swipe").createSignedUrls(paths, 6 * 3600) : { data: [] };
    const link = new Map((signed ?? []).map((s) => [s.path, s.signedUrl]));
    const name = new Map((brands ?? []).map((x) => [x.id as string, `${x.name} (${x.vertical})`]));
    const out = (fl ?? []).map((f) => ({
      brand: name.get(f.brand_id as string),
      flow: FLOW_LABEL[f.flow_type as keyof typeof FLOW_LABEL] ?? f.flow_type,
      steps: f.steps,
      cadence: f.cadence,
      offers: f.offers,
      emails: (emails ?? []).filter((e) => e.flow_id === f.id).map((e) => ({ step: e.step, subject: e.subject, preheader: e.preheader, offer: e.offer, cta: e.cta, sms_ask: e.sms_ask, hours_after_trigger: e.offset_hours, screenshot: e.shot_path ? (link.get(e.shot_path as string) ?? null) : null })),
    }));
    chat?.card({ type: "list", title: `Swipe file: ${[v, isFlowType(input.flow_type) ? FLOW_LABEL[input.flow_type] : null, b].filter(Boolean).join(" · ") || "flows"}`, items: out.flatMap((f) => f.emails.map((e) => ({ title: `${f.brand} · ${f.flow} ${e.step}/${f.steps}: ${e.subject ?? ""}`, detail: [e.offer, e.cta && `CTA: ${e.cta}`, e.hours_after_trigger != null ? `+${e.hours_after_trigger}h` : null].filter(Boolean).join(" · "), href: e.screenshot }))).slice(0, 30) });
    return { ok: true, flows: out };
  },
};

const brandsTool: AiTool = {
  name: "swipe_brands",
  description: "Anyone: the brands the swipe file follows and where each stands: new (not signed up yet), subscribed (waiting for emails), active (emails arriving), needs_human (a CAPTCHA or no form stopped the bot: someone signs up by hand), silent (nothing 14 days after signup), retired. status filters.",
  input_schema: { type: "object", properties: { status: { type: "string" }, vertical: { type: "string" } }, additionalProperties: false },
  run: async (_user: Staff, input) => {
    const db = await createClient();
    let q = db.from("swipe_brands").select("name, slug, website, vertical, source, status, emails, signed_up_at, last_email_at, note").order("vertical").limit(200);
    if (str(input.status)) q = q.eq("status", str(input.status)!);
    if (str(input.vertical)) q = q.ilike("vertical", `%${str(input.vertical)!.replace(/[%_]/g, "")}%`);
    const { data } = await q;
    return { ok: true, brands: (data ?? []).map((b) => ({ ...b, address: addressOf(b.slug as string) })) };
  },
};

const add: AiTool = {
  name: "swipe_add_brand",
  description: "Executives and the email lead: follow a brand in the swipe file (name, website, vertical like \"ecommerce · skincare\"). The browser bot signs it up on its next pass with its own address and triggers its flows over the following days.",
  input_schema: { type: "object", properties: { name: { type: "string" }, website: { type: "string" }, vertical: { type: "string" } }, required: ["name", "website", "vertical"], additionalProperties: false },
  run: async (user: Staff, input) => {
    if (!mayManage(user)) return { ok: false, error: "Adding brands to the swipe file is for the executives and the email lead." };
    const slug = slugOf(str(input.name) ?? "");
    const site = str(input.website);
    if (slug.length < 2 || !site) return { ok: false, error: "A brand needs a name and its website." };
    const { cleanSite } = await import("@/lib/sales-core");
    const { error } = await createAdminClient().from("swipe_brands").insert({ slug, name: str(input.name)!.slice(0, 120), website: cleanSite(site) ?? site, vertical: str(input.vertical)!.slice(0, 80), source: "manual", added_by: user.id });
    if (error) return { ok: false, error: /duplicate/.test(error.message) ? "That brand is already in the swipe file." : error.message };
    return { ok: true, added: str(input.name), address: addressOf(slug), say: `Added. The bot signs up as ${addressOf(slug)} on its next pass.` };
  },
};

const subscribed: AiTool = {
  name: "swipe_subscribed",
  description: "Executives and the email lead: someone signed a brand up by hand (the bot stopped at a CAPTCHA or found no form). Marks it subscribed from now, so its emails are expected and its browse and cart steps run later.",
  input_schema: { type: "object", properties: { brand: { type: "string" } }, required: ["brand"], additionalProperties: false },
  run: async (user: Staff, input) => {
    if (!mayManage(user)) return { ok: false, error: "That's for the executives and the email lead." };
    const admin = createAdminClient();
    const { data: b } = await admin.from("swipe_brands").select("id, name, slug").or(`slug.eq.${slugOf(str(input.brand) ?? "")},name.ilike.${(str(input.brand) ?? "").replace(/[%_,]/g, "")}`).limit(1).maybeSingle();
    if (!b) return { ok: false, error: "That brand isn't in the swipe file." };
    await admin.from("swipe_brands").update({ status: "subscribed", signed_up_at: new Date().toISOString(), note: "Signed up by hand", updated_at: new Date().toISOString() }).eq("id", b.id);
    await admin.from("swipe_events").insert({ brand_id: b.id, kind: "signup", ok: true, detail: `By hand (${user.fullName})` });
    return { ok: true, brand: b.name };
  },
};

export const tools: AiTool[] = [flows, brandsTool, add, subscribed];
