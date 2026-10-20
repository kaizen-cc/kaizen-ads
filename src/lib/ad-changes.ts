import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import type { Staff } from "@/lib/auth";
import { googleMutate, googleWritableSetup, type WritableSetup } from "@/lib/context/google-ads";

// Changes made to a Google Ads account from Kaizen Ads. An audit action or a sprint move is turned into specific
// changes by the Google Buyer (from the account's live setup), each one checked with Google without being applied,
// then applied only when someone allowed confirms. The "from" side of every change is read from Google, never written
// by the AI. Supported: pausing or enabling a campaign or ad group, a campaign's daily budget, target CPA, target
// ROAS, and negative keywords. Everything else stays a manual step.

export type ChangeOp =
  | { kind: "campaign_status"; campaignId: string; campaign: string; from: string; to: "PAUSED" | "ENABLED" }
  | { kind: "ad_group_status"; adGroupId: string; adGroup: string; campaign: string; from: string; to: "PAUSED" | "ENABLED" }
  | { kind: "campaign_budget"; campaignId: string; campaign: string; budgetResource: string; from: number | null; to: number }
  | { kind: "target_cpa"; campaignId: string; campaign: string; bidding: string; from: number | null; to: number }
  | { kind: "target_roas"; campaignId: string; campaign: string; bidding: string; from: number | null; to: number }
  | { kind: "negative_keywords"; campaignId: string; campaign: string; keywords: { text: string; match: "EXACT" | "PHRASE" | "BROAD" }[] };

/** Each change with what Google said when it was checked, and what happened when it was applied. */
export type PlannedOp = ChangeOp & { why: string; warning: string | null; check: { ok: boolean; error: string | null } | null; result: { ok: boolean; error: string | null } | null };

/** Who can apply a change: execs, the Head of Google, and the account's own buyer. */
export function canApply(me: Staff, ownerId: string | null) {
  return me.isExec || me.role === "head_of_google" || (ownerId != null && ownerId === me.id);
}

const S = { type: "string" };
const N = { type: "number" };
const PLAN_SCHEMA = {
  type: "object",
  properties: {
    note: S,
    ops: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["campaign_status", "ad_group_status", "campaign_budget", "target_cpa", "target_roas", "negative_keywords"] },
          id: S,
          status: { type: "string", enum: ["PAUSED", "ENABLED", ""] },
          amount: N,
          keywords: { type: "array", items: { type: "object", properties: { text: S, match: { type: "string", enum: ["EXACT", "PHRASE", "BROAD"] } }, required: ["text", "match"], additionalProperties: false } },
          why: S,
        },
        required: ["kind", "id", "status", "amount", "keywords", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["note", "ops"],
  additionalProperties: false,
};

const PLAN_SYSTEM = `You turn one action from a Google Ads account's optimization plan into the exact changes to make in the account through the Google Ads API. You're given the action and the account's live setup with IDs.
Only these changes exist: campaign_status (pause or enable a campaign: id = campaign ID, status), ad_group_status (pause or enable an ad group: id = ad group ID, status), campaign_budget (a campaign's daily budget in dollars: id = campaign ID, amount), target_cpa (in dollars: id = campaign ID, amount), target_roas (as a ratio, 4 means 400%: id = campaign ID, amount), negative_keywords (add negatives to a campaign: id = campaign ID, keywords with match type; prefer EXACT or PHRASE). Leave unused fields empty: status "", amount 0, keywords [].
Make only what the action actually asks for, with the amounts it names or clearly implies; never invent a change the action doesn't call for. When the action names a campaign or ad group loosely, match it to the setup by name; when it's ambiguous, make nothing and say so. A target CPA only on a campaign bidding with Target CPA or Maximize conversions; a target ROAS only on Target ROAS or Maximize conversion value; never on a campaign using a portfolio strategy or a shared budget (for budgets). Negative keywords only from search terms the action points at (the wasted search terms are listed).
If nothing in the action can be done with these changes (creative, landing pages, tracking, a new campaign, anything else), return no ops and say in note, in one plain sentence, what has to be done by hand. Otherwise note is one sentence on what the changes do together. why: a few words per change.`;

