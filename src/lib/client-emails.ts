import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendEmail } from "@/lib/email";
import { emailHtml, emailText, type EmailParts } from "@/lib/email-layout";
import { guideSteps } from "@/lib/onboarding-guide-types";
import { INTAKE_FORM_URL, type Deck } from "@/lib/presentation-types";
import { servicesOf } from "@/lib/services";
import { siteUrl } from "@/lib/site";

// Every email a client gets from us at a stage of onboarding, written in one place: sent on its own by the flow (the
// welcome, the presentation, you're live), or pushed again by the team from the client page as a reminder. Each one
// sent is kept (subject, the email as it looked, who it went to) so the team sees when the last one went and what it said.

export type ClientEmailKind = "welcome" | "intake" | "presentation" | "live";
export const EMAIL_KINDS: { kind: ClientEmailKind; name: string; what: string }[] = [
  { kind: "welcome", name: "Welcome and setup", what: "Their setup steps (only for what they buy) and the link to their guide" },
  { kind: "intake", name: "Intake form", what: "The marketing intake form, with their Client ID" },
  { kind: "presentation", name: "Review how we see you", what: "Their brand plan, to approve or tell us what's off" },
  { kind: "live", name: "You're live", what: "Their first campaign is running, with the link to their dashboard" },
];
export const kindName = (k: string) => EMAIL_KINDS.find((x) => x.kind === k)?.name ?? (k === "recap" ? "Monthly recap" : k);

type Contact = { email: string; first: string | null };
const hello = (first: string | null) => (first ? `Hi ${first},` : "Hi there,");
const NUDGE = "A quick nudge in case this got buried.";

/** The setup steps for what a client buys: Meta access if we run their Meta ads, Google if Google, the look if we run
 *  ads or make their creative, and their assets always */
export function setupSteps(services: string[]) {
  const { meta, google, looks } = guideSteps(services);
  return [
    ...(meta ? [{ title: "Give us access to your Facebook and Instagram ads", text: "Add Kaizen as a partner in your Business Manager. We show you every click, and how to make one if you don't have it yet." }] : []),
    ...(google ? [{ title: "Send us your Google Ads account ID", text: "We show you where to find it, or how to make an account." }] : []),
    { title: "Share your brand assets", text: "Your logo, photos, videos and brand guide, or a link to them." },
    ...(looks ? [{ title: "Pick the look you want", text: "The styles and pacing you love, so your first ads feel like you." }] : []),
  ];
}

export function welcomeEmail(p: { brand: string; slug: string; steps: { title: string; text?: string }[]; first: string | null; reminder?: boolean }) {
  const n = p.steps.length;
  const parts: EmailParts = {
    preheader: `${n} quick steps so we can start building your ads.`,
    kicker: p.brand,
    title: p.reminder ? "Let's get you set up" : "Welcome to Kaizen",
    highlight: p.reminder ? "set up" : "Kaizen",
    hello: hello(p.first),
    lines: p.reminder
      ? [NUDGE, `A few quick steps and we can start building your ads (about ${n * 3} minutes, and each one walks you through it):`]
      : ["We're excited to get started. Your Kaizen portal is where everything with us happens: getting set up, seeing how we see your brand, and approving every ad before it runs.", `First, ${n} quick step${n === 1 ? "" : "s"} so we can start building (about ${n * 3} minutes, and each one walks you through it):`],
    steps: p.steps,
    cta: { label: p.reminder ? "Finish setup →" : "Start setup →", url: `${siteUrl()}/c/${p.slug}/start` },
    note: "The button opens your Kaizen portal. If it asks, enter this email and we'll send you a one-tap sign-in.",
  };
  return { subject: p.reminder ? `Reminder: ${p.brand}, a few quick steps to get set up` : `Welcome to Kaizen, ${p.brand}: let's get you set up`, text: emailText(parts), html: emailHtml(parts) };
}

