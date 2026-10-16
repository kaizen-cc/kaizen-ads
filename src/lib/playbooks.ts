import "server-only";
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { LIVE } from "@/lib/live";
import type { Benchmark } from "@/lib/verticals";

// The playbook for each sub-vertical: who buys (avatars, from our clients' go-to-market strategies and intake forms),
// the angles that land with each (from our Hall of Fame and the market's ads live 30+ days), and the proof. Rebuilt
// when what it's made from changes. Never names a client or a brand, so it can be shared for sales as it is.

export type PlaybookAngle = { name: string; hook: string; why: string; examples: { kind: "fame" | "market"; id: string }[] };
export type Avatar = { name: string; who: string; pains: string[]; triggers: string[]; objections: string[]; angles: PlaybookAngle[] };
export type Playbook = { verticalId: string; summary: string; avatars: Avatar[]; watchouts: string[]; sources: { clients: number; fame: number; market: number }; shareToken: string | null; generatedAt: string | null };

const SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    avatars: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          who: { type: "string" },
          pains: { type: "array", items: { type: "string" } },
          triggers: { type: "array", items: { type: "string" } },
          objections: { type: "array", items: { type: "string" } },
          angles: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" }, hook: { type: "string" }, why: { type: "string" }, examples: { type: "array", items: { type: "string" } } },
              required: ["name", "hook", "why", "examples"],
              additionalProperties: false,
            },
          },
        },
        required: ["name", "who", "pains", "triggers", "objections", "angles"],
        additionalProperties: false,
      },
    },
    watchouts: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "avatars", "watchouts"],
  additionalProperties: false,
};

const SYSTEM = `You are Kaizen's head of strategy writing the playbook for one sub-vertical: the go-to-market attack for any new client in it. It's read by the media buyers and the creative team, and shown to prospects in sales meetings.
Structure it the way creative should be reverse-engineered: first who buys (avatars), then the angles that land with each avatar, then the proof (real ads).
avatars: 2 to 4 distinct buyers, built from the clients' strategies and intake forms. name: a short handle ("The Weekend Warrior Dad"); who: one or two sentences; pains, triggers (what makes them act now) and objections: short lines in the customer's language.
angles: for each avatar, 2 to 4 angles proven by the examples: name, hook (a line that opens the ad), why it works for that avatar, and examples: the ids of the ads that prove it (F = our Hall of Fame, M = the market). Only angles the examples actually show; every angle needs at least one example.
summary: three or four sentences on how to win this sub-vertical on Meta right now, with the benchmarks.
watchouts: what doesn't work or to avoid (from the strategies, the flops implied, ad policy for the category).
Never name a client, a brand or a person, anywhere: describe them ("a Texas roofing company"). No em dashes.`;

type FameRow = { ad_id: string; creative: { headline?: string; text?: string } | null; value: number; target: number; roas: boolean; conversion: string; beat_by: number; days_live: number };
type MarketRow = { id: string; headline: string | null; body: string | null; angle: string | null; hook: string | null; why: string | null; days_active: number | null; format: string | null };

