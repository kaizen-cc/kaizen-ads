import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { aiEnabled, askJson } from "@/lib/ai";
import { serviceFromName } from "@/lib/services";

// The enrollment and upsell forms name the client's team (media buyer, designer, video editor, copywriter, customer
// success). Those names become the client's assignments here, which is what decides who sees the client: a media
// buyer's board, KPIs and Home show only the clients they're assigned to.

type Slot = "meta_buyer" | "google_buyer" | "graphic_designer" | "video_editor" | "copywriter" | "coordinator";

// Which form question is which role (matched on the question's words, so the form's own titles work). The Google
// buyer comes before the general buyer, so "Google Media Buyer" is never read as the Meta buyer.
const QUESTION: [Slot, RegExp][] = [
  ["video_editor", /videoeditor|editor/],
  ["graphic_designer", /graphicdesigner|designer/],
  ["copywriter", /copywriter/],
  ["coordinator", /customersuccess|accountmanager|csm|coordinator/],
  ["google_buyer", /google.*buyer|googleads.*manager|ppc|search.*buyer/],
  ["meta_buyer", /mediabuyer|metabuyer|facebook.*buyer|buyer|adsmanager/],
];
// Who can hold each role
const ELIGIBLE: Record<Slot, string[]> = {
  meta_buyer: ["media_buyer", "head_of_meta"],
  google_buyer: ["google_buyer", "head_of_google", "media_buyer"],
  graphic_designer: ["graphic_designer", "head_of_creative"],
  video_editor: ["video_editor", "head_of_creative"],
  copywriter: ["copywriter"],
  coordinator: ["customer_success"],
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The team named in a form submission, as { role → names }. */
export function teamInForm(raw: Record<string, unknown>) {
  const out = new Map<Slot, string[]>();
  for (const [q, v] of Object.entries(raw)) {
    const key = norm(q);
    if (/package|creatives|services|scope|type|whitelabel/.test(key)) continue;
    const slot = QUESTION.find(([, re]) => re.test(key))?.[0];
    const text = (Array.isArray(v) ? v.join(", ") : v == null ? "" : String(v)).trim();
    if (!slot || !text || /^(none|n\/a|na|no|tbd|-)$/i.test(text)) continue;
    out.set(slot, text.split(/\s*(?:,|&|\/|\band\b)\s*/i).filter(Boolean));
  }
  return out;
}

/**
 * Assigns the people named in the form. A role the form names replaces whoever held it on this client; a name that
 * doesn't match exactly one active person is reported, never guessed.
 */
export async function applyTeam(admin: SupabaseClient, clientId: string, raw: Record<string, unknown>) {
  const team = teamInForm(raw);
  if (!team.size) return { assigned: {}, unmatched: [] as string[] };
  const { data: people } = await admin.from("profiles").select("id, full_name, role").eq("is_active", true);
  const assigned: Record<string, string> = {};
  const unmatched: string[] = [];
  for (const [slot, names] of team) {
    const pool = (people ?? []).filter((p) => ELIGIBLE[slot].includes(p.role));
    const ids: string[] = [];
    for (const name of names) {
      const n = norm(name);
      const first = norm(name.split(/\s+/)[0] ?? "");
      const exact = pool.filter((p) => norm(p.full_name) === n);
      const byFirst = pool.filter((p) => norm(p.full_name.split(/\s+/)[0] ?? "") === first);
      const hit = exact.length === 1 ? exact[0] : byFirst.length === 1 ? byFirst[0] : null;
      if (hit) ids.push(hit.id);
      else unmatched.push(`${name} (${slot === "google_buyer" ? "Google buyer" : slot === "meta_buyer" ? "Meta buyer" : slot.replace("_", " ")})`);
    }
    if (!ids.length) continue;
    const { data: before } = slot === "meta_buyer" ? await admin.from("client_assignments").select("profile_id").eq("client_id", clientId).eq("role", slot) : { data: [] };
    // The form is the source of truth for this role on this client
    await admin.from("client_assignments").delete().eq("client_id", clientId).eq("role", slot).not("profile_id", "in", `(${ids.join(",")})`);
    await admin.from("client_assignments").upsert(ids.map((id) => ({ client_id: clientId, profile_id: id, role: slot })), { onConflict: "client_id,role,profile_id" });
    assigned[slot] = ids.map((id) => people!.find((p) => p.id === id)!.full_name).join(", ");
    // A new buyer: the account's work moves to them and they get a handoff
    if (slot === "meta_buyer" && !(before ?? []).some((b) => b.profile_id === ids[0])) {
      const { handOff, writeHandoff } = await import("@/lib/handoff");
      const id = await handOff(admin, clientId, (before?.[0]?.profile_id as string | undefined) ?? null, ids[0], null, "form");
      if (id) await writeHandoff(admin, id);
    }
  }
  return { assigned, unmatched };
}

/**
 * The client's own people named on the form (any question asking for an email that isn't a Kaizen address, with the
 * name asked next to it) become the client's contacts: who gets the portal link and approves ads. The first is primary.
 */
export async function applyContacts(admin: SupabaseClient, clientId: string, raw: Record<string, unknown>) {
  const entries = Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v == null ? "" : String(v)] as const);
  const added: string[] = [];
  for (const [q, v] of entries) {
    const emails = v.toLowerCase().match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? [];
    if (!emails.length || /kaizenmarketing\.agency/.test(v)) continue;
    // The name asked alongside it: "Contact Email" → "Contact Name", else a question about the point of contact
    const base = norm(q).replace(/email(address)?/, "");
    const nameQ = entries.find(([k]) => norm(k) !== norm(q) && /name/.test(norm(k)) && !/business|company|brand/.test(norm(k)) && (base ? norm(k).includes(base) : /contact|pointof|decision|owner/.test(norm(k))));
    for (const email of emails) {
      await admin.from("contacts").upsert({ email, full_name: emails.length === 1 ? (nameQ?.[1].trim() || null) : null, is_active: true }, { onConflict: "email", ignoreDuplicates: true });
      const { data: c } = await admin.from("contacts").select("id").eq("email", email).maybeSingle();
      if (!c) continue;
      const { count } = await admin.from("contact_clients").select("contact_id", { count: "exact", head: true }).eq("client_id", clientId);
      await admin.from("contact_clients").upsert({ contact_id: c.id, client_id: clientId, is_primary: !count }, { onConflict: "contact_id,client_id", ignoreDuplicates: true });
      added.push(email);
    }
  }
  return added;
}

