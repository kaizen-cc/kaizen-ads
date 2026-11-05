import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { attachLoomToClient } from "@/lib/loom-intake";
import { matchProspect, sameProspect, type ClientRef, type ProspectRef } from "@/lib/prospect-match";

// Pre-sale audits: the senior buyer's Looms of a sales prospect's account. Their strategy is taught to the buyers when
// they're read; the prospect waits on the video. When the prospect becomes a client (enrolled from the form or Kaizen
// Track, matched with the Loom queue by name, website or ad account, or picked by hand) every Loom about them is filed
// to the new client as a pre-sale audit, and the go-to-market strategy starts from his read.

type Admin = SupabaseClient;

/** Our clients as a prospect is matched against them: name, website, every ad account */
async function clientRefs(admin: Admin, onlyId?: string): Promise<ClientRef[]> {
  let q = admin.from("clients").select("id, name, website, meta_ad_account_id, internal, archived_at");
  if (onlyId) q = q.eq("id", onlyId);
  else q = q.is("archived_at", null);
  const [{ data: cs }, { data: kpis }] = await Promise.all([q, admin.from("kpi_targets").select("client_id, ad_account_id").not("ad_account_id", "is", null)]);
  const accounts = new Map<string, string[]>();
  for (const k of kpis ?? []) accounts.set(k.client_id as string, [...(accounts.get(k.client_id as string) ?? []), String(k.ad_account_id)]);
  return (cs ?? [])
    .filter((c) => !c.internal)
    .map((c) => ({ id: c.id as string, name: c.name as string, website: (c.website as string | null) ?? null, accounts: [...((c.meta_ad_account_id as string | null) ? [c.meta_ad_account_id as string] : []), ...(accounts.get(c.id as string) ?? [])] }));
}

type ProspectRow = { id: string; prospect_name: string | null; prospect_domain: string | null; prospect_ad_account: string | null };
const refOf = (v: ProspectRow): ProspectRef => ({ name: v.prospect_name, domain: v.prospect_domain, adAccount: v.prospect_ad_account });

/**
 * Prospects that have become clients: every waiting prospect Loom (or just these videos, or just against this client)
 * matched by name, website or ad account; a prospect that fits exactly one client is attached to them.
 */
export async function attachProspectLooms(admin: Admin, opts: { clientId?: string; videoIds?: string[]; by?: string | null } = {}) {
  let q = admin.from("loom_videos").select("id, prospect_name, prospect_domain, prospect_ad_account").eq("prospect_status", "prospect").limit(2000);
  if (opts.videoIds?.length) q = q.in("id", opts.videoIds);
  const { data } = await q;
  const waiting = (data ?? []) as ProspectRow[];
  if (!waiting.length) return { attached: 0, clients: [] as string[] };
  const clients = await clientRefs(admin, opts.clientId);
  if (!clients.length) return { attached: 0, clients: [] as string[] };
  // Against every client so a prospect that fits two isn't guessed; against one new client, it only has to fit them
  const all = opts.clientId ? await clientRefs(admin) : clients;
  let attached = 0;
  const names = new Set<string>();
  for (const v of waiting) {
    const hit = matchProspect(refOf(v), all);
    if (!hit || !clients.some((c) => c.id === hit.id)) continue;
    await attachLoomToClient(admin, v.id, hit.id, opts.by ?? null);
    attached++;
    names.add(hit.name);
  }
  return { attached, clients: [...names] };
}

/** "This prospect became client X": this Loom and every other Loom about the same prospect, filed to them */
export async function prospectBecameClient(admin: Admin, videoId: string, clientId: string, by: string | null) {
  const { data: v } = await admin.from("loom_videos").select("id, prospect_name, prospect_domain, prospect_ad_account").eq("id", videoId).single();
  if (!v) throw new Error("Not found.");
  const { data: others } = await admin.from("loom_videos").select("id, prospect_name, prospect_domain, prospect_ad_account").eq("prospect_status", "prospect").neq("id", videoId).limit(2000);
  const same = ((others ?? []) as ProspectRow[]).filter((o) => sameProspect(refOf(v as ProspectRow), refOf(o)));
  for (const id of [videoId, ...same.map((o) => o.id)]) await attachLoomToClient(admin, id, clientId, by);
  return { attached: 1 + same.length };
}

/** A new client enrolled: their pre-sale Looms come with them (after the reply; never fails the enrollment) */
export async function attachForNewClient(admin: Admin, clientId: string) {
  return attachProspectLooms(admin, { clientId }).catch(() => ({ attached: 0, clients: [] as string[] }));
}

/**
 * What the go-to-market strategy reads first: the senior buyer's pre-sale audits of this account (his read, what he'd
 * do, the key points), for this platform. "" when there are none.
 */
export async function presaleAuditsBlock(admin: Admin, clientId: string, platform: "meta" | "google") {
  const { data } = await admin
    .from("loom_videos")
    .select("url, title, summary, platform, recorded_at, created_at, result")
    .eq("prospect_client_id", clientId)
    .order("recorded_at", { ascending: true, nullsFirst: false })
    .limit(12);
  const fits = (p: string | null) => !p || p === "none" || p === "both" || p === platform;
  const parts: string[] = [];
  let size = 0;
  for (const v of (data ?? []).filter((x) => fits(x.platform as string | null))) {
    const r = (v.result ?? {}) as { title?: string; filed?: { situation?: string; key_points?: string[]; lessons?: { rule: string; when: string }[]; cases?: string } };
    const f = r.filed ?? {};
    const date = String((v.recorded_at as string | null) ?? v.created_at).slice(0, 10);
    const p = v.platform === "google" ? "Google Ads" : v.platform === "both" ? "Meta and Google" : v.platform === "meta" ? "Meta" : "";
    const text = [
      `## "${r.title ?? v.title ?? "Pre-sale audit"}" (Loom ${date}${p ? `, ${p}` : ""}) ${v.url}`,
      (v.summary as string | null) ?? "",
      f.situation ? `His read of the account:\n${f.situation}` : "",
      f.cases ? f.cases.replace(/^# .*\n/, "") : "",
      f.lessons?.length ? `What he'd do:\n${f.lessons.map((l) => `- ${l.rule}${l.when ? ` (${l.when})` : ""}`).join("\n")}` : "",
      f.key_points?.length ? `Key points:\n${f.key_points.map((k) => `- ${k}`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 6000);
    if (size + text.length > 16000) break;
    parts.push(text);
    size += text.length;
  }
  if (!parts.length) return "";
  return `<senior_buyer_presale_audits note="Kaizen's senior buyer audited this account before the client signed, in Loom. Start from his read and his plan: build the strategy on them unless newer data (the intake, calls, the account today) clearly says otherwise, and say where it does.">\n${parts.join("\n\n")}\n</senior_buyer_presale_audits>`;
}
