import type { SupabaseClient } from "@supabase/supabase-js";

// What the system needs to run a client end to end, checked when they go live again (restored, back from paused,
// active again in Kaizen Track). Each check says what stops working without it, so whoever brought them back can fill
// the gaps on the spot. "needed" ones stop a part of the cycle (KPIs, reports, check-ins); "helps" ones thin it out.

export type CheckKey = "account" | "target" | "meta_buyer" | "google_buyer" | "contact" | "slack" | "internal_slack" | "drive" | "website";
export type Check = { key: CheckKey; label: string; ok: boolean; need: "needed" | "helps"; why: string; detail?: string };
export type ReadinessTarget = { id: string; platform: string; label: string | null; target: number | null };
export type Readiness = { checks: Check[]; targets: ReadinessTarget[]; ready: boolean; missing: number };

export async function clientReadiness(db: SupabaseClient, clientId: string): Promise<Readiness> {
  const [{ data: c }, { data: rows }, { data: team }, { count: contacts }] = await Promise.all([
    db.from("clients").select("meta_ad_account_id, slack_channel_id, internal_slack_channel_id, drive_folder_id, website").eq("id", clientId).maybeSingle(),
    db.from("kpi_targets").select("id, platform, label, ad_account_id, target").eq("client_id", clientId).eq("active", true),
    db.from("client_assignments").select("role").eq("client_id", clientId).in("role", ["meta_buyer", "google_buyer"]),
    db.from("contact_clients").select("contact_id", { count: "exact", head: true }).eq("client_id", clientId),
  ]);
  const targets = (rows ?? []).map((r) => ({ id: r.id as string, platform: r.platform as string, label: (r.label as string | null) ?? null, target: r.target == null ? null : Number(r.target), account: r.ad_account_id as string | null }));
  const hasMeta = Boolean(c?.meta_ad_account_id) || targets.some((t) => t.platform === "meta" && t.account);
  const hasGoogle = targets.some((t) => t.platform === "google" && t.account);
  const roles = new Set((team ?? []).map((t) => t.role as string));
  const noTarget = targets.filter((t) => t.account && t.target == null);
  const name = (t: (typeof targets)[number]) => `${t.platform === "google" ? "Google" : "Meta"}${t.label ? ` · ${t.label}` : ""}`;

  const checks: Check[] = [
    { key: "account", label: "An ad account", ok: hasMeta || hasGoogle, need: "needed", why: "Without one there's nothing to pull: no KPI board row, no reports, no fatigue watch, no audits." },
    {
      key: "target",
      label: "A KPI target",
      ok: (hasMeta || hasGoogle) && noTarget.length === 0,
      need: "needed",
      why: "The target is what on or off track is measured against, on the board, in alerts and in every report.",
      detail: noTarget.length ? `Missing on ${noTarget.map(name).join(", ")}` : undefined,
    },
    ...(hasMeta || !hasGoogle ? [{ key: "meta_buyer" as const, label: "A Meta buyer", ok: roles.has("meta_buyer"), need: "needed" as const, why: "The buyer owns the Meta account: its reports are drafted in their voice and posted as them, and check-ins go to them." }] : []),
    ...(hasGoogle ? [{ key: "google_buyer" as const, label: "A Google buyer", ok: roles.has("google_buyer"), need: "needed" as const, why: "The buyer owns the Google account: its reports and check-ins go to them." }] : []),
    { key: "contact", label: "A client contact", ok: (contacts ?? 0) > 0, need: "needed", why: "The monthly recap is emailed to the client's contacts, and they're who signs in to the portal to approve ads." },
    { key: "slack", label: "Client Slack channel", ok: Boolean(c?.slack_channel_id), need: "helps", why: "Reports are posted there, and what the client says feeds the briefing." },
    { key: "internal_slack", label: "Internal Slack channel", ok: Boolean(c?.internal_slack_channel_id), need: "helps", why: "The team's talk about the client feeds the briefing and the AI." },
    { key: "drive", label: "Drive folder", ok: Boolean(c?.drive_folder_id), need: "helps", why: "Their photos, videos and brand files, which the shot list and creative ideas draw from." },
    { key: "website", label: "Website", ok: Boolean(c?.website), need: "helps", why: "Used for the Brand Bible, their industry and the market watch." },
  ];
  const missing = checks.filter((k) => !k.ok && k.need === "needed").length;
  return { checks, targets: targets.filter((t) => t.account).map(({ id, platform, label, target }) => ({ id, platform, label, target })), ready: missing === 0, missing };
}