/** Builds (or rebuilds) one sub-vertical's playbook. */
export async function buildPlaybook(admin: SupabaseClient, subId: string) {
  const { data: sub } = await admin.from("verticals").select("id, name, description, conversion, benchmarks, parent_id, verticals!verticals_parent_id_fkey(name)").eq("id", subId).single();
  if (!sub) return null;
  const { data: clients } = await admin.from("clients").select("id, industry_detail").eq("vertical_id", subId).is("archived_at", null).in("status", LIVE);
  const ids = (clients ?? []).map((c) => c.id as string);
  const [{ data: gtm }, { data: intakes }, { data: fame }, { data: brands }] = await Promise.all([
    ids.length ? admin.from("client_gtm_strategies").select("client_id, markdown, read_this_first").in("client_id", ids) : Promise.resolve({ data: [] }),
    ids.length ? admin.from("client_intakes").select("client_id, summary").in("client_id", ids).not("summary", "is", null) : Promise.resolve({ data: [] }),
    admin.from("hall_of_fame").select("ad_id, creative, value, target, roas, conversion, beat_by, days_live").eq("vertical_id", subId).gt("expires_at", new Date().toISOString()).order("beat_by", { ascending: false }).limit(25),
    admin.from("market_brands").select("id").eq("vertical_id", subId).eq("rejected", false),
  ]);
  const brandIds = (brands ?? []).map((b) => b.id as string);
  const { data: market } = brandIds.length
    ? await admin.from("market_ads").select("id, headline, body, angle, hook, why, days_active, format").in("brand_id", brandIds).gte("days_active", 30).neq("active", false).order("days_active", { ascending: false }).limit(30)
    : { data: [] };
  const f = (fame ?? []) as unknown as FameRow[];
  const m = (market ?? []) as MarketRow[];
  if (!f.length && !m.length && !ids.length) return null;

  // Who buys: the ICP part of each client's strategy (or the summary), and their intake audience
  const icp = (gtm ?? [])
    .map((g) => {
      const md = String(g.markdown ?? "");
      const at = md.search(/ideal customer profile/i);
      return (at >= 0 ? md.slice(at, at + 2200) : String(g.read_this_first ?? "")).trim();
    })
    .filter(Boolean)
    .slice(0, 8);
  const audiences = (intakes ?? []).map((i) => (i.summary as { audience?: string; offer?: string }).audience).filter(Boolean).slice(0, 10);
  const parent = (sub.verticals as unknown as { name: string } | null)?.name ?? "";
  const bm = ((sub.benchmarks ?? []) as Benchmark[]).map((b) => `${b.metric}: good ${b.good ?? "?"}${b.unit}, great ${b.great ?? "?"}${b.unit} (${b.year})`).join("; ");

  const out = await askJson<{ summary: string; avatars: (Omit<Avatar, "angles"> & { angles: (Omit<PlaybookAngle, "examples"> & { examples: string[] })[] })[]; watchouts: string[] }>({
    agent: "verticals",
    label: `playbook ${sub.name}`,
    system: SYSTEM,
    schema: SCHEMA,
    prompt: `Sub-vertical: ${sub.name} (${parent}). ${sub.description ?? ""} A result is a ${sub.conversion ?? "conversion"}.
Benchmarks: ${bm || "not researched yet"}

<who_buys source="our clients' go-to-market strategies">
${icp.join("\n---\n") || "(no strategies yet)"}
</who_buys>
<audiences source="intake forms">
${audiences.join("\n") || "(none)"}
</audiences>

<our_hall_of_fame>
${f.map((a, i) => `F${i + 1}. ${a.roas ? `${Number(a.value).toFixed(2)}x ROAS vs ${a.target}x` : `$${Number(a.value).toFixed(2)} vs $${a.target} target per ${a.conversion}`} over ${a.days_live} days · "${a.creative?.headline ?? ""}" ${(a.creative?.text ?? "").slice(0, 300)}`).join("\n") || "(none yet)"}
</our_hall_of_fame>

<market_ads_live_30_plus_days>
${m.map((a, i) => `M${i + 1}. ${a.format ?? "ad"}, live ${a.days_active} days · angle: ${a.angle ?? "?"} · hook: ${a.hook ?? "?"} · why: ${a.why ?? "?"} · "${a.headline ?? ""}" ${(a.body ?? "").slice(0, 200)}`).join("\n") || "(none yet)"}
</market_ads_live_30_plus_days>`,
  });

  const ref = (r: string) => {
    const n = Number(r.slice(1)) - 1;
    if (r.startsWith("F") && f[n]) return { kind: "fame" as const, id: f[n].ad_id };
    if (r.startsWith("M") && m[n]) return { kind: "market" as const, id: m[n].id };
    return null;
  };
  const avatars: Avatar[] = out.avatars.map((a) => ({
    ...a,
    angles: a.angles.map((g) => ({ ...g, examples: g.examples.map(ref).filter((x): x is NonNullable<typeof x> => Boolean(x)) })).filter((g) => g.examples.length),
  }));
  const clean = (s: string) => s.replace(/\s*—\s*/g, ", ");
  const row = {
    vertical_id: subId,
    summary: clean(out.summary),
    avatars: JSON.parse(clean(JSON.stringify(avatars))),
    watchouts: out.watchouts.map(clean),
    sources: { clients: ids.length, fame: f.length, market: m.length },
    generated_at: new Date().toISOString(),
    fingerprint: fingerprintOf(ids, f.map((x) => x.ad_id), m.map((x) => x.id)),
  };
  await admin.from("vertical_playbooks").upsert(row, { onConflict: "vertical_id" });
  return row;
}

