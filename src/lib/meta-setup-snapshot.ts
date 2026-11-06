import "server-only";
import { metaGraph, type AccountSetup } from "@/lib/context/meta";
import { coverageLines, type SetupFact, type SetupFacts } from "@/lib/setup-check";

// What's already set up in a Meta ad account, beyond the campaign and ad set lines the audit reads: which custom
// audiences each live ad set includes and excludes, by kind (customer list, website, engagement, lookalike) with their
// size, Advantage+ audience and placements, the attribution setting, and the dataset's events, browser and server
// (Conversions API). Read before an audit (and each sprint check) so it never recommends what's already there.
// Parts Meta refuses are said so, never assumed missing. Read only.

type Kind = "customer list" | "website" | "engagement" | "lookalike" | "app" | "offline" | "other";
type Audience = { id: string; name: string; kind: Kind; size: number | null; status: string; retention: number | null; lookalikeOf: string | null };

export type MetaSnapshot = { text: string; facts: SetupFacts; unread: string[] };

export function audienceKind(subtype: string): Kind {
  const s = subtype.toUpperCase();
  if (s === "CUSTOM") return "customer list";
  if (s === "WEBSITE") return "website";
  if (s === "LOOKALIKE") return "lookalike";
  if (s === "APP") return "app";
  if (["OFFLINE_CONVERSION", "DATA_SET"].includes(s)) return "offline";
  if (["ENGAGEMENT", "IG_BUSINESS", "VIDEO", "LEAD_AD", "PAGE", "FB_EVENT", "INSTANT_ARTICLE", "SHOPPING", "MESSENGER"].includes(s)) return "engagement";
  return "other";
}

const k = (n: number | null) => (n == null ? "?" : n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));
const LIVE = (s: string) => s === "ACTIVE" || s === "IN_PROCESS" || s === "WITH_ISSUES";

