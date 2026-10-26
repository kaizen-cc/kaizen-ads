import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { metaGraph } from "@/lib/context/meta";
import { metaWrite } from "@/lib/meta-write";
import { CTA, ENHANCEMENTS, checkCreative, params, sandboxClient, specFor, suggestGeneralRule, trackingSpecs, update, type LaunchPlan, type Result } from "@/lib/launcher";

// Running a launched ad from Kaizen Ads instead of Ads Manager: what Meta shows for it now (each ad, its ad set and
// campaign, on or paused, in review, refused), turning it on or pausing it, and editing what the launcher decided
// (names, texts, headlines, descriptions, the button, the link and its URL parameters, the Page and Instagram account,
// Advantage+ enhancements, the daily budget). Ad creatives can't be changed in Meta, so an edit makes a new creative
// from the edited plan, has Meta dry-run it, and swaps it into the same ad: the ad keeps its ID and its history.
// The buyer's reason for an edit is learned like a move's (a launch rule for the client, the client's memory).
// Sandbox tests never turn on: they'd spend Kaizen's money on a client's creative.

export type Delivery = {
  ads: { adId: string; designId: string; name: string; status: string; effective: string; issue: string | null }[];
  adset: { id: string; name: string; status: string; effective: string; daily: number | null; lifetime: number | null; pixel: string | null; event: string | null; optimization: string | null } | null;
  campaign: { id: string; name: string; status: string; effective: string; daily: number | null; lifetime: number | null } | null;
  /** Where the daily budget lives: the ad set, the campaign (shared by its ad sets) or a lifetime budget left alone */
  budget: "adset" | "campaign" | "lifetime" | null;
};

const money = (v?: string) => (v && Number(v) > 0 ? Number(v) / 100 : null);

/** What Meta shows for the launch right now. */
export async function delivery(result: Result): Promise<Delivery> {
  const made = result.ads.filter((a) => a.adId);
  type AdRow = { name: string; status: string; effective_status: string; issues_info?: { error_summary?: string; error_message?: string }[]; ad_review_feedback?: { global?: Record<string, string> } };
  type SetRow = { name: string; status: string; effective_status: string; daily_budget?: string; lifetime_budget?: string; optimization_goal?: string; promoted_object?: { pixel_id?: string; custom_event_type?: string }; campaign?: { id: string; name: string; status: string; effective_status: string; daily_budget?: string; lifetime_budget?: string } };
  const [ads, set] = await Promise.all([
    made.length ? metaGraph<Record<string, AdRow>>("", { ids: made.map((a) => a.adId).join(","), fields: "name,status,effective_status,issues_info,ad_review_feedback" }).catch(() => ({}) as Record<string, AdRow>) : Promise.resolve({} as Record<string, AdRow>),
    metaGraph<SetRow>(result.adsetId, { fields: "name,status,effective_status,daily_budget,lifetime_budget,optimization_goal,promoted_object,campaign{id,name,status,effective_status,daily_budget,lifetime_budget}" }).catch(() => null),
  ]);
  const c = set?.campaign;
  return {
    ads: made.map((a) => {
      const r = ads[a.adId!];
      const review = r?.ad_review_feedback?.global ? Object.values(r.ad_review_feedback.global)[0] : null;
      return { adId: a.adId!, designId: a.designId, name: r?.name ?? a.name, status: r?.status ?? "UNKNOWN", effective: r?.effective_status ?? "UNKNOWN", issue: review ?? r?.issues_info?.[0]?.error_message ?? r?.issues_info?.[0]?.error_summary ?? null };
    }),
    adset: set ? { id: result.adsetId, name: set.name, status: set.status, effective: set.effective_status, daily: money(set.daily_budget), lifetime: money(set.lifetime_budget), pixel: set.promoted_object?.pixel_id ?? null, event: set.promoted_object?.custom_event_type ?? null, optimization: set.optimization_goal ?? null } : null,
    campaign: c ? { id: c.id, name: c.name, status: c.status, effective: c.effective_status, daily: money(c.daily_budget), lifetime: money(c.lifetime_budget) } : null,
    budget: c?.daily_budget && Number(c.daily_budget) > 0 ? "campaign" : set?.daily_budget && Number(set.daily_budget) > 0 ? "adset" : set?.lifetime_budget || c?.lifetime_budget ? "lifetime" : null,
  };
}