function setupText(s: WritableSetup) {
  return [
    "CAMPAIGNS",
    ...s.campaigns.map((c) => `- id ${c.id} "${c.name}" [${c.status}, ${c.type}] bidding ${c.bidding}${c.portfolio ? " (portfolio strategy)" : ""}${c.targetCpa != null ? `, target CPA $${c.targetCpa}` : ""}${c.targetRoas != null ? `, target ROAS ${c.targetRoas}` : ""}, daily budget ${c.budget != null ? `$${c.budget}` : "?"}${c.sharedBudget ? " (shared budget)" : ""}`),
    "\nAD GROUPS",
    ...s.adGroups.slice(0, 150).map((g) => `- id ${g.id} "${g.name}" [${g.status}] in "${g.campaign}"`),
    "\nSEARCH TERMS SPENDING WITH NO CONVERSIONS (last 30 days)",
    ...s.wasteTerms.map((t) => `- "${t.term}" in "${t.campaign}" (campaign ${t.campaignId}): $${t.spend}, ${t.clicks} clicks`),
  ].join("\n");
}

const money = (n: number | null) => (n == null ? "not set" : `$${n.toFixed(2)}`);
const pctChange = (from: number | null, to: number) => (from ? Math.round(((to - from) / from) * 100) : null);

/** The AI's picks, made real against the live setup: unknown IDs dropped, "from" values read from Google, big moves flagged. */
function build(raw: { kind: string; id: string; status: string; amount: number; keywords: { text: string; match: "EXACT" | "PHRASE" | "BROAD" }[]; why: string }[], s: WritableSetup): { ops: PlannedOp[]; dropped: string[] } {
  const ops: PlannedOp[] = [];
  const dropped: string[] = [];
  const base = { check: null, result: null };
  for (const r of raw) {
    const c = s.campaigns.find((x) => x.id === r.id);
    if (r.kind === "ad_group_status") {
      const g = s.adGroups.find((x) => x.id === r.id);
      if (!g || !["PAUSED", "ENABLED"].includes(r.status) || g.status === r.status) {
        dropped.push(`ad group ${r.id}`);
        continue;
      }
      ops.push({ kind: "ad_group_status", adGroupId: g.id, adGroup: g.name, campaign: g.campaign, from: g.status, to: r.status as "PAUSED" | "ENABLED", why: r.why, warning: null, ...base });
      continue;
    }
    if (!c) {
      dropped.push(`campaign ${r.id}`);
      continue;
    }
    if (r.kind === "campaign_status") {
      if (!["PAUSED", "ENABLED"].includes(r.status) || c.status === r.status) continue;
      ops.push({ kind: "campaign_status", campaignId: c.id, campaign: c.name, from: c.status, to: r.status as "PAUSED" | "ENABLED", why: r.why, warning: null, ...base });
    } else if (r.kind === "campaign_budget") {
      if (!(r.amount > 0) || !c.budgetResource) continue;
      const p = pctChange(c.budget, r.amount);
      const warning = c.sharedBudget ? "This budget is shared with other campaigns: they change too." : p != null && Math.abs(p) > 50 ? `A ${p > 0 ? "+" : ""}${p}% jump: big budget moves can reset learning.` : null;
      ops.push({ kind: "campaign_budget", campaignId: c.id, campaign: c.name, budgetResource: c.budgetResource, from: c.budget, to: Math.round(r.amount * 100) / 100, why: r.why, warning, ...base });
    } else if (r.kind === "target_cpa") {
      if (!(r.amount > 0) || c.portfolio || !["TARGET_CPA", "MAXIMIZE_CONVERSIONS"].includes(c.bidding)) {
        dropped.push(`target CPA on "${c.name}" (bidding ${c.bidding}${c.portfolio ? ", portfolio" : ""})`);
        continue;
      }
      const p = pctChange(c.targetCpa, r.amount);
      ops.push({ kind: "target_cpa", campaignId: c.id, campaign: c.name, bidding: c.bidding, from: c.targetCpa, to: Math.round(r.amount * 100) / 100, why: r.why, warning: p != null && Math.abs(p) > 25 ? `A ${p > 0 ? "+" : ""}${p}% change to the target: Google suggests moving it 15–20% at a time.` : null, ...base });
    } else if (r.kind === "target_roas") {
      if (!(r.amount > 0) || c.portfolio || !["TARGET_ROAS", "MAXIMIZE_CONVERSION_VALUE"].includes(c.bidding)) {
        dropped.push(`target ROAS on "${c.name}" (bidding ${c.bidding}${c.portfolio ? ", portfolio" : ""})`);
        continue;
      }
      const p = pctChange(c.targetRoas, r.amount);
      ops.push({ kind: "target_roas", campaignId: c.id, campaign: c.name, bidding: c.bidding, from: c.targetRoas, to: Math.round(r.amount * 100) / 100, why: r.why, warning: p != null && Math.abs(p) > 25 ? `A ${p > 0 ? "+" : ""}${p}% change to the target: Google suggests moving it 15–20% at a time.` : null, ...base });
    } else if (r.kind === "negative_keywords") {
      const keywords = r.keywords.map((k) => ({ text: k.text.trim().toLowerCase().slice(0, 80), match: k.match })).filter((k) => k.text).slice(0, 25);
      if (keywords.length) ops.push({ kind: "negative_keywords", campaignId: c.id, campaign: c.name, keywords, why: r.why, warning: null, ...base });
    }
  }
  return { ops, dropped };
}

