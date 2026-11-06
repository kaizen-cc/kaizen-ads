// Which campaigns a KPI target counts: only campaigns whose name contains its "Only campaigns containing" text, and
// never the campaigns left out of it (ones the client runs themselves). Every read of a target's campaigns, ad sets or
// ads (the numbers, the audit, its creative analysis and its recommendations) goes through this one rule.

export type KpiScope = { campaign_match?: string | null; excluded_campaigns?: string[] | null };

/** Whether a campaign (by its id and name) counts toward the target */
export function inScope(scope: KpiScope | null | undefined, campaign: { id?: string | null; name?: string | null }) {
  if (!scope) return true;
  const match = scope.campaign_match?.trim().toLowerCase();
  if (match && !(campaign.name ?? "").toLowerCase().includes(match)) return false;
  if (campaign.id != null && (scope.excluded_campaigns ?? []).includes(String(campaign.id))) return false;
  return true;
}

/** Rows (one per campaign, ad set or ad per day) kept to the target's campaigns */
export function scopeRows<T extends { campaign_id?: string | null; campaign_name?: string | null }>(rows: T[], scope: KpiScope | null | undefined): T[] {
  if (!scope?.campaign_match?.trim() && !(scope?.excluded_campaigns ?? []).length) return rows;
  return rows.filter((r) => inScope(scope, { id: r.campaign_id ?? null, name: r.campaign_name ?? null }));
}

/** The rule in words, for an AI that reads the account ("" when every campaign counts) */
export function scopeText(scope: KpiScope | null | undefined, leftOutNames: string[] = []) {
  const parts: string[] = [];
  if (scope?.campaign_match?.trim()) parts.push(`Only campaigns containing "${scope.campaign_match.trim()}" count toward this KPI.`);
  if ((scope?.excluded_campaigns ?? []).length)
    parts.push(
      `${scope!.excluded_campaigns!.length} ${scope!.excluded_campaigns!.length === 1 ? "campaign is" : "campaigns are"} left out (run by the client, not ours to fix)${leftOutNames.length ? `: ${leftOutNames.slice(0, 12).join("; ")}` : ""}. Leave them out of the numbers, the creative read and every recommendation.`,
    );
  return parts.join(" ");
}