/** The account's audiences and dataset events, with the live ad sets' setup, as a block and the facts a plan is checked against */
export async function metaSetupSnapshot(adAccountId: string, setup: AccountSetup | null): Promise<MetaSnapshot> {
  const act = `act_${adAccountId.replace(/^act_/, "")}`;
  const unread: string[] = [];
  type CA = { id: string; name: string; subtype?: string; approximate_count_lower_bound?: number; approximate_count_upper_bound?: number; delivery_status?: { code?: number; description?: string }; operation_status?: { code?: number; description?: string }; retention_days?: number; lookalike_spec?: { origin?: { name?: string }[]; ratio?: number } };
  const [cas, pixels] = await Promise.all([
    metaGraph<{ data: CA[] }>(`${act}/customaudiences`, { fields: "name,subtype,approximate_count_lower_bound,approximate_count_upper_bound,delivery_status,operation_status,retention_days,lookalike_spec", limit: "300" }).catch((e) => {
      unread.push(`custom audiences (${e instanceof Error ? e.message.slice(0, 120) : "refused"})`);
      return null;
    }),
    metaGraph<{ data: { id: string; name: string; last_fired_time?: string; enable_automatic_matching?: boolean }[] }>(`${act}/adspixels`, { fields: "name,last_fired_time,enable_automatic_matching", limit: "20" }).catch(() => null),
  ]);
  const audiences = new Map<string, Audience>(
    (cas?.data ?? []).map((a) => [
      a.id,
      {
        id: a.id,
        name: a.name,
        kind: audienceKind(a.subtype ?? ""),
        size: a.approximate_count_lower_bound != null && a.approximate_count_lower_bound >= 0 ? a.approximate_count_lower_bound : null,
        status: a.delivery_status?.code && a.delivery_status.code !== 200 ? (a.delivery_status.description ?? "not ready") : "ready",
        retention: a.retention_days ?? null,
        lookalikeOf: a.lookalike_spec?.origin?.map((x) => x.name).filter(Boolean).join(", ") || null,
      },
    ]),
  );

  // The datasets the ad sets optimize on (or the account's own), their events in the last 7 days, browser and server
  const used = new Set((setup?.adsets ?? []).map((a) => a.pixel).filter(Boolean) as string[]);
  const datasets = (pixels?.data ?? []).filter((p) => !used.size || used.has(p.id)).slice(0, 3);
  const since = String(Math.floor((Date.now() - 7 * 86_400_000) / 1000));
  type Stats = { data?: { data?: { value: string; count: number }[] }[] };
  const sum = (s: Stats | null) => {
    const m = new Map<string, number>();
    for (const b of s?.data ?? []) for (const d of b.data ?? []) m.set(d.value, (m.get(d.value) ?? 0) + (Number(d.count) || 0));
    return m;
  };
  const events = await Promise.all(
    datasets.map(async (p) => {
      const [byEvent, bySource] = await Promise.all([
        metaGraph<Stats>(`${p.id}/stats`, { aggregation: "event", start_time: since }).catch(() => null),
        metaGraph<Stats>(`${p.id}/stats`, { aggregation: "event_source", start_time: since }).catch(() => null),
      ]);
      const src = sum(bySource);
      const server = [...src].filter(([v]) => /server|api|capi/i.test(v)).reduce((t, [, n]) => t + n, 0);
      const total = [...src.values()].reduce((t, n) => t + n, 0);
      return { name: p.name, matching: p.enable_automatic_matching ?? null, events: [...sum(byEvent)].sort((a, b) => b[1] - a[1]), server: bySource ? server : null, total };
    }),
  );
  const capiSeen = events.some((e) => (e.server ?? 0) > 0);
  const capiKnown = events.some((e) => e.server != null);

  // ─── Facts, per live ad set ───
  const camp = new Map((setup?.campaigns ?? []).map((c) => [c.id, c.name]));
  const live = (setup?.adsets ?? []).filter((a) => LIVE(a.status));
  const names = live.map((a) => a.name);
  const parents = Object.fromEntries(live.map((a) => [a.name, camp.get(a.campaignId) ?? ""]));
  const kindsIn = (ids: string[] | undefined) => (ids ?? []).map((id) => audiences.get(id)).filter((x): x is Audience => Boolean(x));
  const includes = (kind: Kind) => live.filter((a) => kindsIn(a.audience?.customIds).some((x) => x.kind === kind)).map((a) => a.name);
  const facts: SetupFact[] = [];
  if (setup && cas) {
    facts.push({ key: "customer_list", label: "Customer list audience (included)", unit: "live ad sets", of: names, on: includes("customer list"), parents });
    facts.push({ key: "lookalike", label: "Lookalike audience (included)", unit: "live ad sets", of: names, on: includes("lookalike"), parents });
    facts.push({ key: "website_audience", label: "Website audience (included)", unit: "live ad sets", of: names, on: includes("website"), parents });
    facts.push({ key: "engagement_audience", label: "Engagement audience (included)", unit: "live ad sets", of: names, on: includes("engagement"), parents });
    facts.push({
      key: "exclude_customers",
      label: "Customers or purchasers excluded",
      unit: "live ad sets",
      of: names,
      on: live.filter((a) => kindsIn(a.audience?.excludedIds).some((x) => x.kind === "customer list" || /purchas|customer|buyer|client/i.test(x.name))).map((a) => a.name),
      parents,
    });
  }
  if (setup) {
    facts.push({ key: "advantage_audience", label: "Advantage+ audience", unit: "live ad sets", of: names, on: live.filter((a) => a.audience?.advantage).map((a) => a.name), parents });
    facts.push({ key: "advantage_placements", label: "Advantage+ (automatic) placements", unit: "live ad sets", of: names, on: live.filter((a) => a.audience?.placements === "automatic").map((a) => a.name), parents });
  }
  if (capiSeen) facts.push({ key: "capi", label: "Conversions API (server events)", of: ["the account"], on: ["the account"] });

  // ─── The block ───
  const L: string[] = [];
  L.push("SETUP SNAPSHOT (what's already in place: check here before recommending any setup change)");
  L.push(`\nLIVE AD SETS: audiences in use, Advantage+, placements, attribution (${live.length} live${setup ? `, ${(setup.adsets ?? []).length - live.length} paused` : ""})`);
  const aud = (x: Audience) => `${x.kind} "${x.name}"${x.size != null ? ` (~${k(x.size)})` : ""}`;
  for (const a of live) {
    const au = a.audience;
    const inc = kindsIn(au?.customIds);
    const exc = kindsIn(au?.excludedIds);
    // Names Meta gave without a match in the account's list (shared from another account): by name only
    const incNames = inc.length ? inc.map(aud) : (au?.custom ?? []).map((n) => `"${n}"`);
    const excNames = exc.length ? exc.map(aud) : (au?.excluded ?? []).map((n) => `"${n}"`);
    const placements = !au ? "?" : au.placements === "automatic" ? "Advantage+ (automatic)" : `manual: ${au.positions.length ? au.positions.slice(0, 10).join(", ") : au.placements}`;
    L.push(
      `- ${camp.get(a.campaignId) ?? "?"} › ${a.name}: includes ${incNames.join(", ") || "no custom audiences"}; excludes ${excNames.join(", ") || "nothing"}; Advantage+ audience ${au?.advantage ? "on" : "off"}${au?.interests.length ? `; interests ${au.interests.slice(0, 5).join(", ")}` : ""}; placements ${placements}; attribution ${a.attribution ?? "?"}`,
    );
  }
  if (facts.length) {
    L.push("\nCOVERAGE (where it's in place out of the live ad sets)");
    L.push(...coverageLines({ platform: "meta", facts }));
  }
  if (cas) {
    const inUse = new Set(live.flatMap((a) => [...(a.audience?.customIds ?? []), ...(a.audience?.excludedIds ?? [])]));
    L.push(`\nCUSTOM AUDIENCES IN THE ACCOUNT (${audiences.size})`);
    for (const kind of ["customer list", "website", "engagement", "lookalike", "app", "offline", "other"] as Kind[]) {
      const list = [...audiences.values()].filter((x) => x.kind === kind);
      if (!list.length) continue;
      L.push(
        `- ${kind} (${list.length}): ${list
          .slice(0, 8)
          .map((x) => `"${x.name}" (~${k(x.size)}${x.retention ? `, ${x.retention}d` : ""}${x.lookalikeOf ? `, of ${x.lookalikeOf}` : ""}${x.status !== "ready" ? `, ${x.status}` : ""}${inUse.has(x.id) ? ", in use" : ""})`)
          .join("; ")}${list.length > 8 ? `; +${list.length - 8} more` : ""}`,
      );
    }
  }
  L.push("\nDATASET EVENTS, last 7 days");
  if (!events.length) L.push("- No dataset found on this account");
  for (const e of events)
    L.push(
      `- ${e.name}: ${e.events.slice(0, 10).map(([n, c]) => `${n} ${c}`).join(", ") || "no events"}${e.server == null ? "; server (Conversions API) events: couldn't tell" : `; server (Conversions API) events: ${e.server ? `${e.server} of ${e.total}` : "none seen"}`}${e.matching != null ? `; automatic advanced matching ${e.matching ? "on" : "off"}` : ""}`,
    );
  if (!capiKnown && events.length) unread.push("Conversions API events (Meta didn't split events by source)");
  if (unread.length) L.push(`\nCOULDN'T READ (don't assume these are missing): ${unread.join("; ")}`);
  return { text: L.join("\n"), facts: { platform: "meta", facts }, unread };
}