/** One change as Google's API operation. */
function operation(account: string, op: ChangeOp): { service: "campaigns" | "campaignBudgets" | "adGroups" | "campaignCriteria"; ops: unknown[] } {
  const cust = `customers/${account}`;
  const micros = (n: number) => String(Math.round(n * 1_000_000));
  switch (op.kind) {
    case "campaign_status":
      return { service: "campaigns", ops: [{ update: { resourceName: `${cust}/campaigns/${op.campaignId}`, status: op.to }, updateMask: "status" }] };
    case "ad_group_status":
      return { service: "adGroups", ops: [{ update: { resourceName: `${cust}/adGroups/${op.adGroupId}`, status: op.to }, updateMask: "status" }] };
    case "campaign_budget":
      return { service: "campaignBudgets", ops: [{ update: { resourceName: op.budgetResource, amountMicros: micros(op.to) }, updateMask: "amount_micros" }] };
    case "target_cpa":
      return op.bidding === "TARGET_CPA"
        ? { service: "campaigns", ops: [{ update: { resourceName: `${cust}/campaigns/${op.campaignId}`, targetCpa: { targetCpaMicros: micros(op.to) } }, updateMask: "target_cpa.target_cpa_micros" }] }
        : { service: "campaigns", ops: [{ update: { resourceName: `${cust}/campaigns/${op.campaignId}`, maximizeConversions: { targetCpaMicros: micros(op.to) } }, updateMask: "maximize_conversions.target_cpa_micros" }] };
    case "target_roas":
      return op.bidding === "TARGET_ROAS"
        ? { service: "campaigns", ops: [{ update: { resourceName: `${cust}/campaigns/${op.campaignId}`, targetRoas: { targetRoas: op.to } }, updateMask: "target_roas.target_roas" }] }
        : { service: "campaigns", ops: [{ update: { resourceName: `${cust}/campaigns/${op.campaignId}`, maximizeConversionValue: { targetRoas: op.to } }, updateMask: "maximize_conversion_value.target_roas" }] };
    case "negative_keywords":
      return { service: "campaignCriteria", ops: op.keywords.map((k) => ({ create: { campaign: `${cust}/campaigns/${op.campaignId}`, negative: true, keyword: { text: k.text, matchType: k.match } } })) };
  }
}

/** What a change does, in a line: "Daily budget of "Brand" $50.00 → $75.00". */
export function describeOp(op: ChangeOp): string {
  switch (op.kind) {
    case "campaign_status":
      return `${op.to === "PAUSED" ? "Pause" : "Turn on"} campaign "${op.campaign}"`;
    case "ad_group_status":
      return `${op.to === "PAUSED" ? "Pause" : "Turn on"} ad group "${op.adGroup}" (${op.campaign})`;
    case "campaign_budget":
      return `Daily budget of "${op.campaign}": ${money(op.from)} → ${money(op.to)}`;
    case "target_cpa":
      return `Target CPA of "${op.campaign}": ${money(op.from)} → ${money(op.to)}`;
    case "target_roas":
      return `Target ROAS of "${op.campaign}": ${op.from == null ? "not set" : `${Math.round(op.from * 100)}%`} → ${Math.round(op.to * 100)}%`;
    case "negative_keywords":
      return `Add ${op.keywords.length} negative keyword${op.keywords.length === 1 ? "" : "s"} to "${op.campaign}": ${op.keywords.map((k) => (k.match === "EXACT" ? `[${k.text}]` : k.match === "PHRASE" ? `"${k.text}"` : k.text)).join(", ")}`;
  }
}

