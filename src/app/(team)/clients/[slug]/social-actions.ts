"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireStaff } from "@/lib/auth";
import { addSocialAccount, discoverSocialLinks, labelSocialAccount, removeSocialAccount, setSocialLink, socialCandidates, syncSocial } from "@/lib/social/store";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Social on the client page: anyone on the client can pick which Facebook Page and Instagram account are theirs (the
// name matching can miss) and sync it now. Everything is read only on Meta.

type Result = { ok: true; pageName?: string | null } | { ok: false; error: string };

async function mine(clientId: string) {
  const me = await requireStaff();
  if (!adminConfigured()) return { error: "Not set up here." } as const;
  const { data } = await (await createClient()).from("clients").select("id, slug").eq("id", clientId).maybeSingle();
  if (!data) return { error: "You don't work on this client." } as const;
  return { me, slug: data.slug as string, admin: createAdminClient() } as const;
}

export type PageChoice = { id: string; name: string; igId: string | null; igUsername: string | null };

/** The Pages to pick from for this client: their ad account's promotable Pages and every Page the system user has */
export async function socialPageChoices(clientId: string): Promise<{ ok: true; pages: PageChoice[]; note: string | null } | { ok: false; error: string }> {
  const l = await mine(clientId);
  if ("error" in l) return { ok: false, error: l.error! };
  const r = await socialCandidates(l.admin, clientId);
  return { ok: true, pages: r.pages.map((p) => ({ id: p.id, name: p.name, igId: p.ig?.id ?? null, igUsername: p.ig?.username ?? null })), note: r.error };
}

/** Link a Page (and its Instagram account, or a different one by ID) to the client, then read it */
export async function saveSocialLink(clientId: string, pageId: string, igId: string | null): Promise<Result> {
  const l = await mine(clientId);
  if ("error" in l) return { ok: false, error: l.error! };
  const r = await setSocialLink(l.admin, clientId, { pageId: String(pageId).slice(0, 40), igId: igId ? String(igId).slice(0, 40) : null, by: l.me.id });
  if (!r.ok) return r;
  // The first read (90 days back) right after the answer
  const admin = l.admin;
  after(() => syncSocial(admin, clientId, { window: "full" }).then(() => undefined));
  revalidatePath(`/clients/${l.slug}`);
  revalidatePath("/settings");
  return { ok: true, pageName: r.pageName };
}

export async function syncSocialNow(clientId: string): Promise<Result> {
  const l = await mine(clientId);
  if ("error" in l) return { ok: false, error: l.error! };
  const r = await syncSocial(l.admin, clientId);
  revalidatePath(`/clients/${l.slug}`);
  revalidatePath("/settings");
  return r.ok ? { ok: true } : { ok: false, error: (r.error ?? "The sync failed.").slice(0, 240) };
}

// ─── Many accounts per client (a Page and Instagram per location) ───────────

/** Link every Page that's clearly theirs (and its Instagram), labeled with its location; the rest come back to pick from */
export async function findSocialAccounts(clientId: string): Promise<{ ok: true; added: string[]; pages: PageChoice[]; note: string | null } | { ok: false; error: string }> {
  const l = await mine(clientId);
  if ("error" in l) return { ok: false, error: l.error! };
  const r = await discoverSocialLinks(l.admin, clientId, { apply: true, by: l.me.id });
  if (r.added.length) {
    const admin = l.admin;
    after(() => syncSocial(admin, clientId, { window: "full" }).then(() => undefined));
  }
  revalidatePath(`/clients/${l.slug}`);
  return {
    ok: true,
    added: r.added.map((a) => `${a.platform === "instagram" ? "Instagram" : "Facebook"} ${a.platform === "instagram" && a.name ? `@${a.name}` : (a.name ?? a.accountId)}${a.location ? ` (${a.location})` : ""}`),
    pages: r.others.map((p) => ({ id: p.id, name: p.name, igId: p.ig?.id ?? null, igUsername: p.ig?.username ?? null })),
    note: r.error,
  };
}

/** Add a Page (with its Instagram) or an Instagram account by ID, for a location */
export async function addSocialAccountAction(clientId: string, input: { pageId?: string | null; igId?: string | null; location?: string | null }): Promise<{ ok: true; added: string[] } | { ok: false; error: string }> {
  const l = await mine(clientId);
  if ("error" in l) return { ok: false, error: l.error! };
  const r = await addSocialAccount(l.admin, clientId, { pageId: input.pageId ? String(input.pageId).slice(0, 40) : null, igId: input.igId ? String(input.igId).slice(0, 40) : null, location: input.location ?? null, by: l.me.id });
  if (!r.ok) return r;
  const admin = l.admin;
  after(() => syncSocial(admin, clientId, { window: "full" }).then(() => undefined));
  revalidatePath(`/clients/${l.slug}`);
  revalidatePath("/settings");
  return r;
}

/** Take an account off (its numbers are kept; it's never linked again by name) */
export async function removeSocialAccountAction(clientId: string, linkId: string): Promise<Result> {
  const l = await mine(clientId);
  if ("error" in l) return { ok: false, error: l.error! };
  const r = await removeSocialAccount(l.admin, clientId, linkId, l.me.id);
  revalidatePath(`/clients/${l.slug}`);
  return r;
}

/** Name an account's location */
export async function labelSocialAccountAction(clientId: string, linkId: string, location: string): Promise<Result> {
  const l = await mine(clientId);
  if ("error" in l) return { ok: false, error: l.error! };
  const r = await labelSocialAccount(l.admin, clientId, linkId, location);
  revalidatePath(`/clients/${l.slug}`);
  return r;
}
