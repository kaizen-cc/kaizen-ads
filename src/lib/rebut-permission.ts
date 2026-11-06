// Who may push back on an AI audit (rebut a finding, "Teach the agent this" in a Why chat, rule on a contradiction in
// the senior buyer's teachings): the people given the permission (profiles.can_rebut_audits), and the head of the
// platform the item is about. A Google item: the Head of Google too; a Meta item: the Head of Meta too; an item about
// both (or the whole business): either head. An item tied to no ad platform: only the permission. Pure, so the server
// actions and the pages that show the button use the same rule.

export type RebutPlatform = "meta" | "google" | "both" | null;
export type RebutProfile = { can_rebut_audits?: boolean | null; role?: string | null } | null | undefined;

/** Whether this person may rebut or teach on an item about this platform */
export function canRebut(p: RebutProfile, platform: RebutPlatform): boolean {
  if (!p) return false;
  if (p.can_rebut_audits) return true;
  if (platform === "google") return p.role === "head_of_google";
  if (platform === "meta") return p.role === "head_of_meta";
  if (platform === "both") return p.role === "head_of_google" || p.role === "head_of_meta";
  return false;
}

/** What one person may rebut, per platform (for a page that shows items about several) */
export const rebutRights = (p: RebutProfile) => ({ meta: canRebut(p, "meta"), google: canRebut(p, "google"), both: canRebut(p, "both"), none: canRebut(p, null) });
export type RebutRights = ReturnType<typeof rebutRights>;
export const NO_RIGHTS: RebutRights = { meta: false, google: false, both: false, none: false };
export const rightFor = (r: RebutRights, platform: RebutPlatform) => (platform === null ? r.none : r[platform]);

/** An ad platform as stored (kpi_targets.platform, a business audit channel, a buyer teaching's platform) */
export function platformOf(v: string | null | undefined): RebutPlatform {
  if (v === "google") return "google";
  if (v === "meta") return "meta";
  if (v === "both") return "both";
  return null;
}

/** A business audit item by its key: the channel of its cause or action; anything about the whole business is both */
export function businessItemPlatform(r: { causes?: { channel: string }[]; actions?: { channel: string }[] } | null | undefined, itemKey: string): RebutPlatform {
  const [kind, raw] = itemKey.split(":");
  const channel = kind === "channel" ? raw : kind === "cause" ? r?.causes?.[Number(raw)]?.channel : kind === "action" ? r?.actions?.[Number(raw)]?.channel : null;
  return channel === "google" || channel === "meta" ? channel : "both";
}

/** Who can teach it, in words, for someone who can't */
export function whoCanTeach(platform: RebutPlatform) {
  if (platform === "google") return "The Head of Google or someone with the audit pushback permission can teach it this.";
  if (platform === "meta") return "The Head of Meta or someone with the audit pushback permission can teach it this.";
  if (platform === "both") return "The Head of Meta, the Head of Google or someone with the audit pushback permission can teach it this.";
  return "Someone with the audit pushback permission can teach it this.";
}