/** Checks each change with Google without applying it. */
async function check(account: string, ops: PlannedOp[]): Promise<PlannedOp[]> {
  const out: PlannedOp[] = [];
  for (const op of ops) {
    const o = operation(account, op);
    try {
      await googleMutate(account, o.service, o.ops, true);
      out.push({ ...op, check: { ok: true, error: null } });
    } catch (e) {
      out.push({ ...op, check: { ok: false, error: e instanceof Error ? e.message : String(e) } });
    }
  }
  return out;
}

type Source = { title: string; steps: string[]; why: string };

/** Plans the change for an action (in the background of the request that asked): reads the account, asks the Google Buyer, checks it. */
export async function planChange(admin: SupabaseClient, changeId: string, source: Source) {
  const { data: ch } = await admin.from("ad_changes").select("account").eq("id", changeId).single();
  if (!ch) return;
  try {
    const setup = await googleWritableSetup(ch.account);
    const out = await askJson<{ note: string; ops: Parameters<typeof build>[0] }>({
      agent: "google_launcher",
      label: "plan a Google Ads change",
      system: PLAN_SYSTEM,
      schema: PLAN_SCHEMA,
      maxTokens: 6000,
      prompt: `<action>\n${source.title}\nSteps:\n${source.steps.map((s) => `- ${s}`).join("\n")}\nWhy: ${source.why}\n</action>\n\n<account_setup>\n${setupText(setup)}\n</account_setup>`,
    });
    const { ops, dropped } = build(out.ops, setup);
    const checked = await check(ch.account, ops);
    const note = [out.note, dropped.length ? `Left out (can't be done this way): ${dropped.join("; ")}.` : ""].filter(Boolean).join(" ");
    await admin
      .from("ad_changes")
      .update({ status: checked.length ? "ready" : "nothing", ops: checked, note, error: null, updated_at: new Date().toISOString() })
      .eq("id", changeId);
  } catch (e) {
    await admin.from("ad_changes").update({ status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 400), updated_at: new Date().toISOString() }).eq("id", changeId);
  }
}

/**
 * Applies the planned changes (the ones that passed the check, or the ones picked), in order, each on its own so one
 * refusal doesn't stop the rest. The sprint move it came from gets a note and moves to done or doing.
 */
export async function applyChange(admin: SupabaseClient, changeId: string, me: Staff, pick?: number[]) {
  const { data: ch } = await admin.from("ad_changes").select("account, ops, sprint_action_id, status").eq("id", changeId).single();
  if (!ch || !["ready", "partial", "failed"].includes(ch.status)) throw new Error("Nothing to apply.");
  await admin.from("ad_changes").update({ status: "applying", updated_at: new Date().toISOString() }).eq("id", changeId);
  const ops = (ch.ops ?? []) as PlannedOp[];
  const out: PlannedOp[] = [];
  for (const [i, op] of ops.entries()) {
    if (op.result?.ok || (pick && !pick.includes(i)) || op.check?.ok === false) {
      out.push(op);
      continue;
    }
    const o = operation(ch.account, op);
    try {
      await googleMutate(ch.account, o.service, o.ops, false);
      out.push({ ...op, result: { ok: true, error: null } });
    } catch (e) {
      out.push({ ...op, result: { ok: false, error: e instanceof Error ? e.message : String(e) } });
    }
  }
  const tried = out.filter((o) => o.result);
  const ok = tried.filter((o) => o.result?.ok);
  const status = ok.length && ok.length === tried.length ? "applied" : ok.length ? "partial" : "failed";
  const now = new Date().toISOString();
  await admin
    .from("ad_changes")
    .update({ status, ops: out, applied_by: me.id, applied_at: now, error: status === "failed" ? (tried.find((o) => o.result?.error)?.result?.error ?? "Google refused the change").slice(0, 400) : null, updated_at: now })
    .eq("id", changeId);
  if (ch.sprint_action_id && ok.length) {
    const note = `Applied in Google Ads by ${me.fullName}: ${ok.map((o) => describeOp(o)).join("; ")}`.slice(0, 1500);
    await admin.from("sprint_actions").update({ status: status === "applied" ? "done" : "doing", note, ...(status === "applied" ? { done_at: now, done_by: me.id } : {}) }).eq("id", ch.sprint_action_id);
  }
  return status;
}