const fingerprintOf = (clients: string[], fame: string[], market: string[]) => `${clients.length}:${[...fame].sort().slice(0, 10).join(",")}:${[...market].sort().slice(0, 10).join(",")}`;

/** Sub-verticals whose playbook is missing, or a day old with something new to read, a couple per run. */
export async function keepPlaybooks(admin: SupabaseClient, max = 2) {
  const { data: subs } = await admin.from("verticals").select("id").not("parent_id", "is", null).eq("active", true);
  const { data: have } = await admin.from("vertical_playbooks").select("vertical_id, generated_at, fingerprint");
  const by = new Map((have ?? []).map((h) => [h.vertical_id as string, h]));
  let built = 0;
  for (const s of subs ?? []) {
    if (built >= max) break;
    const h = by.get(s.id as string);
    if (h?.generated_at && Date.now() - Date.parse(h.generated_at) < 24 * 3_600_000) continue;
    if (h) {
      // Only when there's something new to read
      const [{ data: clients }, { data: fame }] = await Promise.all([
        admin.from("clients").select("id").eq("vertical_id", s.id).is("archived_at", null).in("status", LIVE),
        admin.from("hall_of_fame").select("ad_id").eq("vertical_id", s.id).gt("expires_at", new Date().toISOString()),
      ]);
      const { data: brands } = await admin.from("market_brands").select("id").eq("vertical_id", s.id);
      const { data: market } = (brands ?? []).length
        ? await admin.from("market_ads").select("id").in("brand_id", (brands ?? []).map((b) => b.id)).gte("days_active", 30).neq("active", false).order("days_active", { ascending: false }).limit(30)
        : { data: [] };
      if (fingerprintOf((clients ?? []).map((c) => c.id), (fame ?? []).map((x) => x.ad_id), (market ?? []).map((x) => x.id)) === h.fingerprint) continue;
    }
    if (await buildPlaybook(admin, s.id as string).catch(() => null)) built++;
  }
  return built;
}

export async function loadPlaybook(db: SupabaseClient, subId: string): Promise<Playbook | null> {
  const { data } = await db.from("vertical_playbooks").select("*").eq("vertical_id", subId).maybeSingle();
  if (!data) return null;
  return {
    verticalId: data.vertical_id,
    summary: data.summary,
    avatars: (data.avatars ?? []) as Avatar[],
    watchouts: (data.watchouts ?? []) as string[],
    sources: (data.sources ?? { clients: 0, fame: 0, market: 0 }) as Playbook["sources"],
    shareToken: data.share_token,
    generatedAt: data.generated_at,
  };
}

/** A share link for sales: the playbook with no client or brand names. */
export async function shareToken(admin: SupabaseClient, subId: string) {
  const { data } = await admin.from("vertical_playbooks").select("share_token").eq("vertical_id", subId).maybeSingle();
  if (data?.share_token) return data.share_token as string;
  const token = randomBytes(12).toString("base64url");
  await admin.from("vertical_playbooks").update({ share_token: token }).eq("vertical_id", subId);
  return token;
}