/** Names on the form that aren't on the team in Kaizen Ads: execs hear about it so someone adds them or assigns by hand. */
export async function flagUnmatched(admin: SupabaseClient, clientId: string, unmatched: string[]) {
  if (!unmatched.length) return;
  const [{ data: c }, { data: execs }] = await Promise.all([admin.from("clients").select("name, slug").eq("id", clientId).single(), admin.from("profiles").select("id").eq("role", "executive").eq("is_active", true).not("joined_at", "is", null)]);
  await admin.from("notifications").upsert(
    (execs ?? []).map((e) => ({
      profile_id: e.id,
      kind: "client",
      title: `${c?.name ?? "A new client"}: ${unmatched.join(", ")} ${unmatched.length === 1 ? "isn't" : "aren't"} on the team`,
      body: "The onboarding form named them, but there's no one by that name in Kaizen Ads. Add them on the Team page, or assign the client's team by hand.",
      href: c?.slug ? `/clients/${c.slug}` : "/team",
      client_id: clientId,
      key: `form-team:${clientId}:${unmatched.join("|")}`.slice(0, 300),
      priority: "critical",
    })),
    { onConflict: "profile_id,key", ignoreDuplicates: true },
  );
}

const PACKAGE_SCHEMA = {
  type: "object",
  properties: {
    standard: { type: "string", description: "the set package's key when the text is exactly a set package with nothing added, else empty" },
    images: { type: "integer" },
    videos: { type: "integer" },
    summary: { type: "string" },
  },
  required: ["standard", "images", "videos", "summary"],
  additionalProperties: false,
};

/** Counts read straight from the text, for when the AI isn't available. */
function countsIn(text: string) {
  const num = (re: RegExp) => {
    const m = text.match(re);
    return m ? Number(m[1]) : null;
  };
  const videos = num(/(\d+)\s*(?:videos?|reels?|ugc)/i);
  const images = num(/(\d+)\s*(?:images?|statics?|graphics?|photos?|carousels?|creatives?|designs?)/i);
  return videos == null && images == null ? null : { images: images ?? 0, videos: videos ?? 0 };
}