export function intakeEmail(p: { brand: string; clientId: number | null; first: string | null; reminder?: boolean }) {
  const parts: EmailParts = {
    preheader: "Ten minutes that shape everything we make for you.",
    kicker: p.brand,
    title: "Tell us about your brand",
    highlight: "your brand",
    hello: hello(p.first),
    lines: [...(p.reminder ? [NUDGE] : []), "Our marketing intake form is the fastest way for us to get you right. It covers:"],
    bullets: ["What you sell, and what makes you different", "Who your best customers are", "What's worked (and hasn't) before", "Your goals for the next few months"],
    cta: { label: "Fill in the intake form →", url: INTAKE_FORM_URL },
    note: `About ten minutes.${p.clientId != null ? ` It asks for your Client ID: ${p.clientId}.` : ""}`,
  };
  return { subject: p.reminder ? `Reminder: your ${p.brand} intake form` : `${p.brand}: your marketing intake form`, text: emailText(parts), html: emailHtml(parts) };
}

/** "Are we getting this right?": how we see them, to approve or correct. As a reminder: it's waiting on their approval */
export function presentationEmail(p: { brand: string; slug: string; headline: string; withoutIntake: boolean; clientId: number | null; first: string | null; reminder?: boolean }) {
  const link = `${siteUrl()}/c/${p.slug}/plan`;
  if (p.reminder) {
    const parts: EmailParts = {
      preheader: "Your brand plan is waiting for your OK before we make your first ads.",
      kicker: p.brand,
      title: "Your brand plan is waiting on you",
      highlight: "waiting",
      hello: hello(p.first),
      lines: [NUDGE, "Before we make your first ads, we'd love your OK on how we see you:"],
      bullets: ["Tap Spot on or Not quite on each part", "Or just talk it through with us, by text or a voice message", "Approve it, and we start on your first ads"],
      cta: { label: "Review your brand plan →", url: link },
      note: [`About five minutes. "${p.headline}"`, p.withoutIntake ? `Your intake form is still open too: ${INTAKE_FORM_URL}${p.clientId != null ? ` (your Client ID: ${p.clientId})` : ""}.` : ""].filter(Boolean).join(" "),
    };
    return { subject: `Reminder: ${p.brand}, your brand plan is waiting for your OK`, text: emailText(parts), html: emailHtml(parts) };
  }
  const parts: EmailParts = {
    preheader: p.headline,
    kicker: p.brand,
    title: p.withoutIntake ? "We got started for you" : "Are we getting this right?",
    highlight: p.withoutIntake ? "started" : "right",
    hello: hello(p.first),
    lines: [
      p.withoutIntake
        ? "We haven't received your intake form yet, but we didn't want to wait. From our conversations, your website and our own research, here's how we see you:"
        : "Thanks for your intake form. From everything you told us, plus our own research, here's how we see you:",
    ],
    bullets: ["Who you are and what makes you different", "Who we'll be speaking to, and what stops them scrolling", "How you sound", "The first campaigns we'd run", "How we get you live"],
    cta: { label: "See how we see you →", url: link },
    note: [
      "Tap Spot on or Not quite on each part, or just talk it through with us. About five minutes.",
      p.withoutIntake ? `When you have ten minutes, the intake form is here: ${INTAKE_FORM_URL}${p.clientId != null ? ` (your Client ID: ${p.clientId})` : ""}.` : "",
    ]
      .filter(Boolean)
      .join(" "),
  };
  return { subject: p.withoutIntake ? `${p.brand}: we got started, here's what we've got` : `${p.brand}: are we getting this right?`, text: emailText(parts), html: emailHtml(parts) };
}

