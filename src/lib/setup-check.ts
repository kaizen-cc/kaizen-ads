// What's already in place in an ad account, as facts the audit's plan is checked against: an audit must never
// recommend something that's already set up (a customer list that's already attached, sitelinks that already run, a
// negative keyword list already on every campaign). The snapshots (src/lib/google-setup.ts, src/lib/meta-setup-snapshot.ts)
// read the account and turn it into facts; this checks the plan's actions against them. Pure, so it's tested on its own
// (tests/setup-check.test.ts).

/** One thing that's in place (or not) across the campaigns or ad sets it applies to */
export type SetupFact = {
  key: string;
  /** In words, for the note and the log ("Customer match list") */
  label: string;
  /** Where it applies: enabled campaigns (Google) or active ad sets (Meta); ["the account"] for account settings */
  of: string[];
  /** Where it's in place, a subset of `of` */
  on: string[];
  /** For ad sets: their campaign, so an action naming a campaign is checked on its ad sets */
  parents?: Record<string, string>;
  /** How it's set up, when that matters ("observation on 2, targeting on 1") */
  detail?: string;
  /** What `of` counts, in words ("campaigns", "ad sets") */
  unit?: string;
};

export type SetupFacts = { platform: "google" | "meta"; facts: SetupFact[] };

/** The rule both audit passes follow; the snapshot is in <live_setup> */
export const SETUP_RULE = `Before recommending any setup change (audiences and lists, exclusions, assets and extensions, negative keyword lists, conversion settings, bidding, locations, placements, tracking), check the setup snapshot in <live_setup> first. Never recommend something that's already in place. If it exists but is set up poorly, say exactly what's wrong with it and where, with the numbers ("Customer list attached as observation only on 2 of 5 campaigns", "Sitelinks on the account but none on Search | Brand"), and recommend that fix instead. If the snapshot couldn't read something, say you couldn't confirm it rather than assuming it's missing.`;

type Rule = { key: string; topic: RegExp; intent?: RegExp; block?: RegExp };

// Adding or setting something up (what's dropped when it's already done)
const ADD = /\b(add|adding|attach|layer|apply|upload|set ?up|create|build|use|using|leverage|implement|enable|turn on|start|launch|install|connect|include|introduce|test)\b/i;
// Fixing or changing something that exists (never dropped: that's the "set up poorly" case)
const CHANGE = /\b(switch|change|move|bid adj|adjust|refresh|re-?upload|update|expand|increase|grow|improve|match rate|size|remove|pause|replace|rewrite|fix|from observation|to targeting|to observation|narrow|broaden|split|consolidate|tighten)/i;

const RULES: Rule[] = [
  // Google
  { key: "customer_match", topic: /customer match|customer list|crm (list|audience|data)|first[- ]party (list|data|audience)|customer data list/i },
  { key: "remarketing", topic: /remarketing|retargeting|website visitors?|site visitors?|all visitors/i },
  { key: "in_market", topic: /in[- ]market/i },
  { key: "affinity", topic: /\baffinity\b/i },
  { key: "custom_segments", topic: /custom (segment|audience|intent)/i },
  { key: "sitelinks", topic: /sitelink/i },
  { key: "callouts", topic: /callout/i },
  { key: "snippets", topic: /structured snippet/i },
  { key: "images", topic: /image (asset|extension)/i },
  { key: "lead_form", topic: /lead form (asset|extension)/i },
  { key: "negative_list", topic: /negative (keyword )?lists?|shared negative/i },
  { key: "auto_tagging", topic: /auto-?tagging/i },
  { key: "enhanced_conversions", topic: /enhanced conversions?/i },
  { key: "presence", topic: /\bpresence\b(?! or interest)|people in or regularly in/i, intent: /\b(switch|change|set|use|move)\b/i, block: /^$/ },
  // Meta
  { key: "customer_list", topic: /customer (list|file)|purchaser list|email list|crm (list|audience)/i },
  { key: "lookalike", topic: /lookalike|\blal\b/i },
  { key: "website_audience", topic: /website (custom )?audience|site visitors|retarget|remarketing/i },
  { key: "engagement_audience", topic: /engagement (custom )?audience|engagers|video viewers/i },
  { key: "exclude_customers", topic: /exclud\w* (past |existing |current |recent |all )?(purchasers|customers|buyers)/i, intent: /exclud/i, block: /\b(remove|stop|drop)\b/i },
  { key: "advantage_audience", topic: /advantage\+? audience/i, intent: /\b(turn on|enable|switch (on|to)|use|test|move to)\b/i, block: /\b(off|disable|turn it off|remove)\b/i },
  { key: "advantage_placements", topic: /advantage\+? placements|automatic placements/i, intent: /\b(turn on|enable|switch|use|move|test)\b/i, block: /\b(off|disable|manual)\b/i },
  { key: "capi", topic: /conversions api|\bcapi\b|server[- ]side (events|tracking)/i, intent: /\b(set ?up|implement|install|connect|add|enable|turn on)\b/i, block: /\b(dedup|match quality|emq|fix)\b/i },
];

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export type CheckedAction = { title: string; short?: string; why: string; objects?: { type: string; name: string }[] };
export type SetupCheckLog = { dropped: { title: string; reason: string }[]; noted: { title: string; note: string }[] };