/**
 * The form's package answer, understood. A plain set package ("Silver", "Gold Package") stays as it is. Anything else
 * ("3 Videos per Month", "Silver + 2 extra videos", "10 statics and a couple of reels") makes the client Custom with
 * exactly those deliverables as their monthly allotment, and what was agreed in the package note.
 */
export async function applyPackageText(admin: SupabaseClient, clientId: string, text: string | null, recognised: string | null) {
  const answer = text?.trim();
  if (!answer) return null;
  const { data: pkgs } = await admin.from("creative_packages").select("key, label, images, videos").neq("key", "custom").order("sort_order");
  const set = pkgs ?? [];
  // A set package named on its own (any numbers in it are that package's own counts) needs nothing more
  const known = set.find((p) => p.key === recognised);
  const extra = /\+|\bplus\b|extra|additional|add-?on|custom|instead|\bonly\b|\band\b|&/i.test(answer);
  const digits = (answer.match(/\d+/g) ?? []).map(Number);
  if (known && !extra && digits.every((d) => d === known.images || d === known.videos)) return null;

  let read: { images: number; videos: number; summary: string } | null = null;
  if (aiEnabled())
    try {
      const out = await askJson<{ standard: string; images: number; videos: number; summary: string }>({
        agent: "briefing",
        label: "package from a form",
        system: "You read what a paid social agency sold a client for creative, from one form answer, and turn it into monthly deliverables. Carousels count as images. Be literal: never invent deliverables the text doesn't support.",
        schema: PACKAGE_SCHEMA,
        prompt: `The agency's set packages (per month):
${set.map((p) => `- ${p.key} (${p.label}): ${p.images} images, ${p.videos} videos`).join("\n")}

The form answer: "${answer}"

standard: the set package's key if the answer is exactly one set package with nothing added or changed; otherwise "". images, videos: the monthly deliverables in total (a set package plus extras adds them up; "a couple" is 2, "a few" is 3). summary: one short line of what was agreed, e.g. "Silver plus 2 extra videos".`,
      });
      if (out.standard && set.some((p) => p.key === out.standard) && out.standard === recognised) return null;
      read = { images: Math.max(0, Math.min(999, out.images)), videos: Math.max(0, Math.min(999, out.videos)), summary: out.summary.trim() || answer };
    } catch {
      read = null;
    }
  if (!read) {
    const c = countsIn(answer);
    if (!c) return null;
    read = { ...c, summary: answer };
  }
  await admin.from("client_allotments").upsert({ client_id: clientId, images_per_month: read.images, videos_per_month: read.videos, updated_at: new Date().toISOString() }, { onConflict: "client_id" });
  await admin.from("clients").update({ creative_package: true, creative_package_key: "custom", creative_package_note: `Custom: ${read.summary}`.slice(0, 300) }).eq("id", clientId);
  return { images: read.images, videos: read.videos, summary: read.summary };
}

/**
 * The services ticked on the enrollment or upsell form become the client's services in Kaizen Ads straight away (a new
 * client isn't in Kaizen Track yet, so nothing else would bring them in). Added only: a form never takes one off, and
 * one ticked again comes back even if it had been removed here.
 */
export async function applyServices(admin: SupabaseClient, clientId: string, names: unknown, creatives?: boolean | null) {
  const list = (Array.isArray(names) ? names : typeof names === "string" ? names.split(/[,;\n]/) : []).map((s) => String(s).trim()).filter(Boolean);
  const slugs = new Set(list.map(serviceFromName).filter((s): s is NonNullable<typeof s> => Boolean(s)));
  if (creatives) slugs.add("creative");
  if (!slugs.size) return [];
  const { data: c } = await admin.from("clients").select("services_extra, services_removed").eq("id", clientId).maybeSingle();
  if (!c) return [];
  const extra = new Set([...((c.services_extra ?? []) as string[]), ...slugs]);
  const removed = ((c.services_removed ?? []) as string[]).filter((s) => !slugs.has(s as never));
  await admin.from("clients").update({ services_extra: [...extra], services_removed: removed }).eq("id", clientId);
  return [...slugs];
}