export function liveEmail(p: { brand: string; slug: string; posts: number; geo: string; first: string | null; reminder?: boolean }) {
  const parts: EmailParts = {
    preheader: `${p.posts} of your best posts are running as ads now.`,
    kicker: p.brand,
    title: "You're live 🎉",
    hello: hello(p.first),
    lines: ["Your first campaign is running:"],
    bullets: [`${p.posts} of your best posts, now ads on Facebook and Instagram`, `Reaching people in ${p.geo}`, "Building your audience and site traffic from today", "The warm-up for the conversion campaigns that follow as your new creative lands"],
    cta: { label: "See it on your dashboard →", url: `${siteUrl()}/c/${p.slug}/dashboard` },
    note: "We'll keep you posted on how it's going.",
  };
  return { subject: `${p.brand}: your first campaign is live`, text: emailText(parts), html: emailHtml(parts) };
}

/** Who gets it: every active contact, read at the moment it's sent (so a contact added a minute ago is included) */
export async function clientRecipients(admin: SupabaseClient, clientId: string): Promise<Contact[]> {
  const { data } = await admin.from("contact_clients").select("contacts(email, full_name, is_active)").eq("client_id", clientId);
  const seen = new Set<string>();
  return (data ?? [])
    .map((l) => l.contacts as unknown as { email: string; full_name: string | null; is_active: boolean } | null)
    .filter((x): x is NonNullable<typeof x> => Boolean(x?.is_active && x.email))
    .filter((x) => !seen.has(x.email.toLowerCase()) && Boolean(seen.add(x.email.toLowerCase())))
    .map((x) => ({ email: x.email, first: x.full_name?.split(" ")[0] ?? null }));
}

/** Keep what went out: the email as the first recipient saw it, and everyone it reached */
export async function logClientEmail(admin: SupabaseClient, row: { clientId: string; kind: string; subject: string; html: string; text: string; to: string[]; by?: string | null; manual?: boolean }) {
  if (!row.to.length) return;
  await admin.from("client_emails").insert({ client_id: row.clientId, kind: row.kind, subject: row.subject, html: row.html, text: row.text, sent_to: row.to, sent_by: row.by ?? null, manual: row.manual ?? false });
}

type Composer = (first: string | null) => { subject: string; html: string; text: string };

/** The email for a stage, ready to write for each contact; null with the reason when it can't go yet */
export async function composeClientEmail(admin: SupabaseClient, clientId: string, kind: ClientEmailKind, reminder: boolean): Promise<{ make: Composer } | { error: string }> {
  const { data: c } = await admin.from("clients").select("name, slug, kaizen_id, services, services_extra, services_removed").eq("id", clientId).single();
  if (!c) return { error: "Client not found." };
  const brand = c.name as string;
  const slug = c.slug as string;
  if (kind === "welcome") {
    const steps = setupSteps(servicesOf(c));
    return { make: (first) => welcomeEmail({ brand, slug, steps, first, reminder }) };
  }
  if (kind === "intake") return { make: (first) => intakeEmail({ brand, clientId: (c.kaizen_id as number | null) ?? null, first, reminder }) };
  if (kind === "presentation") {
    const { data: p } = await admin.from("client_presentations").select("status, deck, without_intake").eq("client_id", clientId).maybeSingle();
    if (!p?.deck) return { error: "Their brand plan presentation isn't written yet." };
    if (p.status !== "sent" && p.status !== "approved") return { error: "Their presentation hasn't been sent yet: send it from the presentation page first." };
    const deck = p.deck as Deck;
    return { make: (first) => presentationEmail({ brand, slug, headline: deck.headline, withoutIntake: Boolean(p.without_intake), clientId: (c.kaizen_id as number | null) ?? null, first, reminder }) };
  }
  const { data: l } = await admin.from("engagement_launches").select("status, ad_ids, plan").eq("client_id", clientId).maybeSingle();
  if (l?.status !== "live") return { error: "Their first campaign isn't live yet." };
  const posts = ((l.ad_ids as string[] | null) ?? []).length;
  const geo = (l.plan as { geo?: { label?: string } } | null)?.geo?.label ?? "your area";
  return { make: (first) => liveEmail({ brand, slug, posts, geo, first, reminder }) };
}