type Launch = { id: string; client_id: string; request_id: string; status: string; sandbox: boolean; plan: LaunchPlan | null; result: Result | null; edits: unknown[] | null };

async function loadLaunch(admin: SupabaseClient, launchId: string) {
  const { data } = await admin.from("launches").select("id, client_id, request_id, status, sandbox, plan, result, edits").eq("id", launchId).single();
  const l = data as Launch | null;
  if (!l?.plan || !l.result || l.status !== "launched") throw new Error("Only a launched ad can be changed here.");
  return l as Launch & { plan: LaunchPlan; result: Result };
}

/** A note on the ticket, by the person who did it. */
async function note(admin: SupabaseClient, requestId: string, by: string, body: string) {
  await admin.from("request_events").insert({ request_id: requestId, kind: "comment", actor_id: by, body: body.slice(0, 2000) });
}

/**
 * Turns the ads (or their ad set, or its campaign) on or off. Turning the ads on completes the ticket the way Meta
 * showing them on does. The ad set and campaign are separate steps: turning one on also runs every other ad in it.
 */
export async function setDelivery(admin: SupabaseClient, launchId: string, by: string, target: "ads" | "adset" | "campaign", on: boolean) {
  const l = await loadLaunch(admin, launchId);
  if (on && l.sandbox) throw new Error("Sandbox tests stay paused: turning one on would spend Kaizen's money on a client's creative.");
  const status = on ? "ACTIVE" : "PAUSED";
  const now = await delivery(l.result);
  const ids = target === "ads" ? now.ads.map((a) => a.adId) : target === "adset" ? [l.result.adsetId] : now.campaign ? [now.campaign.id] : [];
  if (!ids.length) throw new Error("Nothing to change.");
  for (const id of ids) await metaWrite(admin, l.plan.account, id, { status }, false);
  const what = target === "ads" ? (ids.length === 1 ? "the ad" : `the ${ids.length} ads`) : target === "adset" ? `the ad set "${now.adset?.name}"` : `the campaign "${now.campaign?.name}"`;
  await note(admin, l.request_id, by, `${on ? "Turned on" : "Paused"} ${what} in Meta from Kaizen Ads.`);
  if (on && target === "ads") {
    await admin.from("launches").update({ live_at: new Date().toISOString() }).eq("id", launchId).is("live_at", null);
    const { data: t } = await admin.from("requests").select("stage").eq("id", l.request_id).single();
    if (t?.stage === "ready_for_launch") await admin.rpc("system_move_request", { p_request: l.request_id, p_stage: "launched", p_note: `Turned on in Meta from Kaizen Ads: ${now.ads.map((a) => a.name).join("; ")}`.slice(0, 1000) });
  }
  return delivery(l.result);
}

