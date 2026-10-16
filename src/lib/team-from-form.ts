import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// The enrollment and upsell forms name the client's team (media buyer, designer, video editor, copywriter, customer
// success). Those names become the client's assignments here, which is what decides who sees the client: a media
// buyer's board, KPIs and Home show only the clients they're assigned to.

type Slot = "meta_buyer" | "graphic_designer" | "video_editor" | "copywriter" | "coordinator";

// Which form question is which role (matched on the question's words, so the form's own titles work)
const QUESTION: [Slot, RegExp][] = [
  ["video_editor", /videoeditor|editor/],
  ["graphic_designer", /graphicdesigner|designer/],
  ["copywriter", /copywriter/],
  ["coordinator", /customersuccess|accountmanager|csm|coordinator/],
  ["meta_buyer", /mediabuyer|metabuyer|buyer|adsmanager/],
];
// Who can hold each role
const ELIGIBLE: Record<Slot, string[]> = {
  meta_buyer: ["media_buyer", "head_of_meta"],
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
      else unmatched.push(`${name} (${slot.replace("_", " ")})`);
    }
    if (!ids.length) continue;
    // The form is the source of truth for this role on this client
    await admin.from("client_assignments").delete().eq("client_id", clientId).eq("role", slot).not("profile_id", "in", `(${ids.join(",")})`);
    await admin.from("client_assignments").upsert(ids.map((id) => ({ client_id: clientId, profile_id: id, role: slot })), { onConflict: "client_id,role,profile_id" });
    assigned[slot] = ids.map((id) => people!.find((p) => p.id === id)!.full_name).join(", ");
    // The KPI board follows the buyer: their account targets move with them
    if (slot === "meta_buyer") await admin.from("kpi_targets").update({ owner_id: ids[0] }).eq("client_id", clientId).eq("platform", "meta");
  }
  return { assigned, unmatched };
}

/**
 * A package the form gave as counts instead of a name ("3 Videos per Month", "10 statics + 2 videos"): the client's
 * creative is switched on with exactly that allotment.
 */
export async function applyCustomPackage(admin: SupabaseClient, clientId: string, text: string) {
  const num = (re: RegExp) => {
    const m = text.match(re);
    return m ? Number(m[1]) : null;
  };
  const videos = num(/(\d+)\s*(?:videos?|reels?|ugc)/i);
  const images = num(/(\d+)\s*(?:images?|statics?|graphics?|photos?|carousels?|creatives?|designs?)/i);
  if (videos == null && images == null) return null;
  await admin.from("client_allotments").upsert({ client_id: clientId, images_per_month: images ?? 0, videos_per_month: videos ?? 0, updated_at: new Date().toISOString() }, { onConflict: "client_id" });
  await admin.from("clients").update({ creative_package: true, creative_package_key: null }).eq("id", clientId);
  return { images: images ?? 0, videos: videos ?? 0 };
}