/** Sent by the team from the client page: to every contact as of now, kept in the log */
/** Sent before (logged, or by the flow before the log existed): the next one is written as a reminder */
export async function wasSent(admin: SupabaseClient, clientId: string, kind: ClientEmailKind) {
  const [{ count }, { data: o }, { data: p }] = await Promise.all([
    admin.from("client_emails").select("id", { count: "exact", head: true }).eq("client_id", clientId).eq("kind", kind),
    admin.from("client_onboarding").select("welcomed_at").eq("client_id", clientId).maybeSingle(),
    admin.from("client_presentations").select("sent_at").eq("client_id", clientId).maybeSingle(),
  ]);
  return Boolean(count) || (kind === "welcome" && Boolean(o?.welcomed_at)) || (kind === "presentation" && Boolean(p?.sent_at));
}

/** What would go out now (as the first contact would see it), and to whom */
export async function previewClientEmail(admin: SupabaseClient, clientId: string, kind: ClientEmailKind) {
  const reminder = await wasSent(admin, clientId, kind);
  const [out, to] = await Promise.all([composeClientEmail(admin, clientId, kind, reminder), clientRecipients(admin, clientId)]);
  if ("error" in out) return { ok: false as const, error: out.error };
  const mail = out.make(to[0]?.first ?? null);
  return { ok: true as const, subject: mail.subject, html: mail.html, to: to.map((x) => x.email), reminder };
}

export async function pushClientEmail(admin: SupabaseClient, clientId: string, kind: ClientEmailKind, by: string) {
  const reminder = await wasSent(admin, clientId, kind);
  const out = await composeClientEmail(admin, clientId, kind, reminder);
  if ("error" in out) return { ok: false as const, error: out.error };
  const to = await clientRecipients(admin, clientId);
  if (!to.length) return { ok: false as const, error: "They have no active contact to send it to. Add one under Client contacts." };
  const sent: string[] = [];
  let first: ReturnType<Composer> | null = null;
  let error = "";
  for (const x of to) {
    const mail = out.make(x.first);
    first ??= mail;
    const r = await sendEmail({ to: x.email, ...mail });
    if (r.ok) sent.push(x.email);
    else error = r.error;
  }
  if (!sent.length || !first) return { ok: false as const, error: error || "The email didn't go out. Try again in a minute." };
  await logClientEmail(admin, { clientId, kind, ...first, to: sent, by, manual: true });
  const now = new Date().toISOString();
  // The links open their portal: it has to be on for them to get in
  if (kind !== "intake") await admin.from("clients").update({ portal_live: true, portal_live_at: now }).eq("id", clientId).eq("portal_live", false);
  if (kind === "welcome") await admin.from("client_onboarding").upsert({ client_id: clientId, welcomed_at: now, updated_at: now });
  return { ok: true as const, sent, reminder };
}

export type EmailStage = { kind: ClientEmailKind | null; why: string };

/** What the client is waiting on now, so the right reminder is the one offered first */
export async function emailStage(admin: SupabaseClient, clientId: string): Promise<EmailStage> {
  const [{ data: c }, { data: p }, { data: intake }, { data: l }] = await Promise.all([
    admin.from("clients").select("status").eq("id", clientId).single(),
    admin.from("client_presentations").select("status").eq("client_id", clientId).maybeSingle(),
    admin.from("client_intakes").select("id").eq("client_id", clientId).limit(1).maybeSingle(),
    admin.from("engagement_launches").select("status").eq("client_id", clientId).maybeSingle(),
  ]);
  if (p?.status === "sent") return { kind: "presentation", why: "Their brand plan was sent and is waiting on their approval." };
  if (l?.status === "live") return { kind: "live", why: "Their first campaign is live." };
  if (p?.status === "approved") return { kind: null, why: "They approved their brand plan; nothing is waiting on them." };
  if (!intake) return { kind: "intake", why: "We haven't received their marketing intake form yet." };
  if (c?.status === "onboarding") return { kind: "welcome", why: "Their intake is in and their brand plan is being written; their setup steps are the thing to nudge." };
  return { kind: null, why: "Nothing is waiting on them right now." };
}
