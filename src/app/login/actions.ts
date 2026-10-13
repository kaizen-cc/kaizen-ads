"use server";

import { sendEmail } from "@/lib/email";
import { magicLinkEmail } from "@/lib/magic-link-email";
import { safeNext, siteUrl } from "@/lib/site";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

export type LinkResult = { ok: true } | { ok: false; error: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Emails a one-time sign-in link to a client contact. Always answers "check your inbox" for
 * well-formed emails, so the page never reveals which addresses are on file.
 */
export async function requestMagicLink(rawEmail: string, rawNext?: string): Promise<LinkResult> {
  const email = rawEmail.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, error: "Enter a valid email address." };
  if (email.endsWith("@kaizenmarketing.agency")) {
    return { ok: false, error: "Kaizen team members sign in with Google below." };
  }
  if (!adminConfigured()) return { ok: false, error: "Sign-in isn't set up yet. Please contact your Kaizen team." };

  const admin = createAdminClient();
  const { data: contact } = await admin
    .from("contacts")
    .select("id, full_name, is_active, contact_clients(clients(name, slug, status))")
    .eq("email", email)
    .maybeSingle();

  const brands = (contact?.contact_clients ?? [])
    .map((cc: { clients: unknown }) => cc.clients as { name: string; slug: string; status: string } | null)
    .filter((c): c is { name: string; slug: string; status: string } => Boolean(c) && c!.status !== "offboarded");

  if (!contact?.is_active || brands.length === 0) {
    console.info("[magic-link] no active contact for requested email");
    return { ok: true };
  }

  // First sign-in: create the login (the database links it to the contact). Ignore "already exists".
  const created = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (created.error && !/already|registered|exists/i.test(created.error.message)) {
    console.error("[magic-link] createUser failed:", created.error.message);
    return { ok: false, error: "We couldn't send your link. Please try again in a minute." };
  }

  const { data: link, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error || !link?.properties?.hashed_token) {
    console.error("[magic-link] generateLink failed:", error?.message);
    return { ok: false, error: "We couldn't send your link. Please try again in a minute." };
  }

  const next = safeNext(rawNext, brands.length === 1 ? `/c/${brands[0].slug}` : "/c");
  const url = `${siteUrl()}/auth/confirm?token_hash=${encodeURIComponent(link.properties.hashed_token)}&type=magiclink&next=${encodeURIComponent(next)}`;
  const brandName = brands.length === 1 ? brands[0].name : null;
  const firstName = contact.full_name?.split(" ")[0] ?? null;

  const sent = await sendEmail({ to: email, ...magicLinkEmail({ link: url, brandName, firstName }) });
  if (!sent.ok) return { ok: false, error: "We couldn't send your link. Please try again in a minute." };
  return { ok: true };
}
