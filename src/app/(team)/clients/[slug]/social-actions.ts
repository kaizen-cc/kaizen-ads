"use server";

import { mayEditSetup, SETUP_REFUSAL } from "@/lib/setup-access";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireStaff } from "@/lib/auth";
import { addSocialAccount, discoverSocialLinks, labelSocialAccount, removeSocialAccount, setSocialLink, socialCandidates, syncSocial } from "@/lib/social/store";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Social on the client page: anyone on the client can pick which Facebook Page and Instagram account are theirs (the
// name matching can miss) and sync it now. Everything is read only on Meta.

type Result = { ok: true; pageName?: string | null } | { ok: false; error: string };

async function mine(clientId: string, change = false) {
  const me = await requireStaff();
  if (change && !mayEditSetup(me)) return { error: SETUP_REFUSAL } as const;
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
  const l = await mine(clientId, true);
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
export async function findSocialAccounts(clientId: string, bmId?: string | null): Promise<{ ok: true; added: string[]; pages: PageChoice[]; note: string | null } | { ok: false; error: string }> {
  const l = await mine(clientId, true);
  if ("error" in l) return { ok: false, error: l.error! };
  const r = await discoverSocialLinks(l.admin, clientId, { apply: true, by: l.me.id, ...(bmId !== undefined ? { bmId } : {}) });
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
export async function addSocialAccountAction(clientId: string, input: { pageId?: string | null; igId?: string | null; location?: string | null; bmId?: string | null }): Promise<{ ok: true; added: string[] } | { ok: false; error: string }> {
  const l = await mine(clientId, true);
  if ("error" in l) return { ok: false, error: l.error! };
  const r = await addSocialAccount(l.admin, clientId, { pageId: input.pageId ? String(input.pageId).slice(0, 40) : null, igId: input.igId ? String(input.igId).slice(0, 40) : null, location: input.location ?? null, by: l.me.id, ...(input.bmId !== undefined ? { bmId: input.bmId } : {}) });
  if (!r.ok) return r;
  const admin = l.admin;
  after(() => syncSocial(admin, clientId, { window: "full" }).then(() => undefined));
  revalidatePath(`/clients/${l.slug}`);
  revalidatePath("/settings");
  return r;
}

/** Take an account off (its numbers are kept; it's never linked again by name) */
export async function removeSocialAccountAction(clientId: string, linkId: string): Promise<Result> {
  const l = await mine(clientId, true);
  if ("error" in l) return { ok: false, error: l.error! };
  const r = await removeSocialAccount(l.admin, clientId, linkId, l.me.id);
  revalidatePath(`/clients/${l.slug}`);
  return r;
}

/** Name an account's location */
export async function labelSocialAccountAction(clientId: string, linkId: string, location: string): Promise<Result> {
  const l = await mine(clientId, true);
  if ("error" in l) return { ok: false, error: l.error! };
  const r = await labelSocialAccount(l.admin, clientId, linkId, location);
  revalidatePath(`/clients/${l.slug}`);
  return r;
}

// ─── From a Business Manager (owner, Nov 20 2026) ───────────────────────────

export type SocialBm = { id: string; name: string; isDefault: boolean; status: string };
export type SocialBmPage = { id: string; name: string; igId: string | null; igUsername: string | null; how: "owned" | "client" | "assigned"; linked: boolean; likely: boolean };

/** The Business Managers to pick from (the same list as the client's Meta ad account) and the one to start on: the client's Meta Business Manager, else Kaizen's */
export async function socialBusinessManagers(clientId: string): Promise<{ ok: true; options: SocialBm[]; selected: string | null } | { ok: false; error: string }> {
  const l = await mine(clientId);
  if ("error" in l) return { ok: false, error: l.error! };
  const { clientBusinessManager } = await import("@/lib/meta-tokens");
  const d = await clientBusinessManager(l.admin, clientId);
  if (!d) return { ok: false, error: "The Business Managers aren't set up yet: an executive adds them in Settings › Sync health." };
  const def = d.options.find((o) => o.isDefault) ?? null;
  return { ok: true, options: d.options, selected: d.selected ?? def?.id ?? null };
}

/** One Business Manager's Facebook Pages and the Instagram account on each, the ones that look like the client first; already linked ones marked */
export async function businessManagerSocialPages(clientId: string, bmId: string): Promise<{ ok: true; bm: string; pages: SocialBmPage[]; note: string | null } | { ok: false; error: string }> {
  const l = await mine(clientId);
  if ("error" in l) return { ok: false, error: l.error! };
  const [{ businessManagerPages }, { clientPages }, { data: c }, { data: names }, { data: had }] = await Promise.all([
    import("@/lib/social/business-pages"),
    import("@/lib/social/links-core"),
    l.admin.from("clients").select("name").eq("id", clientId).maybeSingle(),
    l.admin.from("clients").select("id, name").is("archived_at", null),
    l.admin.from("social_links").select("platform, account_id").eq("client_id", clientId).is("removed_at", null),
  ]);
  const r = await businessManagerPages(l.admin, bmId);
  const name = (c?.name as string | null) ?? "";
  const likely = new Set(clientPages(r.pages, name, (names ?? []).filter((n) => n.id !== clientId).map((n) => n.name as string)).map((m) => m.page.id));
  const linked = new Set((had ?? []).map((h) => `${h.platform}:${h.account_id}`));
  const pages = r.pages
    .map((p) => ({ id: p.id, name: p.name, igId: p.ig?.id ?? null, igUsername: p.ig?.username ?? null, how: p.how, linked: linked.has(`facebook:${p.id}`), likely: likely.has(p.id) }))
    .sort((a, b) => Number(b.likely) - Number(a.likely) || a.name.localeCompare(b.name));
  const access = `we need partner access to ${name || "the client"}'s Business Manager (their Page shared with ${r.bm})`;
  const note = r.error
    ? `${r.bm} couldn't list its Pages (${r.error}).`
    : !pages.length
      ? `We can't see any Pages through ${r.bm}: ${access}.`
      : !likely.size
        ? `None of ${r.bm}'s Pages looks like ${name}. If theirs isn't listed, ${access}, or try another Business Manager.`
        : null;
  return { ok: true, bm: r.bm, pages, note };
}