/** The examples a playbook points to, for showing: our ads (with how they did) and market ads. */
export async function playbookExamples(db: SupabaseClient, p: Playbook) {
  const refs = p.avatars.flatMap((a) => a.angles.flatMap((g) => g.examples));
  const fameIds = [...new Set(refs.filter((r) => r.kind === "fame").map((r) => r.id))];
  const marketIds = [...new Set(refs.filter((r) => r.kind === "market").map((r) => r.id))];
  const [{ data: fame }, { data: market }] = await Promise.all([
    fameIds.length ? db.from("hall_of_fame").select("ad_id, creative, value, target, roas, conversion, days_live, clients(name, slug)").in("ad_id", fameIds) : Promise.resolve({ data: [] }),
    marketIds.length ? db.from("market_ads").select("id, headline, media, days_active, library_url, market_brands(name)").in("id", marketIds) : Promise.resolve({ data: [] }),
  ]);
  const out = new Map<string, { kind: "fame" | "market"; image: string | null; video: string | null; headline: string | null; result: string; name: string; href: string | null }>();
  for (const r of fame ?? []) {
    const c = r.creative as { headline?: string; image?: string; video?: string } | null;
    const cl = r.clients as unknown as { name: string; slug: string } | null;
    out.set(`fame:${r.ad_id}`, {
      kind: "fame",
      image: c?.image ?? null,
      video: c?.video ?? null,
      headline: c?.headline ?? null,
      result: r.roas ? `${Number(r.value).toFixed(2)}x ROAS vs a ${r.target}x target · ${r.days_live} days` : `$${Number(r.value).toFixed(2)} vs a $${r.target} target per ${String(r.conversion).toLowerCase().replace(/s$/, "")} · ${r.days_live} days`,
      name: cl?.name ?? "",
      href: cl ? `/clients/${cl.slug}` : null,
    });
  }
  for (const r of market ?? []) {
    const media = (r.media ?? []) as { type: string; url: string; thumb: string | null }[];
    const b = r.market_brands as unknown as { name: string } | null;
    out.set(`market:${r.id}`, {
      kind: "market",
      image: media.find((x) => x.type === "image")?.url ?? media[0]?.thumb ?? null,
      video: media.find((x) => x.type === "video")?.url ?? null,
      headline: r.headline,
      result: `Live ${r.days_active} days in the market`,
      name: b?.name ?? "",
      href: r.library_url,
    });
  }
  return out;
}

/** The client's sub-vertical playbook, for the agents: who buys in this market and the angles proven to land. */
export async function playbookBlock(db: SupabaseClient, clientId: string) {
  const { data: c } = await db.from("clients").select("vertical_id, verticals(name)").eq("id", clientId).maybeSingle();
  if (!c?.vertical_id) return "";
  const p = await loadPlaybook(db, c.vertical_id);
  if (!p?.avatars.length) return "";
  const name = (c.verticals as unknown as { name: string } | null)?.name ?? "their sub-vertical";
  const avatars = p.avatars
    .map(
      (a) =>
        `${a.name}: ${a.who}\n  Pains: ${a.pains.join("; ")}\n  Triggers: ${a.triggers.join("; ")}\n  Objections: ${a.objections.join("; ")}\n${a.angles.map((g) => `  Angle "${g.name}" (proven by ${g.examples.length} ad${g.examples.length === 1 ? "" : "s"}): hook "${g.hook}". ${g.why}`).join("\n")}`,
    )
    .join("\n");
  return `<vertical_playbook sub_vertical="${name}" source="our Hall of Fame and the market's ads live 30+ days">
${p.summary}
${avatars}
Watch out: ${p.watchouts.join("; ")}
</vertical_playbook>
Use the playbook as the starting point for this market, then make it this client's: their offer, voice and rules come first.`;
}