export type AdEdit = {
  names?: Record<string, string>;
  copy?: { bodies: string[]; titles: string[]; descriptions: string[] };
  cta?: string;
  link?: string;
  urlTags?: string | null;
  pageId?: string;
  igId?: string | null;
  /** Advantage+ enhancements switched off */
  optOut?: string[];
  /** Instant-form ads: the form they open */
  leadFormId?: string;
  /** The dataset the ads report website events to (null: Meta's default) */
  trackingPixel?: string | null;
  /** Dollars a day, set where the budget lives */
  dailyBudget?: number | null;
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const clean = (xs: string[]) => xs.map((x) => x.trim()).filter(Boolean).slice(0, 5);

/**
 * Applies a buyer's edit to the launched ads. Everything is dry-run with Meta first, so a refusal changes nothing; then
 * new creatives go into the same ads, names and the budget are set, and the edit is recorded on the launch and the
 * ticket. A reason, when given, becomes a launch rule and a line in the client's memory.
 */
export async function editLaunch(admin: SupabaseClient, launchId: string, by: string, edit: AdEdit, reason: string) {
  const l = await loadLaunch(admin, launchId);
  const plan = l.plan;
  const next: LaunchPlan = JSON.parse(JSON.stringify(plan));
  next.known = plan.known ?? [...plan.optOut];
  const changes: string[] = [];

  if (edit.copy) {
    const copy = { bodies: clean(edit.copy.bodies), titles: clean(edit.copy.titles), descriptions: clean(edit.copy.descriptions) };
    if (!copy.bodies.length) throw new Error("Keep at least one primary text.");
    if (!copy.titles.length) throw new Error("Keep at least one headline.");
    if (!same(copy.bodies, plan.copy.bodies)) changes.push("primary texts");
    if (!same(copy.titles, plan.copy.titles)) changes.push("headlines");
    if (!same(copy.descriptions, plan.copy.descriptions)) changes.push("descriptions");
    next.copy = copy;
  }
  if (edit.cta !== undefined && edit.cta !== plan.cta) {
    if (!Object.values(CTA).includes(edit.cta)) throw new Error("That button isn't one Meta offers.");
    next.cta = edit.cta;
    changes.push(`button → ${edit.cta.replace(/_/g, " ").toLowerCase()}`);
  }
  if (edit.link !== undefined && edit.link.trim() !== (plan.link ?? "")) {
    if (!/^https?:\/\/\S+\.\S+/.test(edit.link.trim())) throw new Error("The link needs to be a full web address (https://…).");
    next.link = edit.link.trim();
    changes.push("link");
  }
  if (edit.urlTags !== undefined && (edit.urlTags?.trim() || null) !== (plan.urlTags ?? null)) {
    next.urlTags = edit.urlTags?.trim().replace(/^\?/, "") || null;
    changes.push("URL parameters");
  }
  if (edit.pageId !== undefined && edit.pageId !== plan.pageId) {
    next.pageId = edit.pageId;
    changes.push("Facebook Page");
  }
  if (edit.igId !== undefined && edit.igId !== plan.igId) {
    next.igId = edit.igId;
    changes.push("Instagram account");
  }
  if (edit.leadFormId && edit.leadFormId !== plan.leadFormId) {
    if (!plan.leadFormId) throw new Error("These ads don't open an instant form.");
    next.leadFormId = edit.leadFormId;
    changes.push(`instant form → ${plan.options.leadForms?.find((f) => f.id === edit.leadFormId)?.name ?? edit.leadFormId}`);
  }
  if (edit.optOut !== undefined) {
    const off = ENHANCEMENTS.filter((f) => edit.optOut!.includes(f) && next.known!.includes(f));
    if (!same([...off].sort(), [...plan.optOut].sort())) {
      next.optOut = off;
      changes.push("Advantage+ enhancements");
    }
  }
  const tracking = edit.trackingPixel !== undefined && (edit.trackingPixel || null) !== (plan.trackingPixel ?? null);
  if (tracking && !edit.trackingPixel) throw new Error("Pick a dataset: an ad's tracking can be switched to another one, not cleared.");
  if (tracking) {
    next.trackingPixel = edit.trackingPixel || null;
    changes.push(next.trackingPixel ? `website events → ${plan.options.pixels?.find((x) => x.id === next.trackingPixel)?.name ?? next.trackingPixel}` : "website events → Meta's default");
  }
  const creative = !same({ c: next.copy, a: next.cta, l: next.link, u: next.urlTags, p: next.pageId, i: next.igId, o: next.optOut, f: next.leadFormId ?? null }, { c: plan.copy, a: plan.cta, l: plan.link, u: plan.urlTags, p: plan.pageId, i: plan.igId, o: plan.optOut, f: plan.leadFormId ?? null });

  const result: Result = JSON.parse(JSON.stringify(l.result));
  const renames = Object.entries(edit.names ?? {}).filter(([d, n]) => n.trim() && result.ads.find((a) => a.designId === d && a.adId && a.name !== n.trim()));
  if (renames.length) changes.push(renames.length === 1 ? "ad name" : "ad names");

  // The budget: where it lives now
  let budgetTarget: string | null = null;
  if (edit.dailyBudget != null) {
    const now = await delivery(result);
    if (!(edit.dailyBudget > 0)) throw new Error("The daily budget has to be more than $0.");
    if (now.budget === "lifetime") throw new Error("This ad set runs on a lifetime budget; change it in Ads Manager.");
    const current = now.budget === "campaign" ? now.campaign?.daily : now.adset?.daily;
    if (current !== edit.dailyBudget) {
      budgetTarget = now.budget === "campaign" ? now.campaign!.id : result.adsetId;
      changes.push(`daily budget → $${edit.dailyBudget}${now.budget === "campaign" ? " on the campaign" : ""}`);
    }
  }
  if (!changes.length) throw new Error("Nothing changed.");

  // Check every new creative with Meta first: a refusal changes nothing
  const made = result.ads.filter((a) => a.adId);
  const named = (designId: string, fallback: string) => (edit.names?.[designId]?.trim() || fallback).slice(0, 250);
  if (tracking && next.trackingPixel)
    for (const m of made) {
      try {
        await metaWrite(admin, plan.account, m.adId!, { tracking_specs: trackingSpecs(next.trackingPixel) }, true);
      } catch (e) {
        throw new Error(`Meta wouldn't take that dataset for ${m.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  if (creative) {
    for (const m of made) {
      const ad = next.ads.find((a) => a.designId === m.designId);
      if (!ad) throw new Error(`Couldn't find the files for ${m.name}.`);
      const err = await checkCreative(admin, next, { ...ad, name: named(m.designId, m.name) }, next.structure ?? "single");
      if (err) throw new Error(`Meta wouldn't take the change for ${m.name}: ${err}`);
    }
  }

  for (const m of made) {
    const name = named(m.designId, m.name);
    const patch: Record<string, string> = {};
    if (name !== m.name) patch.name = name;
    if (creative) {
      const ad = next.ads.find((a) => a.designId === m.designId)!;
      const c = await metaWrite<{ id: string }>(admin, plan.account, `act_${plan.account}/adcreatives`, params(specFor(next, { ...ad, name }, next.structure ?? "single")), false);
      patch.creative = JSON.stringify({ creative_id: c.id });
      m.creativeId = c.id;
    }
    if (tracking && next.trackingPixel) patch.tracking_specs = trackingSpecs(next.trackingPixel);
    if (Object.keys(patch).length) await metaWrite(admin, plan.account, m.adId!, patch, false);
    m.name = name;
    const pa = next.ads.find((a) => a.designId === m.designId);
    if (pa) pa.name = name;
  }
  if (budgetTarget) await metaWrite(admin, plan.account, budgetTarget, { daily_budget: String(Math.round(edit.dailyBudget! * 100)) }, false);

  const why = reason.trim().slice(0, 600);
  await update(admin, launchId, { plan: next, result, edits: [...(l.edits ?? []), { at: new Date().toISOString(), by, changes, reason: why || null }] });
  await note(admin, l.request_id, by, `Edited the launched ${made.length === 1 ? "ad" : "ads"} from Kaizen Ads: ${changes.join(", ")}.${why ? ` Why: ${why}` : ""}`);

  // The reason is learned: the launcher reads it first for this client, every agent sees it in the client's memory
  if (why) {
    const client = l.sandbox ? await sandboxClient(admin, l.client_id) : l.client_id;
    await admin.from("launch_rules").insert({ client_id: client, launch_id: launchId, rule: why, via: "edit", created_by: by });
    await admin.from("client_memory").insert({ client_id: client, kind: "prefer", source: "team", created_by: by, body: `Launch settings: ${why} (a buyer changed the ${changes.join(", ")} after launch).`.slice(0, 1000) });
    await suggestGeneralRule(admin).catch((e) => console.error("launch rules pattern", e));
  }
  return { changes };
}