/**
 * The plan checked against what's in place: an action that adds something already in place everywhere it would go is
 * dropped (and logged); one where it's in place in some of those places keeps going, with a note saying where.
 */
export function checkAgainstSetup<A extends CheckedAction>(actions: A[], setup: SetupFacts | null | undefined): { actions: A[]; log: SetupCheckLog } {
  const log: SetupCheckLog = { dropped: [], noted: [] };
  if (!setup?.facts.length) return { actions, log };
  const facts = new Map(setup.facts.map((f) => [f.key, f]));
  const out: A[] = [];
  for (const a of actions) {
    const text = `${a.title} ${a.short ?? ""}`;
    let drop: string | null = null;
    const notes: string[] = [];
    for (const r of RULES) {
      const f = facts.get(r.key);
      if (!f || !f.of.length || !r.topic.test(text)) continue;
      if (!(r.intent ?? ADD).test(text) || (r.block ?? CHANGE).test(text)) continue;
      // The places the action names, when it names any it applies to; otherwise everywhere it applies
      const named = new Set((a.objects ?? []).map((o) => norm(o.name)));
      const scoped = named.size ? f.of.filter((x) => named.has(norm(x)) || (f.parents?.[x] && named.has(norm(f.parents[x])))) : [];
      const scope = scoped.length ? scoped : f.of;
      const on = new Set(f.on);
      const done = scope.filter((x) => on.has(x));
      if (!done.length) continue;
      const where = scope.length === 1 && scope[0] === "the account" ? "on the account" : done.length === scope.length ? `on ${scope.length === 1 ? scope[0] : `all ${scope.length}${f.unit ? ` ${f.unit}` : ""}`}` : `on ${done.length} of ${scope.length}${f.unit ? ` ${f.unit}` : ""}`;
      if (done.length === scope.length) {
        drop = `${f.label} is already in place ${where}${f.detail ? ` (${f.detail})` : ""}`;
        break;
      }
      const missing = scope.filter((x) => !on.has(x));
      notes.push(`${f.label} is already in place ${where} (${done.slice(0, 4).join(", ")}${done.length > 4 ? ", …" : ""}); not on ${missing.slice(0, 4).join(", ")}${missing.length > 4 ? ", …" : ""}${f.detail ? `; ${f.detail}` : ""}`);
    }
    if (drop) {
      log.dropped.push({ title: a.title, reason: drop });
      continue;
    }
    if (notes.length) {
      const note = `Setup check: ${notes.join(". ")}.`;
      log.noted.push({ title: a.title, note });
      out.push({ ...a, why: `${a.why} ${note}`.trim() });
    } else out.push(a);
  }
  return { actions: out, log };
}

/** The facts as coverage lines for the snapshot ("Customer match list: on 2 of 5 (A, B)") */
export function coverageLines(setup: SetupFacts | null | undefined) {
  return (setup?.facts ?? [])
    .filter((f) => f.of.length)
    .map((f) => {
      if (f.of.length === 1 && f.of[0] === "the account") return `- ${f.label}: ${f.on.length ? "yes" : "no"}${f.detail ? ` (${f.detail})` : ""}`;
      const missing = f.of.filter((x) => !f.on.includes(x));
      return `- ${f.label}: on ${f.on.length} of ${f.of.length}${f.on.length && missing.length ? `; missing on ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? ", …" : ""}` : ""}${f.detail ? ` (${f.detail})` : ""}`;
    });
}
