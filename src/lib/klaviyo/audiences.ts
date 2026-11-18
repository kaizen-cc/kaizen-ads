// Who a campaign was sent to. Klaviyo gives each campaign the ids of the lists and segments it went to and the ones it
// left out; the sync turns them into names (read once per account from its lists and segments) and stores them in
// klaviyo_campaigns.audiences_detail as { included: [{ id, name, type }], excluded: [...] }. Pure: no database, no network.
// (The older text[] column `audiences` keeps the included names, which the client page's campaign rows read.)

export type AudienceRef = { id: string; name: string; type: "list" | "segment" };
export type CampaignAudiences = { included: AudienceRef[]; excluded: AudienceRef[] };

/** What the account's lists and segments are called, by id */
export type AudienceLookup = Map<string, { name: string; type: "list" | "segment" }>;

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x ?? "").trim()).filter(Boolean) : []);

/** The included and excluded ids on a Klaviyo campaign's `attributes.audiences` */
export function parseAudienceIds(audiences: unknown): { included: string[]; excluded: string[] } {
  const a = obj(audiences);
  return { included: [...new Set(ids(a.included))], excluded: [...new Set(ids(a.excluded))] };
}

/**
 * The stored shape for a campaign's ids. An id the account no longer has (a list deleted in Klaviyo) is left out: a name
 * is never guessed.
 */
export function audienceSets(idsOf: { included: string[]; excluded: string[] }, lookup: AudienceLookup): CampaignAudiences {
  const refs = (list: string[]): AudienceRef[] =>
    list.flatMap((id) => {
      const got = lookup.get(id);
      return got && got.name.trim() ? [{ id, name: got.name.trim(), type: got.type }] : [];
    });
  return { included: refs(idsOf.included), excluded: refs(idsOf.excluded) };
}

const refOf = (v: unknown): AudienceRef | null => {
  const x = obj(v);
  const id = typeof x.id === "string" ? x.id : "";
  const name = typeof x.name === "string" ? x.name.trim() : "";
  if (!id || !name) return null;
  return { id, name, type: x.type === "segment" ? "segment" : "list" };
};

/** A stored value read back (null when it isn't the shape, or names no audience at all) */
export function parseAudiencesJson(value: unknown): CampaignAudiences | null {
  const v = obj(value);
  const read = (x: unknown) => (Array.isArray(x) ? x.map(refOf).filter((r): r is AudienceRef => r != null) : []);
  const out = { included: read(v.included), excluded: read(v.excluded) };
  return out.included.length || out.excluded.length ? out : null;
}

/** A campaign's audiences as short report lines: who it went to and who was left out, names only, a few then "+N more" */
export function audienceLines(a: CampaignAudiences | null | undefined, show = 3): { sent: string | null; excluded: string | null } {
  if (!a) return { sent: null, excluded: null };
  const names = (list: AudienceRef[]) => {
    if (!list.length) return null;
    const shown = list.slice(0, show).map((r) => r.name);
    return list.length > show ? `${shown.join(", ")} +${list.length - show} more` : shown.join(", ");
  };
  return { sent: names(a.included), excluded: names(a.excluded) };
}
